import assert from "node:assert/strict";
import { test } from "node:test";
import { completeGoogleAuthorization, createHttpClient, createTestApp } from "./helpers/worker.mjs";

test("the bundled issuer creates distinct verified Google identities without an empty-email account", async () => {
  const app = await createTestApp();
  try {
    for (const profile of [
      { sub: "google-person-a", email: "person-a@example.test", email_verified: true },
      { sub: "google-person-b", email: "person-b@example.test", email_verified: true },
    ]) {
      const response = await completeGoogleAuthorization(app, createHttpClient(app.runtime), profile);
      assert.equal(response.status, 302);
      assert.ok(new URL(response.headers.get("location")).searchParams.get("code"));
    }
    const { results } = await app.db.prepare("SELECT email FROM user ORDER BY email").all();
    assert.deepEqual(results, [{ email: "person-a@example.test" }, { email: "person-b@example.test" }]);
    app.fetchMock.assertNoPendingInterceptors();
  } finally { await app.dispose(); }
});

test("the bundled issuer refuses unverified Google email and disables password routes", async () => {
  const app = await createTestApp();
  try {
    const client = createHttpClient(app.runtime);
    const response = await completeGoogleAuthorization(app, client, {
      sub: "unverified", email: "unverified@example.test", email_verified: false,
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("location"), null);
    assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM user").first("count"), 0);
    assert.equal((await client.fetch("/password/authorize")).status, 404);
    app.fetchMock.assertNoPendingInterceptors();
  } finally { await app.dispose(); }
});
