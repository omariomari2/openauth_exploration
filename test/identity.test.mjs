import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { Miniflare } from "miniflare";
import { fetchGoogleProfile, getOrCreateGoogleUser, parseGoogleProfile } from "../src/identity.ts";

const validProfile = {
  sub: "google-subject-1",
  email: "person@example.test",
  email_verified: true,
  given_name: "First",
  family_name: "Last",
};

test("Google profile parsing keeps only bounded identity and name fields", () => {
  assert.deepEqual(parseGoogleProfile({
    ...validProfile,
    picture: "https://images.example.test/private-picture",
    locale: "en",
    phone: "unneeded-personal-data",
  }), validProfile);
  assert.deepEqual(parseGoogleProfile({
    sub: "a".repeat(255), email: "a@example.test", email_verified: true,
  }), { sub: "a".repeat(255), email: "a@example.test", email_verified: true });
});

test("Google profile parsing rejects malformed and unverified claims", () => {
  const invalid = [
    null, [], "profile", {},
    ...[undefined, null, 123, "", " ", "a b", "a\n", "é", "a".repeat(256)]
      .map((sub) => ({ ...validProfile, sub })),
    ...[undefined, null, 123, "", "not-an-email", "a@", "a@example..test",
      " a@example.test", "a@example.test\n", `${"a".repeat(250)}@example.test`]
      .map((email) => ({ ...validProfile, email })),
    ...[undefined, null, false, "true", 1].map((email_verified) => ({ ...validProfile, email_verified })),
    ...[null, 42, "a".repeat(101), "First\nName"].flatMap((name) => [
      { ...validProfile, given_name: name }, { ...validProfile, family_name: name },
    ]),
  ];
  for (const profile of invalid) {
    assert.throws(() => parseGoogleProfile(profile), { message: "Unable to verify Google identity" });
  }
});

test("Google UserInfo uses the fixed HTTPS endpoint and a bearer header without redirects", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://openidconnect.googleapis.com/v1/userinfo");
    assert.equal(options.headers.Authorization, "Bearer test-only-access-token");
    assert.equal(options.redirect, "error");
    assert.equal(options.signal instanceof AbortSignal, true);
    return Response.json({ ...validProfile, picture: "https://images.example.test/ignored" });
  });
  assert.deepEqual(await fetchGoogleProfile("test-only-access-token"), validProfile);
});

test("Google UserInfo rejects HTTP, redirect, non-JSON, malformed, and unverified responses", async (t) => {
  for (const response of [
    new Response("sensitive-provider-error", { status: 401 }),
    new Response("", { status: 302, headers: { Location: "https://attacker.example.test" } }),
    new Response(JSON.stringify(validProfile), { headers: { "Content-Type": "text/html" } }),
    new Response("{invalid-sensitive-json", { headers: { "Content-Type": "application/json" } }),
    Response.json({ ...validProfile, email_verified: false }),
    Response.json({ ...validProfile, sub: "" }),
    Response.json({ ...validProfile, picture: "x".repeat(16_384) }),
    new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "20000" } }),
  ]) {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(fetchGoogleProfile("test-only-access-token"), { message: "Unable to verify Google identity" });
    fetchMock.mock.restore();
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("secret-token-and-provider-details"); });
  await assert.rejects(fetchGoogleProfile("test-only-access-token"), { message: "Unable to verify Google identity" });
});

test("Google UserInfo rejects empty or unsafe bearer values before fetching", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(validProfile));
  for (const token of [undefined, null, "", " ", "token\r\nInjected: header", "x".repeat(8193)]) {
    await assert.rejects(fetchGoogleProfile(token), { message: "Unable to verify Google identity" });
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("Google UserInfo aborts a stalled external request within a bounded timeout", { timeout: 8000 }, async (t) => {
  let signal;
  t.mock.method(globalThis, "fetch", (_url, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    signal.addEventListener("abort", () => reject(new Error("sensitive upstream timeout")), { once: true });
  }));
  await assert.rejects(fetchGoogleProfile("test-only-access-token"), { message: "Unable to verify Google identity" });
  assert.equal(signal.aborted, true);
});

test("Google UserInfo limits streamed bytes even when Content-Length claims a small body", async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(4096).fill(32)); },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "application/json", "Content-Length": "2" } }));
  await assert.rejects(fetchGoogleProfile("test-only-access-token"), { message: "Unable to verify Google identity" });
  assert.equal(cancelled, true);
});

test("Google UserInfo keeps the timeout active while reading a stalled body", { timeout: 8000 }, async (t) => {
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        signal.addEventListener("abort", () => controller.error(new Error("private stream error")), { once: true });
      },
    }), { headers: { "Content-Type": "application/json" } });
  });
  await assert.rejects(fetchGoogleProfile("test-only-access-token"), { message: "Unable to verify Google identity" });
  assert.equal(signal.aborted, true);
});

describe("Google identity mapping with real isolated D1", () => {
  let runtime;
  let database;

  before(async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('identity tests'); } };",
      compatibilityDate: "2025-10-08",
      d1Databases: ["AUTH_DB"],
    });
    database = await runtime.getD1Database("AUTH_DB");
    const files = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
    for (const file of files) {
      if (file === "0004_google_identity.sql") {
        await database.prepare("INSERT INTO user (id, email) VALUES (?, ?)")
          .bind("legacy-empty-email", "").run();
      }
      const sql = await readFile(path.join("migrations", file), "utf8");
      await database.exec(sql.replace(/^--.*$/gm, "").replace(/\r?\n/g, " "));
    }
  });

  beforeEach(async () => {
    await database.prepare("DELETE FROM user WHERE id != ?").bind("legacy-empty-email").run();
  });

  after(async () => { await runtime?.dispose(); });

  test("additive identity migration preserves the legacy empty-email user", async () => {
    const legacy = await database.prepare("SELECT id, email, role FROM user WHERE id = ?")
      .bind("legacy-empty-email").first();
    assert.deepEqual(legacy, { id: "legacy-empty-email", email: "", role: "customer" });
    const result = await database.prepare("SELECT * FROM user_identities").all();
    assert.equal(result.results.length, 0);
  });

  test("creates separate accounts and saves only the signup profile snapshot", async () => {
    const first = await getOrCreateGoogleUser(database, parseGoogleProfile(validProfile));
    const second = await getOrCreateGoogleUser(database, parseGoogleProfile({
      ...validProfile, sub: "google-subject-2", email: "other@example.test",
    }));
    assert.notEqual(first, second);
    assert.notEqual(first, "legacy-empty-email");
    const user = await database.prepare("SELECT email, first_name, last_name, avatar_url, role, last_login FROM user WHERE id = ?")
      .bind(first).first();
    assert.deepEqual({ ...user, last_login: undefined }, {
      email: validProfile.email, first_name: "First", last_name: "Last", avatar_url: null,
      role: "customer", last_login: undefined,
    });
    assert.ok(user.last_login);
    const identities = await database.prepare("SELECT provider, provider_subject, user_id FROM user_identities ORDER BY provider_subject").all();
    assert.deepEqual(identities.results, [
      { provider: "google", provider_subject: validProfile.sub, user_id: first },
      { provider: "google", provider_subject: "google-subject-2", user_id: second },
    ]);
  });

  test("repeat sign-in uses the stable subject and retains local names and signup email", async () => {
    const first = await getOrCreateGoogleUser(database, parseGoogleProfile(validProfile));
    await database.prepare("UPDATE user SET first_name = ?, last_name = ?, last_login = ? WHERE id = ?")
      .bind("Locally edited", "Profile", "2000-01-01 00:00:00", first).run();
    await getOrCreateGoogleUser(database, parseGoogleProfile({
      ...validProfile, sub: "another-subject", email: "changed@example.test",
    }));
    const repeated = await getOrCreateGoogleUser(database, parseGoogleProfile({
      ...validProfile, email: "changed@example.test", given_name: "Changed", family_name: "Upstream",
    }));
    assert.equal(repeated, first);
    const user = await database.prepare("SELECT email, first_name, last_name, last_login FROM user WHERE id = ?")
      .bind(first).first();
    assert.equal(user.email, validProfile.email);
    assert.equal(user.first_name, "Locally edited");
    assert.equal(user.last_name, "Profile");
    assert.notEqual(user.last_login, "2000-01-01 00:00:00");
  });

  test("concurrent same-subject sign-ins create one identity and no orphan users", async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      getOrCreateGoogleUser(database, parseGoogleProfile({
        ...validProfile, email: `concurrent-${index}@example.test`,
      })),
    ));
    assert.equal(new Set(ids).size, 1);
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM user_identities").first("count"), 1);
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM user WHERE id != ?")
      .bind("legacy-empty-email").first("count"), 1);
  });

  test("a distinct Google subject cannot claim an occupied email", async () => {
    const id = await getOrCreateGoogleUser(database, parseGoogleProfile(validProfile));
    await assert.rejects(getOrCreateGoogleUser(database, parseGoogleProfile({
      ...validProfile, sub: "different-subject",
    })), { message: "Unable to complete Google sign-in" });
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM user_identities").first("count"), 1);
    assert.equal(await database.prepare("SELECT id FROM user WHERE email = ?").bind(validProfile.email).first("id"), id);
  });

  test("concurrent case-variant occupied emails create only one distinct identity", async () => {
    const results = await Promise.allSettled([
      getOrCreateGoogleUser(database, parseGoogleProfile(validProfile)),
      getOrCreateGoogleUser(database, parseGoogleProfile({
        ...validProfile, sub: "other-subject", email: validProfile.email.toUpperCase(),
      })),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejection = results.find((result) => result.status === "rejected");
    assert.equal(rejection.reason.message, "Unable to complete Google sign-in");
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM user_identities").first("count"), 1);
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM user WHERE id != ?")
      .bind("legacy-empty-email").first("count"), 1);
  });

  test("an occupied legacy email is never automatically linked", async () => {
    await database.prepare("INSERT INTO user (id, email, first_name) VALUES (?, ?, ?)")
      .bind("legacy-occupied", "PERSON@example.test", "Original").run();
    await assert.rejects(getOrCreateGoogleUser(database, parseGoogleProfile(validProfile)),
      { message: "Unable to complete Google sign-in" });
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM user_identities").first("count"), 0);
    assert.equal(await database.prepare("SELECT first_name FROM user WHERE id = ?")
      .bind("legacy-occupied").first("first_name"), "Original");
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM user").first("count"), 2);
  });

  test("invalid input cannot claim the legacy empty-email row or create a user", async () => {
    for (const profile of [
      { ...validProfile, email: "" }, { ...validProfile, email_verified: false }, { ...validProfile, sub: "" },
    ]) {
      await assert.rejects(getOrCreateGoogleUser(database, profile), { message: "Unable to verify Google identity" });
    }
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM user").first("count"), 1);
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM user_identities").first("count"), 0);
  });

  test("failure after the user insert rolls back the entire D1 batch", async () => {
    await database.exec("CREATE TRIGGER fail_identity_insert BEFORE INSERT ON user_identities BEGIN SELECT RAISE(ABORT, 'private database detail'); END;");
    try {
      await assert.rejects(getOrCreateGoogleUser(database, parseGoogleProfile(validProfile)),
        { message: "Unable to complete Google sign-in" });
      assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM user").first("count"), 1);
      assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM user_identities").first("count"), 0);
    } finally {
      await database.exec("DROP TRIGGER fail_identity_insert;");
    }
  });

  test("deleting an account cascades its Google identity without affecting another account", async () => {
    const first = await getOrCreateGoogleUser(database, parseGoogleProfile(validProfile));
    const second = await getOrCreateGoogleUser(database, parseGoogleProfile({
      ...validProfile, sub: "retained-subject", email: "retained@example.test",
    }));
    await database.prepare("DELETE FROM user WHERE id = ?").bind(first).run();
    const identities = await database.prepare("SELECT provider_subject, user_id FROM user_identities").all();
    assert.deepEqual(identities.results, [{ provider_subject: "retained-subject", user_id: second }]);
    assert.notEqual(await getOrCreateGoogleUser(database, parseGoogleProfile(validProfile)), first);
  });
});
