import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestApp, createHttpClient, ORIGIN } from "./helpers/worker.mjs";

function assertPrivate(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
}

test("security headers cover issuer routes and rejected browser requests", async () => {
  const app = await createTestApp();
  try {
    const client = createHttpClient(app.runtime);
    for (const route of ["/login", "/api/profile", "/callback?code=private-sentinel&state=private-state", "/.well-known/jwks.json", "/missing"]) {
      const response = await client.fetch(route);
      assertPrivate(response);
      assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
      const body = await response.text();
      assert.ok(!body.includes("private-sentinel") && !body.includes("private-state"));
    }
    const failure = await client.fetch("/login", { headers: { Origin: "https://attacker.test" } });
    assert.equal(failure.status, 403);
    assertPrivate(failure);
  } finally { await app.dispose(); }
});

test("unexpected database failures return a generic response with security headers", async () => {
  const app = await createTestApp();
  try {
    await app.db.prepare("DROP TABLE login_transactions").run();
    const response = await createHttpClient(app.runtime).fetch("/login");
    assert.equal(response.status, 500);
    assertPrivate(response);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["error", "requestId"]);
    assert.equal(body.error, "request_failed");
    assert.match(body.requestId, /^[a-f0-9-]{36}$/);
  } finally { await app.dispose(); }
});

test("loopback HTTP uses separate local cookies and canonical callback URLs", async () => {
  const origin = "http://localhost:8787";
  const app = await createTestApp({ origin });
  try {
    const login = await app.runtime.dispatchFetch(`${origin}/login`, { redirect: "manual" });
    assert.equal(login.status, 302);
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie, /^local-openauth-login=[A-Za-z0-9_-]{43};/);
    assert.match(cookie, /; HttpOnly;/);
    assert.match(cookie, /; SameSite=Lax;/);
    assert.doesNotMatch(cookie, /Secure|__Host-|Domain=/i);
    assert.equal(new URL(login.headers.get("location")).searchParams.get("redirect_uri"), `${origin}/callback`);
    assert.equal(login.headers.get("strict-transport-security"), null);
    assertPrivate(login);
  } finally { await app.dispose(); }
});
