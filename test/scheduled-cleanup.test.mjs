import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createLoginTransaction, createSession, readSession } from "../src/browser-auth-storage.ts";
import { createTestApp } from "./helpers/worker.mjs";

test("the Worker config schedules authentication retention cleanup hourly", async () => {
  const config = JSON.parse(await readFile("wrangler.json", "utf8"));
  assert.deepEqual(config.triggers?.crons, ["0 * * * *"]);
});

test("scheduled cleanup removes expired credentials without a login and preserves live data", { timeout: 20000 }, async () => {
  const app = await createTestApp();
  try {
    await app.db.prepare("INSERT INTO user (id, email) VALUES (?, ?), (?, ?)")
      .bind("cleanup-one", "one@example.test", "cleanup-two", "two@example.test").run();
    const now = Date.now();
    await createLoginTransaction(app.db, { state: crypto.randomUUID(), verifier: "e".repeat(43) }, 0);
    await createLoginTransaction(app.db, { state: crypto.randomUUID(), verifier: "a".repeat(43) }, now);
    await createSession(app.db, "cleanup-one", 0);
    const active = await createSession(app.db, "cleanup-two", now);
    const users = (await app.db.prepare("SELECT * FROM user ORDER BY id").all()).results;
    const kv = await app.runtime.getKVNamespace("AUTH_STORAGE");
    await kv.put("unrelated-record", "preserved");
    const worker = await app.runtime.getWorker();

    // These are actual workerd scheduled events, not HTTP requests to a test route.
    assert.equal((await worker.scheduled({ cron: "0 * * * *" })).outcome, "ok");
    assert.equal((await app.db.prepare("SELECT COUNT(*) AS count FROM login_transactions").first()).count, 1);
    assert.equal((await app.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first()).count, 1);
    assert.deepEqual(await readSession(app.db, active.token), {
      userId: "cleanup-two", csrfToken: active.csrfToken, expiresAt: active.expiresAt,
    });
    assert.deepEqual((await app.db.prepare("SELECT * FROM user ORDER BY id").all()).results, users);
    assert.equal(await kv.get("unrelated-record"), "preserved");

    // Repeated/overlapping invocations must be safe, without extending credentials.
    const results = await Promise.all([worker.scheduled(), worker.scheduled()]);
    assert.ok(results.every((result) => result.outcome === "ok"));
    assert.equal((await app.db.prepare("SELECT COUNT(*) AS count FROM login_transactions").first()).count, 1);
    assert.equal((await app.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first()).count, 1);
    assert.equal((await readSession(app.db, active.token)).expiresAt, active.expiresAt);
  } finally { await app.dispose(); }
});

test("a failed scheduled cleanup rolls back its batch and the next invocation can recover", { timeout: 20000 }, async () => {
  const app = await createTestApp();
  try {
    await app.db.prepare("INSERT INTO user (id, email) VALUES (?, ?)")
      .bind("cleanup-user", "cleanup@example.test").run();
    await createLoginTransaction(app.db, { state: crypto.randomUUID(), verifier: "v".repeat(43) }, 0);
    await createSession(app.db, "cleanup-user", 0);
    await app.db.exec("CREATE TRIGGER reject_cleanup BEFORE DELETE ON browser_sessions BEGIN SELECT RAISE(ABORT, 'test cleanup failure'); END;");
    const worker = await app.runtime.getWorker();
    assert.equal((await worker.scheduled()).outcome, "exception");
    for (const table of ["login_transactions", "browser_sessions"]) {
      assert.equal((await app.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count, 1);
    }
    await app.db.exec("DROP TRIGGER reject_cleanup;");
    assert.equal((await worker.scheduled()).outcome, "ok");
    for (const table of ["login_transactions", "browser_sessions"]) {
      assert.equal((await app.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count, 0);
    }
    assert.equal((await app.db.prepare("SELECT COUNT(*) AS count FROM user").first()).count, 1);
  } finally { await app.dispose(); }
});
