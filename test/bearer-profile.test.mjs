import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { generateKeyPair, importPKCS8, SignJWT } from "jose";
import { CLIENT_ID, ORIGIN, VERIFIER, completeGoogleAuthorization, createHttpClient, createTestApp } from "./helpers/worker.mjs";

const alice = { sub: "bearer-alice", email: "bearer-alice@example.test", email_verified: true, given_name: "Alice", family_name: "Example" };
const bob = { sub: "bearer-bob", email: "bearer-bob@example.test", email_verified: true, given_name: "Bob", family_name: "Other" };
let app;
let first;
let issuerKey;
let privateKey;

before(async () => { app = await createTestApp(); });
beforeEach(async () => {
  await app.db.batch([app.db.prepare("DELETE FROM user"), app.db.prepare("DELETE FROM login_transactions")]);
  first = await issueTokens(alice);
  issuerKey = JSON.parse(await app.db.prepare("SELECT value FROM issuer_keys WHERE purpose = ?").bind("signing:key").first("value"));
  privateKey = await importPKCS8(issuerKey.privateKey, "ES256");
});
afterEach(() => { app.fetchMock.assertNoPendingInterceptors(); });
after(async () => { await app?.dispose(); });

async function issueTokens(profile) {
  const client = createHttpClient(app.runtime);
  const authorization = await completeGoogleAuthorization(app, client, profile);
  assert.equal(authorization.status, 302);
  const callback = new URL(authorization.headers.get("location"));
  const response = await client.fetch("/token", {
    method: "POST", body: new URLSearchParams({
      grant_type: "authorization_code", code: callback.searchParams.get("code"),
      client_id: CLIENT_ID, redirect_uri: `${ORIGIN}/callback`, code_verifier: VERIFIER,
    }),
  });
  assert.equal(response.status, 200, "the real OpenAuth code exchange succeeds before testing bearer access");
  const tokens = await response.json();
  assert.equal(typeof tokens.access_token, "string");
  assert.equal(typeof tokens.refresh_token, "string");
  const user = await app.db.prepare("SELECT id, email, first_name AS firstName, last_name AS lastName, role, created_at AS createdAt FROM user WHERE email = ?")
    .bind(profile.email).first();
  return { client, tokens, user };
}

function requestUserInfo(token = first.tokens.access_token, init = {}, path = "/userinfo") {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization") && token !== null) headers.set("Authorization", `Bearer ${token}`);
  return app.runtime.dispatchFetch(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" });
}

async function assertUnauthorized(response) {
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("WWW-Authenticate"), "Bearer");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { error: "unauthorized" });
}

function claims(overrides = {}) {
  return {
    iss: ORIGIN, aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300,
    sub: "user:issuer-subject-is-not-the-database-id", mode: "access", type: "user",
    properties: { id: first.user.id }, ...overrides,
  };
}

// Test-only signing with the isolated issuer's actual D1 key; no Worker bypass exists.
function sign(payload = claims(), key = privateKey, header = {}) {
  return new SignJWT(payload).setProtectedHeader({ alg: "ES256", kid: issuerKey.id, ...header }).sign(key);
}

test("real OpenAuth access tokens return only each account's allowed profile fields", async () => {
  const second = await issueTokens(bob);
  assert.notEqual(first.user.id, second.user.id);
  for (const account of [first, second]) {
    const response = await requestUserInfo(account.tokens.access_token);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = await response.json();
    assert.deepEqual(body, { user: account.user });
    assert.deepEqual(Object.keys(body.user).sort(), ["createdAt", "email", "firstName", "id", "lastName", "role"]);
    assert.equal(response.headers.get("Set-Cookie"), null);
  }
});

test("bearer scheme is case-insensitive while the token stays exact", async () => {
  for (const scheme of ["bearer", "BEARER", "bEaReR"]) {
    const response = await requestUserInfo(null, { headers: { Authorization: `${scheme} ${first.tokens.access_token}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user: first.user });
  }
});

test("the verified properties ID chooses the account and names and role come from current D1", async () => {
  const second = await issueTokens(bob);
  const token = await sign(claims({
    sub: second.user.id, role: "admin", email: "forged@example.test",
    properties: { id: first.user.id, role: "admin", firstName: "Forged", email: "forged@example.test" },
  }));
  const initial = await requestUserInfo(token);
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { user: first.user });
  await app.db.prepare("UPDATE user SET first_name = ?, last_name = ?, role = ? WHERE id = ?")
    .bind("Locally", "Updated", "admin", first.user.id).run();
  const changed = await requestUserInfo(token);
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { user: { ...first.user, firstName: "Locally", lastName: "Updated", role: "admin" } });
  const untouched = await requestUserInfo(second.tokens.access_token);
  assert.deepEqual(await untouched.json(), { user: second.user });
});

test("signed wrong issuer, audience, expiry, mode, and subject schema cannot reach a profile", async () => {
  for (const overrides of [
    { iss: "https://attacker.example.test" }, { aud: "other-client" }, { aud: [CLIENT_ID] },
    { aud: [CLIENT_ID, "other-client"] }, { exp: 1 }, { mode: "refresh" },
    { type: "service" }, { properties: { id: "" } },
  ]) await assertUnauthorized(await requestUserInfo(await sign(claims(overrides))));
  const missingExpiry = claims();
  delete missingExpiry.exp;
  await assertUnauthorized(await requestUserInfo(await sign(missingExpiry)));
});

test("forged, tampered, unknown-key, oversized, malformed, and actual refresh tokens are unauthorized", async () => {
  const attacker = await generateKeyPair("ES256");
  const forged = await sign(claims(), attacker.privateKey);
  const [header, , signature] = first.tokens.access_token.split(".");
  const tampered = `${header}.${Buffer.from(JSON.stringify(claims({ properties: { id: "victim" } }))).toString("base64url")}.${signature}`;
  for (const token of [forged, tampered, await sign(claims(), privateKey, { kid: "unknown-key" }),
    await sign(claims({ padding: "x".repeat(16_384) })), "not-a-jwt", "a.b.c", first.tokens.refresh_token]) {
    await assertUnauthorized(await requestUserInfo(token));
  }
});

test("missing, malformed, and duplicate Authorization values never select a bearer token", async () => {
  const token = first.tokens.access_token;
  await assertUnauthorized(await requestUserInfo(null));
  for (const authorization of ["", "Basic credentials", "Bearer", `Bearer  ${token}`, `Bearer\t${token}`,
    `Bearer ${token} extra`, `Bearer ${token},other`, `Bearer ${token}, Bearer ${token}`]) {
    await assertUnauthorized(await requestUserInfo(null, { headers: { Authorization: authorization } }));
  }
  const headers = new Headers();
  headers.append("Authorization", `Bearer ${token}`);
  headers.append("Authorization", `Bearer ${token}`);
  await assertUnauthorized(await requestUserInfo(null, { headers }));
});

test("userinfo permits only GET and rejects every query rather than accepting query credentials", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    const response = await requestUserInfo(first.tokens.access_token, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "GET");
  }
  for (const query of ["?unused=1", "?access_token=", `?access_token=${first.tokens.access_token}`]) {
    const response = await requestUserInfo(first.tokens.access_token, {}, `/userinfo${query}`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
});

test("an authenticated browser session cannot replace a missing or invalid bearer token", async () => {
  const client = createHttpClient(app.runtime);
  const login = await client.fetch("/login");
  assert.equal(login.status, 302);
  const authorization = await completeGoogleAuthorization(app, client, alice, login.headers.get("location"));
  const callback = await client.fetch(authorization.headers.get("location"));
  assert.equal(callback.status, 303);
  assert.equal((await client.fetch("/api/profile")).status, 200);
  await assertUnauthorized(await client.fetch("/userinfo"));
  await assertUnauthorized(await client.fetch("/userinfo", { headers: { Authorization: "Bearer invalid" } }));
  const fromCookie = [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  const second = await issueTokens(bob);
  const response = await requestUserInfo(second.tokens.access_token, { headers: { Cookie: fromCookie } });
  assert.deepEqual(await response.json(), { user: second.user });
});

test("nonexistent and deleted accounts remain unauthorized after the same Google identity signs up again", async () => {
  await assertUnauthorized(await requestUserInfo(await sign(claims({ properties: { id: crypto.randomUUID() } }))));
  await app.db.prepare("DELETE FROM user WHERE id = ?").bind(first.user.id).run();
  await assertUnauthorized(await requestUserInfo(first.tokens.access_token));
  const replacement = await issueTokens(alice);
  assert.notEqual(replacement.user.id, first.user.id);
  await assertUnauthorized(await requestUserInfo(first.tokens.access_token));
  const response = await requestUserInfo(replacement.tokens.access_token);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: replacement.user });
});
