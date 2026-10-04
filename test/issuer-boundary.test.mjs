import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizationPath, createHttpClient, createTestApp, ORIGIN } from "./helpers/worker.mjs";

test("the bundled issuer rejects unregistered clients and PKCE downgrade before redirecting", async () => {
  const app = await createTestApp();
  try {
    const client = createHttpClient(app.runtime);
    for (const [key, value] of [["client_id", "unknown"], ["code_challenge_method", "plain"], ["redirect_uri", "https://attacker.test/callback"]]) {
      const url = new URL(authorizationPath(), ORIGIN);
      url.searchParams.set(key, value);
      const response = await client.fetch(url);
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("location"), null);
      assert.equal(response.headers.get("set-cookie"), null);
    }
  } finally { await app.dispose(); }
});

test("spoofed forwarding headers cannot alter bundled discovery or Google's callback", async () => {
  const app = await createTestApp();
  try {
    const client = createHttpClient(app.runtime);
    const headers = { "x-forwarded-host": "attacker.test", "x-forwarded-proto": "http", "x-forwarded-port": "1234" };
    const discovery = await client.fetch("/.well-known/oauth-authorization-server", { headers });
    assert.equal(discovery.status, 200);
    const metadata = await discovery.json();
    assert.equal(metadata.issuer, ORIGIN);
    assert.equal(metadata.token_endpoint, `${ORIGIN}/token`);
    const provider = await client.fetch("/google/authorize", { headers });
    const location = new URL(provider.headers.get("location"));
    assert.equal(location.searchParams.get("redirect_uri"), `${ORIGIN}/google/callback`);
  } finally { await app.dispose(); }
});

test("encoded authorization paths cannot bypass PKCE checks in the bundled router", async () => {
  const app = await createTestApp();
  try {
    const client = createHttpClient(app.runtime);
    for (const path of ["/%61uthorize", "/authoriz%65"]) {
      for (const responseType of ["code", "token"]) {
        const url = new URL(authorizationPath(), ORIGIN);
        url.pathname = path;
        url.searchParams.set("response_type", responseType);
        url.searchParams.delete("code_challenge");
        url.searchParams.delete("code_challenge_method");
        const response = await client.fetch(url);
        assert.equal(response.status, 400, `${path}: ${responseType}`);
        assert.equal(response.headers.get("location"), null);
        assert.equal(response.headers.get("set-cookie"), null);
      }
    }
  } finally { await app.dispose(); }
});
