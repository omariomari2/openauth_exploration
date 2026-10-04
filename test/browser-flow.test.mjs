import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { CLIENT_ID, ORIGIN, completeGoogleAuthorization, createHttpClient, createTestApp } from "./helpers/worker.mjs";

const LOGIN_COOKIE = "__Host-openauth-login";
const SESSION_COOKIE = "__Host-openauth-session";
const alice = { sub: "browser-alice", email: "alice@example.test", email_verified: true, given_name: "Alice", family_name: "Example" };
const bob = { sub: "browser-bob", email: "bob@example.test", email_verified: true, given_name: "Bob", family_name: "Other" };
const hash = (value) => createHash("sha256").update(value).digest("hex");
let app;

before(async () => { app = await createTestApp(); });
beforeEach(async () => {
  await app.db.batch([app.db.prepare("DELETE FROM user"), app.db.prepare("DELETE FROM login_transactions")]);
});
afterEach(() => { app.fetchMock.assertNoPendingInterceptors(); });
after(async () => { await app?.dispose(); });

function assertCookie(response, name, maxAge) {
  const cookies = response.headers.getSetCookie().filter((value) => value.startsWith(`${name}=`));
  assert.equal(cookies.length, 1, `one ${name} cookie`);
  for (const pattern of [/;\s*HttpOnly(?:;|$)/i, /;\s*Secure(?:;|$)/i, /;\s*SameSite=Lax(?:;|$)/i, /;\s*Path=\/(?:;|$)/i]) {
    assert.match(cookies[0], pattern);
  }
  assert.match(cookies[0], new RegExp(`;\\s*Max-Age=${maxAge}(?:;|$)`, "i"));
  assert.doesNotMatch(cookies[0], /;\s*Domain=/i);
}

function cookieHeader(client) {
  return [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function assertNoSecrets(response, ...secrets) {
  const body = await response.clone().text();
  for (const secret of ["test-google-access", ...secrets].filter(Boolean)) assert.ok(!body.includes(secret), "response must not echo credentials or callback values");
  assert.doesNotMatch(body, /access_token|refresh_token|id_token|code_verifier|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./);
}

async function beginLogin(client = createHttpClient(app.runtime)) {
  const response = await client.fetch("/login");
  assert.equal(response.status, 302);
  assertCookie(response, LOGIN_COOKIE, 600);
  const authorize = new URL(response.headers.get("location"), ORIGIN);
  assert.equal(authorize.origin, ORIGIN);
  assert.equal(authorize.pathname, "/authorize");
  assert.equal(authorize.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(authorize.searchParams.get("redirect_uri"), `${ORIGIN}/callback`);
  assert.equal(authorize.searchParams.get("response_type"), "code");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorize.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  const state = authorize.searchParams.get("state");
  const browserToken = client.cookies.get(LOGIN_COOKIE);
  assert.ok(state && state.length >= 32);
  assert.match(browserToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(state, browserToken);
  return { client, authorize, state, browserToken };
}

async function issueCode(profile = alice, client) {
  const login = await beginLogin(client);
  const response = await completeGoogleAuthorization(app, login.client, profile, login.authorize.href);
  assert.equal(response.status, 302);
  const callback = new URL(response.headers.get("location"));
  assert.equal(callback.origin, ORIGIN);
  assert.equal(callback.pathname, "/callback");
  assert.equal(callback.searchParams.get("state"), login.state);
  assert.ok(callback.searchParams.get("code"));
  return { ...login, callback, cookie: cookieHeader(login.client) };
}

async function finishLogin(flow) {
  const response = await flow.client.fetch(flow.callback.href);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  assertCookie(response, LOGIN_COOKIE, 0);
  assertCookie(response, SESSION_COOKIE, 3600);
  assert.equal(flow.client.cookies.has(LOGIN_COOKIE), false);
  assert.match(flow.client.cookies.get(SESSION_COOKIE), /^[A-Za-z0-9_-]{43}$/);
  await assertNoSecrets(response, flow.state, flow.callback.searchParams.get("code"), flow.client.cookies.get(SESSION_COOKIE));
  return response;
}

async function signIn(profile = alice) {
  const flow = await issueCode(profile);
  await finishLogin(flow);
  const response = await flow.client.fetch("/api/profile");
  assert.equal(response.status, 200);
  const profileResult = await response.json();
  assert.match(profileResult.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  return { ...flow, profile: profileResult };
}

async function assertRejectedCallback(flow, url = flow.callback.href, headers) {
  const response = await flow.client.fetch(url, headers ? { headers } : {});
  assert.ok(response.status >= 400 && response.status < 500, `callback rejected with ${response.status}`);
  assert.equal(response.headers.get("location"), null);
  await assertNoSecrets(response, flow.state, new URL(url, ORIGIN).searchParams.get("code"));
  return response;
}

test("login stores independent unpredictable browser and PKCE transaction secrets", async () => {
  const first = await beginLogin();
  const second = await beginLogin();
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.browserToken, second.browserToken);
  const transaction = await app.db.prepare("SELECT browser_hash, verifier, expires_at FROM login_transactions WHERE state_hash = ?")
    .bind(hash(first.state)).first();
  assert.equal(transaction.browser_hash, hash(first.browserToken));
  assert.equal(createHash("sha256").update(transaction.verifier).digest("base64url"), first.authorize.searchParams.get("code_challenge"));
  assert.notEqual(first.browserToken, transaction.verifier);
  assert.ok(transaction.expires_at > Date.now() && transaction.expires_at <= Date.now() + 600_000);
});

test("real code exchange produces a private session and only the allowed profile fields", async () => {
  const flow = await signIn();
  const user = await app.db.prepare("SELECT id, email, first_name AS firstName, last_name AS lastName, role, created_at AS createdAt FROM user WHERE email = ?")
    .bind(alice.email).first();
  assert.deepEqual(flow.profile, { user, csrfToken: flow.profile.csrfToken });
  const response = await flow.client.fetch("/api/profile");
  await assertNoSecrets(response, flow.browserToken, flow.client.cookies.get(SESSION_COOKIE));
  assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM login_transactions").first("count"), 0);
});

test("profile rejects absent, unknown, malformed, and duplicate session cookies", async () => {
  const client = createHttpClient(app.runtime);
  for (const cookie of ["", `${SESSION_COOKIE}=${"x".repeat(43)}`, `${SESSION_COOKIE}=bad`]) {
    assert.equal((await client.fetch("/api/profile", { headers: { Cookie: cookie } })).status, 401);
  }
  const flow = await signIn();
  const valid = `${SESSION_COOKIE}=${flow.client.cookies.get(SESSION_COOKIE)}`;
  const invalid = `${SESSION_COOKIE}=${"x".repeat(43)}`;
  for (const cookie of [`${valid}; ${invalid}`, `${invalid}; ${valid}`, `${valid}; ${valid}`]) {
    assert.equal((await flow.client.fetch("/api/profile", { headers: { Cookie: cookie } })).status, 401);
  }
});

test("callback transplantation and wrong state cannot authenticate or consume the real browser's login", async () => {
  const flow = await issueCode();
  for (const cookie of ["", `${LOGIN_COOKIE}=${"x".repeat(43)}`]) {
    await assertRejectedCallback(flow, flow.callback.href, { Cookie: cookie });
  }
  const wrongState = new URL(flow.callback);
  wrongState.searchParams.set("state", "00000000-0000-4000-8000-000000000000");
  await assertRejectedCallback(flow, wrongState.href, { Cookie: flow.cookie });
  assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"), 0);
  // Rejection responses can clear client cookies, so preserve the original browser binding explicitly.
  flow.client.cookies.set(LOGIN_COOKIE, flow.browserToken);
  await finishLogin(flow);
});

test("callback rejects missing, duplicate, empty, and malformed query values without exposing them", async () => {
  const cases = [
    (state) => `?state=${state}`,
    () => "?code=private-code",
    (state) => `?code=&state=${state}`,
    () => "?code=private-code&state=",
    (state) => `?code=private-code&code=other-private-code&state=${state}`,
    (state) => `?code=private-code&state=${state}&state=${state}`,
    () => "?code=private-code&state=%ZZ",
    (state) => `?code=${"x".repeat(4097)}&state=${state}`,
  ];
  for (const query of cases) {
    const flow = await beginLogin();
    await assertRejectedCallback(flow, `/callback${query(flow.state)}`);
  }
  assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"), 0);
});

test("callback replay with the original cookie cannot create another session", async () => {
  const flow = await issueCode();
  await finishLogin(flow);
  await assertRejectedCallback(flow, flow.callback.href, { Cookie: flow.cookie });
  assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"), 1);
});

test("concurrent callback replay consumes the browser transaction exactly once", async () => {
  const flow = await issueCode();
  const responses = await Promise.all(Array.from({ length: 5 }, () =>
    flow.client.fetch(flow.callback.href, { headers: { Cookie: flow.cookie } })));
  assert.equal(responses.filter((response) => response.status === 303).length, 1);
  assert.equal(responses.filter((response) => response.status >= 400 && response.status < 500).length, 4);
  assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"), 1);
});

test("wrong stored PKCE verifier and expired browser transactions cannot establish sessions", async () => {
  for (const change of ["verifier = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'", "expires_at = 0"]) {
    const flow = await issueCode();
    await app.db.prepare(`UPDATE login_transactions SET ${change} WHERE state_hash = ?`).bind(hash(flow.state)).run();
    await assertRejectedCallback(flow);
    assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"), 0);
  }
});

test("sessions isolate accounts and read names and roles from current D1 data", async () => {
  const first = await signIn(alice);
  const second = await signIn(bob);
  assert.notEqual(first.profile.user.id, second.profile.user.id);
  assert.notEqual(first.profile.csrfToken, second.profile.csrfToken);
  await app.db.prepare("UPDATE user SET first_name = ?, last_name = ?, role = ? WHERE id = ?")
    .bind("Edited", "Locally", "admin", first.profile.user.id).run();
  const changed = await (await first.client.fetch("/api/profile")).json();
  assert.deepEqual(changed.user, { ...first.profile.user, firstName: "Edited", lastName: "Locally", role: "admin" });
  assert.deepEqual(await (await second.client.fetch("/api/profile")).json(), second.profile);
});

test("logout requires the exact origin and the current session's CSRF token", async () => {
  const first = await signIn(alice);
  const second = await signIn(bob);
  for (const headers of [
    { "X-CSRF-Token": first.profile.csrfToken },
    { Origin: "https://attacker.example.test", "X-CSRF-Token": first.profile.csrfToken },
    { Origin: `${ORIGIN}/`, "X-CSRF-Token": first.profile.csrfToken },
    { Origin: ORIGIN },
    { Origin: ORIGIN, "X-CSRF-Token": second.profile.csrfToken },
  ]) {
    const response = await first.client.fetch("/logout", { method: "POST", headers });
    assert.ok(response.status >= 400 && response.status < 500);
    assert.equal((await first.client.fetch("/api/profile")).status, 200);
  }
  assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"), 2);
});

test("logout revokes only the current session, clears its cookie, and prevents reuse", async () => {
  const first = await signIn();
  const second = await signIn();
  const originalCookie = cookieHeader(first.client);
  const response = await first.client.fetch("/logout", {
    method: "POST", headers: { Origin: ORIGIN, "X-CSRF-Token": first.profile.csrfToken },
  });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assertCookie(response, SESSION_COOKIE, 0);
  assert.equal(first.client.cookies.has(SESSION_COOKIE), false);
  assert.equal((await first.client.fetch("/api/profile")).status, 401);
  assert.equal((await first.client.fetch("/api/profile", { headers: { Cookie: originalCookie } })).status, 401);
  assert.equal((await second.client.fetch("/api/profile")).status, 200);
  assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"), 1);
});

test("server-side expiry rejects an otherwise valid session cookie", async () => {
  const flow = await signIn();
  await app.db.prepare("UPDATE browser_sessions SET expires_at = 0 WHERE token_hash = ?")
    .bind(hash(flow.client.cookies.get(SESSION_COOKIE))).run();
  assert.equal((await flow.client.fetch("/api/profile")).status, 401);
});

test("a raw provider cookie tossed before the victim's cookies cannot transplant Google login", async () => {
  // Isolate deliberately unused Google mocks when the callback is rejected before any network call.
  const isolated = await createTestApp();
  try {
    async function startProvider() {
      const flow = await beginLogin(createHttpClient(isolated.runtime));
      const authorization = await flow.client.fetch(flow.authorize.href);
      assert.equal(authorization.status, 302);
      const provider = await flow.client.fetch(authorization.headers.get("location"));
      assert.equal(provider.status, 302);
      const google = new URL(provider.headers.get("location"));
      assert.equal(google.origin, "https://accounts.google.com");
      return { ...flow, google };
    }
    // Leave both browser flows pending, but initialize the issuer's first encryption key once.
    const attacker = await startProvider();
    const victim = await startProvider();
    // The legacy name keeps this a reproducible RED test before the public-cookie adapter is wired.
    const attackerProvider = attacker.client.cookies.get("__Host-openauth-provider") ?? attacker.client.cookies.get("provider");
    assert.ok(attackerProvider);
    assert.notEqual(attacker.google.searchParams.get("state"), victim.google.searchParams.get("state"));
    const requests = { token: 0, userInfo: 0 };
    isolated.fetchMock.get("https://oauth2.googleapis.com")
      .intercept({ path: "/token", method: "POST" }).reply(200, () => {
        requests.token++;
        return JSON.stringify({ access_token: "attacker-google-access", token_type: "Bearer", expires_in: 3600 });
      }, { headers: { "content-type": "application/json" } });
    isolated.fetchMock.get("https://openidconnect.googleapis.com")
      .intercept({ path: "/v1/userinfo", method: "GET" }).reply(200, () => {
        requests.userInfo++;
        return JSON.stringify(bob);
      }, { headers: { "content-type": "application/json" } });
    const response = await victim.client.fetch(`/google/callback?${new URLSearchParams({
      code: "attacker-google-code", state: attacker.google.searchParams.get("state"),
    })}`, { headers: { Cookie: `provider=${attackerProvider}; ${cookieHeader(victim.client)}` } });
    assert.deepEqual(requests, { token: 0, userInfo: 0 });
    assert.equal(await isolated.db.prepare("SELECT COUNT(*) AS count FROM user").first("count"), 0);
    assert.equal(await isolated.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"), 0);
    // OpenAuth restarts mismatched provider state; it must not complete the app callback.
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `${ORIGIN}/google/authorize`);
  } finally { await isolated.dispose(); }
});

test("a non-ASCII whitespace prefix cannot turn another cookie name into a session cookie", async () => {
  const flow = await signIn();
  const response = await flow.client.fetch("/api/profile", {
    headers: { Cookie: `\u00a0${SESSION_COOKIE}=${flow.client.cookies.get(SESSION_COOKIE)}` },
  });
  assert.equal(response.status, 401);
});

test("signing in again in the same browser replaces and revokes its previous account session", async () => {
  const original = await signIn(alice);
  const oldCookie = cookieHeader(original.client);
  const replacement = await issueCode(bob, original.client);
  await finishLogin(replacement);
  const current = await (await original.client.fetch("/api/profile")).json();
  assert.equal(current.user.email, bob.email);
  assert.notEqual(current.user.id, original.profile.user.id);
  assert.equal((await original.client.fetch("/api/profile", { headers: { Cookie: oldCookie } })).status, 401);
  assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"), 1);
});

test("duplicate login cookies cannot consume the genuine browser transaction", async () => {
  const flow = await issueCode();
  const other = `${LOGIN_COOKIE}=${"x".repeat(43)}`;
  for (const cookie of [`${flow.cookie}; ${other}`, `${other}; ${flow.cookie}`, `${flow.cookie}; ${LOGIN_COOKIE}=${flow.browserToken}`]) {
    await assertRejectedCallback(flow, flow.callback.href, { Cookie: cookie });
    assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM login_transactions WHERE state_hash = ?")
      .bind(hash(flow.state)).first("count"), 1);
  }
  flow.client.cookies.set(LOGIN_COOKIE, flow.browserToken);
  await finishLogin(flow);
});

test("HTTPS ignores local-only login and session cookie names", async () => {
  const signedIn = await signIn();
  const session = signedIn.client.cookies.get(SESSION_COOKIE);
  assert.equal((await signedIn.client.fetch("/api/profile", {
    headers: { Cookie: `local-openauth-session=${session}` },
  })).status, 401);
  assert.equal((await signedIn.client.fetch("/api/profile", {
    headers: { Cookie: `local-openauth-session=${"x".repeat(43)}; ${cookieHeader(signedIn.client)}` },
  })).status, 200);
  const pending = await issueCode(bob);
  await assertRejectedCallback(pending, pending.callback.href, {
    Cookie: `local-openauth-login=${pending.browserToken}`,
  });
  pending.client.cookies.set(LOGIN_COOKIE, pending.browserToken);
  await finishLogin(pending);
});
