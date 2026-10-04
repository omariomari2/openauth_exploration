import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { CLIENT_ID, ORIGIN, VERIFIER, completeGoogleAuthorization, createHttpClient, createTestApp } from "./helpers/worker.mjs";

const alice = { sub: "delete-alice", email: "delete-alice@example.test", email_verified: true };
const bob = { sub: "delete-bob", email: "delete-bob@example.test", email_verified: true };
const SESSION_COOKIE = "__Host-openauth-session";
const hash = (value) => createHash("sha256").update(value).digest("hex");
let app;

before(async () => { app = await createTestApp(); });
beforeEach(async () => {
  await app.db.batch([app.db.prepare("DELETE FROM user"), app.db.prepare("DELETE FROM login_transactions")]);
});
afterEach(() => { app.fetchMock.assertNoPendingInterceptors(); });
after(async () => { await app?.dispose(); });

async function issueCode(profile = alice) {
  const client = createHttpClient(app.runtime);
  const response = await completeGoogleAuthorization(app, client, profile);
  assert.equal(response.status, 302);
  const callback = new URL(response.headers.get("location"));
  const userId = await app.db.prepare("SELECT id FROM user WHERE email = ?").bind(profile.email).first("id");
  return { client, code: callback.searchParams.get("code"), userId };
}

function exchangeCode(flow) {
  return flow.client.fetch("/token", { method: "POST", body: new URLSearchParams({
    grant_type: "authorization_code", client_id: CLIENT_ID, redirect_uri: `${ORIGIN}/callback`,
    code: flow.code, code_verifier: VERIFIER,
  }) });
}

async function issueTokens(profile = alice) {
  const flow = await issueCode(profile);
  const response = await exchangeCode(flow);
  assert.equal(response.status, 200);
  return { ...flow, tokens: await response.json() };
}

function refresh(flow) {
  return flow.client.fetch("/token", { method: "POST", body: new URLSearchParams({
    grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: flow.tokens.refresh_token,
  }) });
}

async function assertInvalidGrant(response) {
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_grant");
}

async function signIn(profile = alice) {
  const client = createHttpClient(app.runtime);
  const login = await client.fetch("/login");
  assert.equal(login.status, 302);
  const provider = await completeGoogleAuthorization(app, client, profile, login.headers.get("location"));
  assert.equal(provider.status, 302);
  assert.equal((await client.fetch(provider.headers.get("location"))).status, 303);
  const response = await client.fetch("/api/profile");
  assert.equal(response.status, 200);
  const result = await response.json();
  return { client, ...result, headers: { Origin: ORIGIN, "X-CSRF-Token": result.csrfToken } };
}

function deleteAccount(account, options = {}) {
  return account.client.fetch("/api/account", { method: "DELETE", headers: account.headers, ...options });
}

function userInfo(flow) {
  return flow.client.fetch("/userinfo", { headers: { Authorization: `Bearer ${flow.tokens.access_token}` } });
}

async function seedLegacyRows(userId) {
  await app.db.batch([
    app.db.prepare("INSERT INTO user_sessions (user_id, session_token, expires_at) VALUES (?, ?, ?)")
      .bind(userId, `legacy-${userId}`, "2099-01-01 00:00:00"),
    app.db.prepare(`INSERT INTO user_addresses
      (user_id, type, first_name, last_name, address_line_1, city, state, postal_code)
      VALUES (?, 'shipping', 'Test', 'Person', '1 Test Street', 'Test City', 'IL', '00000')`).bind(userId),
  ]);
}

test("a real refresh token cannot renew authentication after its D1 user is deleted", async () => {
  const flow = await issueTokens();
  await app.db.prepare("DELETE FROM user WHERE id = ?").bind(flow.userId).run();
  await assertInvalidGrant(await refresh(flow));
});

test("a real pending authorization code cannot authenticate after its D1 user is deleted", async () => {
  const flow = await issueCode();
  await app.db.prepare("DELETE FROM user WHERE id = ?").bind(flow.userId).run();
  await assertInvalidGrant(await exchangeCode(flow));
});

test("account deletion cascades only the current account's rows and clears all authentication cookies", async () => {
  const account = await signIn();
  const anotherSession = await signIn();
  const otherAccount = await signIn(bob);
  await seedLegacyRows(account.user.id);
  await seedLegacyRows(otherAccount.user.id);
  const tables = ["user_identities", "browser_sessions", "user_sessions", "user_addresses"];
  const otherRows = new Map();
  for (const table of tables) {
    otherRows.set(table, (await app.db.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).bind(otherAccount.user.id).all()).results);
  }
  assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions WHERE user_id = ?").bind(account.user.id).first("count"), 2);
  const keyCount = await app.db.prepare("SELECT COUNT(*) AS count FROM issuer_keys").first("count");
  // A pending login cookie is independent of the authenticated account.
  assert.equal((await account.client.fetch("/login")).status, 302);
  const response = await deleteAccount(account);
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  const cookies = response.headers.getSetCookie();
  for (const name of ["login", "session", "provider", "authorization"]) {
    const matching = cookies.filter((cookie) => cookie.startsWith(`__Host-openauth-${name}=`));
    assert.equal(matching.length, 1, name);
    for (const attribute of [/;\s*Max-Age=0(?:;|$)/i, /;\s*Path=\/(?:;|$)/i,
      /;\s*HttpOnly(?:;|$)/i, /;\s*SameSite=Lax(?:;|$)/i, /;\s*Secure(?:;|$)/i]) {
      assert.match(matching[0], attribute);
    }
    assert.doesNotMatch(matching[0], /;\s*Domain=/i);
    assert.equal(account.client.cookies.has(`__Host-openauth-${name}`), false);
  }
  assert.equal(await app.db.prepare("SELECT id FROM user WHERE id = ?").bind(account.user.id).first("id"), null);
  for (const table of tables) {
    assert.equal(await app.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).bind(account.user.id).first("count"), 0);
    assert.deepEqual((await app.db.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).bind(otherAccount.user.id).all()).results, otherRows.get(table));
  }
  assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM issuer_keys").first("count"), keyCount);
  assert.equal((await account.client.fetch("/api/profile")).status, 401);
  assert.equal((await anotherSession.client.fetch("/api/profile")).status, 401);
  assert.deepEqual((await (await otherAccount.client.fetch("/api/profile")).json()).user, otherAccount.user);
  assert.equal((await deleteAccount(account)).status, 401);
});

test("account deletion requires a unique live cookie session and never uses bearer authentication", async () => {
  const account = await signIn();
  const tokens = await issueTokens();
  const token = account.client.cookies.get(SESSION_COOKIE);
  for (const cookie of ["", `${SESSION_COOKIE}=invalid`, `${SESSION_COOKIE}=${token}; ${SESSION_COOKIE}=${token}`]) {
    assert.equal((await deleteAccount(account, { headers: { ...account.headers, Cookie: cookie } })).status, 401);
  }
  const bearerOnly = await deleteAccount(account, {
    headers: { ...account.headers, Cookie: "", Authorization: `Bearer ${tokens.tokens.access_token}` },
  });
  assert.equal(bearerOnly.status, 401);
  await app.db.prepare("UPDATE browser_sessions SET expires_at = 0 WHERE token_hash = ?").bind(hash(token)).run();
  assert.equal((await deleteAccount(account)).status, 401);
  assert.equal(await app.db.prepare("SELECT id FROM user WHERE id = ?").bind(account.user.id).first("id"), account.user.id);
});

test("account deletion requires exact Origin and the current session's own CSRF token", async () => {
  const account = await signIn();
  const anotherSession = await signIn();
  const otherAccount = await signIn(bob);
  for (const headers of [
    { "X-CSRF-Token": account.csrfToken }, { ...account.headers, Origin: "https://other.example.test" },
    { ...account.headers, Origin: "null" }, { Origin: ORIGIN }, { ...account.headers, "X-CSRF-Token": "" },
    { ...account.headers, "X-CSRF-Token": anotherSession.csrfToken },
    { ...account.headers, "X-CSRF-Token": otherAccount.csrfToken },
    { ...account.headers, "X-CSRF-Token": `${account.csrfToken}, ${account.csrfToken}` },
  ]) {
    assert.equal((await deleteAccount(account, { headers })).status, 403);
  }
  assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM user").first("count"), 2);
  assert.equal((await account.client.fetch("/api/profile")).status, 200);
  assert.equal((await otherAccount.client.fetch("/api/profile")).status, 200);
});

test("account deletion rejects query selectors, any body, and Authorization even with valid browser credentials", async () => {
  const account = await signIn();
  const otherAccount = await signIn(bob);
  for (const query of ["userId=other", `id=${otherAccount.user.id}`, "access_token=ignored", "unknown="]) {
    const response = await account.client.fetch(`/api/account?${query}`, { method: "DELETE", headers: account.headers });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
  for (const body of ["{}", JSON.stringify({ id: otherAccount.user.id }), " ", "id=other"]) {
    const response = await deleteAccount(account, { headers: { ...account.headers, "Content-Type": "application/json" }, body });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
  // The Miniflare HTTP boundary drops empty-valued headers before the Worker.
  // Exercise actual competing credentials, not a header the handler never sees.
  for (const authorization of ["Bearer ignored", "Basic ignored"]) {
    const response = await deleteAccount(account, { headers: { ...account.headers, Authorization: authorization } });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
  assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM user").first("count"), 2);
});

test("the account deletion endpoint allows only DELETE and never mutates through another method", async () => {
  const account = await signIn();
  for (const method of ["GET", "HEAD", "POST", "PATCH", "PUT", "OPTIONS"]) {
    const response = await account.client.fetch("/api/account", { method, headers: account.headers });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "DELETE");
  }
  assert.equal(await app.db.prepare("SELECT id FROM user WHERE id = ?").bind(account.user.id).first("id"), account.user.id);
});

test("deletion and same-Google re-signup never revive old sessions, access tokens, codes, or refresh tokens", async () => {
  const account = await signIn();
  const tokens = await issueTokens();
  const pendingCode = await issueCode();
  assert.equal(tokens.userId, account.user.id);
  assert.equal((await userInfo(tokens)).status, 200);
  const sessionCookie = `${SESSION_COOKIE}=${account.client.cookies.get(SESSION_COOKIE)}`;
  assert.equal((await deleteAccount(account)).status, 204);
  assert.equal((await userInfo(tokens)).status, 401);
  await assertInvalidGrant(await refresh(tokens));
  await assertInvalidGrant(await exchangeCode(pendingCode));
  const replacement = await signIn();
  assert.notEqual(replacement.user.id, account.user.id);
  assert.equal(replacement.user.email, account.user.email);
  assert.equal((await userInfo(tokens)).status, 401);
  await assertInvalidGrant(await refresh(tokens));
  await assertInvalidGrant(await exchangeCode(pendingCode));
  assert.equal((await replacement.client.fetch("/api/profile", { headers: { Cookie: sessionCookie } })).status, 401);
  const freshTokens = await issueTokens();
  assert.equal(freshTokens.userId, replacement.user.id);
  assert.equal((await (await userInfo(freshTokens)).json()).user.id, replacement.user.id);
  assert.equal((await refresh(freshTokens)).status, 200);
});
