import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ORIGIN, completeGoogleAuthorization, createHttpClient, createTestApp } from "./helpers/worker.mjs";

let app;
before(async () => { app = await createTestApp(); });
beforeEach(async () => { await app.db.prepare("DELETE FROM user").run(); });
after(async () => { await app?.dispose(); });

async function signIn(name = "alice") {
  const client = createHttpClient(app.runtime);
  const login = await client.fetch("/login");
  const provider = await completeGoogleAuthorization(app, client, {
    sub: `profile-${name}`, email: `${name}@example.test`, email_verified: true,
    given_name: name, family_name: "Original",
  }, login.headers.get("location"));
  assert.equal(provider.status, 302);
  assert.equal((await client.fetch(provider.headers.get("location"))).status, 303);
  const profile = await (await client.fetch("/api/profile")).json();
  app.fetchMock.assertNoPendingInterceptors();
  return { client, ...profile, headers: { Origin: ORIGIN, "X-CSRF-Token": profile.csrfToken, "Content-Type": "application/json" } };
}

function patch(account, data, options = {}) {
  return account.client.fetch("/api/profile", {
    method: "PATCH", headers: account.headers, body: JSON.stringify(data), ...options,
  });
}

test("profile PATCH changes only the current account's supplied names and preserves omitted fields", async () => {
  const alice = await signIn();
  const bob = await signIn("bob");
  const response = await patch(alice, { firstName: "  Alice O'Connor  " });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    user: { ...alice.user, firstName: "Alice O'Connor" }, csrfToken: alice.csrfToken,
  });
  const currentBob = await (await bob.client.fetch("/api/profile")).json();
  assert.deepEqual(currentBob.user, bob.user);
  assert.equal((await patch(alice, { firstName: null, lastName: "   " })).status, 200);
  const currentAlice = await (await alice.client.fetch("/api/profile")).json();
  assert.equal(currentAlice.user.firstName, null);
  assert.equal(currentAlice.user.lastName, null);
});

test("profile PATCH rejects identity, privilege, unknown, and invalid name fields without any write", async () => {
  const alice = await signIn();
  const before = await app.db.prepare("SELECT * FROM user WHERE id = ?").bind(alice.user.id).first();
  for (const body of [{}, null, [], "Alice", { id: "other" }, { email: "other@example.test" },
    { role: "admin" }, { firstName: "Changed", userId: "other" }, { avatarUrl: "https://example.test" },
    { firstName: 1 }, { firstName: {} }, { lastName: ["Other"] }, { firstName: "x".repeat(101) },
    { firstName: "Alice\nAdmin" }, { lastName: "\u007f" }]) {
    const response = await patch(alice, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: "invalid_profile" });
  }
  assert.deepEqual(await app.db.prepare("SELECT * FROM user WHERE id = ?").bind(alice.user.id).first(), before);
});

test("profile PATCH requires a live cookie session, exact Origin, and that session's CSRF token", async () => {
  const alice = await signIn();
  const bob = await signIn("bob");
  for (const headers of [ { "Content-Type": "application/json" },
    { ...alice.headers, Origin: "https://other.example.test" },
    { ...alice.headers, "X-CSRF-Token": bob.csrfToken }, { ...alice.headers, "X-CSRF-Token": "" }]) {
    assert.equal((await patch(alice, { firstName: "No" }, { headers })).status, 403);
  }
  assert.equal((await patch(alice, { firstName: "No" }, { headers: { ...alice.headers, Cookie: "" } })).status, 401);
  await app.db.prepare("UPDATE browser_sessions SET expires_at = 0 WHERE user_id = ?").bind(alice.user.id).run();
  assert.equal((await patch(alice, { firstName: "No" })).status, 401);
  assert.equal((await app.db.prepare("SELECT first_name FROM user WHERE id = ?").bind(alice.user.id).first()).first_name, "alice");
});

test("profile PATCH rejects selectors, unsupported media, malformed JSON and oversized streamed input", async () => {
  const alice = await signIn();
  assert.equal((await alice.client.fetch(`/api/profile?userId=other`, {
    method: "PATCH", headers: alice.headers, body: '{"firstName":"No"}',
  })).status, 400);
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "application/json; charset=iso-8859-1"]) {
    assert.equal((await patch(alice, { firstName: "No" }, { headers: { ...alice.headers, "Content-Type": contentType } })).status, 415);
  }
  assert.equal((await patch(alice, {}, { body: '{"firstName":' })).status, 400);
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"firstName":"'));
    controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
    controller.enqueue(new TextEncoder().encode('"}'));
    controller.close();
  } });
  assert.equal((await patch(alice, {}, { body, duplex: "half" })).status, 413);
  assert.equal((await patch(alice, {}, { body: new Uint8Array([0xff]) })).status, 400);
});

test("profile names are stored as data even when they contain SQL or HTML-looking text", async () => {
  const alice = await signIn();
  const name = "<img src=x onerror=alert(1)>' OR 1=1 --";
  const response = await patch(alice, { firstName: name });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.firstName, name);
  assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM user").first("count"), 1);
});

test("concurrent PATCH requests preserve independently updated fields", async () => {
  const alice = await signIn();
  const responses = await Promise.all([patch(alice, { firstName: "First" }), patch(alice, { lastName: "Last" })]);
  assert.ok(responses.every((response) => response.status === 200));
  const profile = await (await alice.client.fetch("/api/profile")).json();
  assert.equal(profile.user.firstName, "First");
  assert.equal(profile.user.lastName, "Last");
});

test("the actual Worker times out an unfinished PATCH body without changing the profile", { timeout: 10000 }, async () => {
  const alice = await signIn();
  let controller;
  const body = new ReadableStream({ start(value) {
    controller = value;
    controller.enqueue(new TextEncoder().encode('{"firstName":"'));
  } });
  const close = () => { try { controller.close(); } catch {} };
  // A broken timeout must fail rather than leave the test process with an open stream.
  const failsafe = setTimeout(close, 7500);
  try {
    const response = await patch(alice, {}, { body, duplex: "half" });
    assert.equal(response.status, 408);
    assert.deepEqual(await response.json(), { error: "request_timeout" });
    assert.equal(await app.db.prepare("SELECT first_name FROM user WHERE id = ?").bind(alice.user.id).first("first_name"), "alice");
  } finally { clearTimeout(failsafe); close(); }
});
