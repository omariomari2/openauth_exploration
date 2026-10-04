import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { Miniflare } from "miniflare";
import {
  cleanupExpiredAuth, consumeLoginTransaction, createLoginTransaction,
  createSession, readSession, revokeSession,
} from "../src/browser-auth-storage.ts";

const now = 1_800_000_000_000;
const transactionLifetime = 10 * 60 * 1000;
const sessionLifetime = 60 * 60 * 1000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const challenge = () => ({ state: crypto.randomUUID(), verifier: "v".repeat(43) });

describe("Browser authentication storage with real isolated D1", () => {
  let runtime;
  let database;

  before(async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('browser auth storage tests'); } };",
      compatibilityDate: "2025-10-08",
      d1Databases: ["AUTH_DB"],
    });
    database = await runtime.getD1Database("AUTH_DB");
    const files = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = await readFile(path.join("migrations", file), "utf8");
      await database.exec(sql.replace(/^--.*$/gm, "").replace(/\r?\n/g, " "));
    }
  });

  beforeEach(async () => {
    await database.batch([
      database.prepare("DELETE FROM login_transactions"),
      database.prepare("DELETE FROM user"),
      database.prepare("INSERT INTO user (id, email) VALUES (?, ?), (?, ?)")
        .bind("user-one", "one@example.test", "user-two", "two@example.test"),
    ]);
  });

  after(async () => { await runtime?.dispose(); });

  test("stores only hashes of state and the independent random browser token", async () => {
    const input = challenge();
    const browserToken = await createLoginTransaction(database, input, now);
    assert.match(browserToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(browserToken, "base64url").length, 32);
    assert.notEqual(browserToken, input.state);
    assert.notEqual(browserToken, input.verifier);
    const row = await database.prepare("SELECT * FROM login_transactions").first();
    assert.deepEqual(row, {
      state_hash: hash(input.state), browser_hash: hash(browserToken),
      verifier: input.verifier, expires_at: now + transactionLifetime,
    });
    const other = await createLoginTransaction(database, challenge(), now);
    assert.notEqual(other, browserToken);
  });

  test("a callback needs its original browser and state, and succeeds only once", async () => {
    const first = challenge();
    const second = challenge();
    const firstBrowser = await createLoginTransaction(database, first, now);
    const secondBrowser = await createLoginTransaction(database, second, now);
    assert.equal(await consumeLoginTransaction(database, first.state, secondBrowser, now), null);
    assert.equal(await consumeLoginTransaction(database, crypto.randomUUID(), firstBrowser, now), null);
    assert.equal(await consumeLoginTransaction(database, second.state, firstBrowser, now), null);
    assert.equal(await consumeLoginTransaction(database, first.state, firstBrowser, now), first.verifier);
    assert.equal(await consumeLoginTransaction(database, first.state, firstBrowser, now), null);
    assert.equal(await consumeLoginTransaction(database, second.state, secondBrowser, now), second.verifier);
  });

  test("concurrent callback consumption has exactly one winner", async () => {
    const input = challenge();
    const browserToken = await createLoginTransaction(database, input, now);
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      consumeLoginTransaction(database, input.state, browserToken, now),
    ));
    assert.equal(results.filter((result) => result === input.verifier).length, 1);
    assert.equal(results.filter((result) => result === null).length, 11);
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM login_transactions").first("count"), 0);
  });

  test("transactions expire exactly at ten minutes", async () => {
    const valid = challenge();
    const expired = challenge();
    const validBrowser = await createLoginTransaction(database, valid, now);
    const expiredBrowser = await createLoginTransaction(database, expired, now);
    assert.equal(await consumeLoginTransaction(database, valid.state, validBrowser,
      now + transactionLifetime - 1), valid.verifier);
    assert.equal(await consumeLoginTransaction(database, expired.state, expiredBrowser,
      now + transactionLifetime), null);
  });

  test("invalid transaction inputs fail generically without creating rows", async () => {
    for (const input of [
      undefined, null, {}, [], "transaction",
      ...[undefined, null, 1, "", "state", "x".repeat(256)].map((state) => ({ ...challenge(), state })),
      ...[undefined, null, 1, "", "v".repeat(42), "v".repeat(129), "v".repeat(42) + " "]
        .map((verifier) => ({ ...challenge(), verifier })),
    ]) {
      await assert.rejects(createLoginTransaction(database, input, now),
        { message: "Unable to create login transaction" });
    }
    for (const time of [-1, NaN, Infinity, "1800000000000", Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(createLoginTransaction(database, challenge(), time),
        { message: "Unable to create login transaction" });
    }
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM login_transactions").first("count"), 0);
  });

  test("malformed callback values do not consume a legitimate transaction", async () => {
    const input = challenge();
    const browserToken = await createLoginTransaction(database, input, now);
    for (const value of [undefined, null, 1, "", " ", "x".repeat(42), "x".repeat(44), "x".repeat(42) + "/"]) {
      assert.equal(await consumeLoginTransaction(database, input.state, value, now), null);
      assert.equal(await consumeLoginTransaction(database, value, browserToken, now), null);
    }
    assert.equal(await consumeLoginTransaction(database, input.state, browserToken, now), input.verifier);
  });

  test("duplicate state cannot replace the original browser binding or verifier", async () => {
    const input = challenge();
    const browserToken = await createLoginTransaction(database, input, now);
    await assert.rejects(createLoginTransaction(database, { ...input, verifier: "b".repeat(128) }, now),
      { message: "Unable to create login transaction" });
    assert.equal(await consumeLoginTransaction(database, input.state, browserToken, now), input.verifier);
  });

  test("session credentials are random, hashed at rest, and distinct from CSRF tokens", async () => {
    const session = await createSession(database, "user-one", now);
    const other = await createSession(database, "user-one", now);
    assert.equal(new Set([session.token, session.csrfToken, other.token, other.csrfToken]).size, 4);
    for (const value of [session.token, session.csrfToken, other.token, other.csrfToken]) {
      assert.match(value, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(value, "base64url").length, 32);
    }
    assert.equal(session.expiresAt, now + sessionLifetime);
    const row = await database.prepare("SELECT * FROM browser_sessions WHERE token_hash = ?")
      .bind(hash(session.token)).first();
    assert.deepEqual(row, {
      token_hash: hash(session.token), user_id: "user-one",
      csrf_token: session.csrfToken, expires_at: session.expiresAt,
    });
    assert.equal(await readSession(database, session.csrfToken, now), null);
    assert.equal(await readSession(database, row.token_hash, now), null);
  });

  test("sessions isolate users and deleting one account revokes only that account", async () => {
    const first = await createSession(database, "user-one", now);
    const second = await createSession(database, "user-two", now);
    assert.deepEqual(await readSession(database, first.token, now), {
      userId: "user-one", csrfToken: first.csrfToken, expiresAt: first.expiresAt,
    });
    assert.deepEqual(await readSession(database, second.token, now), {
      userId: "user-two", csrfToken: second.csrfToken, expiresAt: second.expiresAt,
    });
    await database.prepare("DELETE FROM user WHERE id = ?").bind("user-one").run();
    assert.equal(await readSession(database, first.token, now), null);
    assert.equal((await readSession(database, second.token, now)).userId, "user-two");
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"), 1);
  });

  test("logout revokes a session immediately without revoking other sessions", async () => {
    const session = await createSession(database, "user-one", now);
    const other = await createSession(database, "user-one", now);
    await revokeSession(database, session.token);
    assert.equal(await readSession(database, session.token, now), null);
    assert.notEqual(await readSession(database, other.token, now), null);
    await revokeSession(database, session.token);
  });

  test("sessions expire exactly at one hour even before cleanup runs", async () => {
    const session = await createSession(database, "user-one", now);
    assert.notEqual(await readSession(database, session.token, session.expiresAt - 1), null);
    assert.equal(await readSession(database, session.token, session.expiresAt), null);
    assert.equal(await readSession(database, session.token, session.expiresAt + 1), null);
  });

  test("invalid session creation and malformed credential lookup fail safely", async () => {
    for (const userId of [undefined, null, 1, "", " ", "a\n", "a".repeat(256), "absent-user"]) {
      await assert.rejects(createSession(database, userId, now), { message: "Unable to create session" });
    }
    for (const time of [-1, NaN, Infinity, "1800000000000", Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(createSession(database, "user-one", time), { message: "Unable to create session" });
    }
    const session = await createSession(database, "user-one", now);
    for (const token of [undefined, null, 1, "", " ", "x".repeat(42), "x".repeat(44), "x".repeat(42) + "/"]) {
      assert.equal(await readSession(database, token, now), null);
      await revokeSession(database, token);
    }
    assert.notEqual(await readSession(database, session.token, now), null);
  });

  test("cleanup deletes expired credentials while preserving active ones and user data", async () => {
    const expired = challenge();
    const active = challenge();
    await createLoginTransaction(database, expired, now - transactionLifetime);
    const activeBrowser = await createLoginTransaction(database, active, now);
    const expiredSession = await createSession(database, "user-one", now - sessionLifetime);
    const activeSession = await createSession(database, "user-two", now);
    await cleanupExpiredAuth(database, now);
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM login_transactions").first("count"), 1);
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"), 1);
    assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM user").first("count"), 2);
    assert.equal(await consumeLoginTransaction(database, active.state, activeBrowser, now), active.verifier);
    assert.equal(await readSession(database, expiredSession.token, now), null);
    assert.equal((await readSession(database, activeSession.token, now)).userId, "user-two");
  });
});
