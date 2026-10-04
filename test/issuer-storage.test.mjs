import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { after, before, beforeEach, describe, test } from "node:test";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { Miniflare } from "miniflare";
import { encryptionKeys, legacySigningKeys, signingKeys } from "../node_modules/@openauthjs/openauth/dist/esm/keys.js";
import { createIssuerStorage } from "../src/issuer-storage.ts";

const failure = { message: "Unable to access issuer keys" };
const purposes = ["encryption:key", "signing:key"];
const algorithms = { "encryption:key": "RSA-OAEP-512", "signing:key": "ES256" };
const fixtures = Object.fromEntries(await Promise.all(purposes.map(async (purpose) => {
  const alg = algorithms[purpose];
  const pair = await generateKeyPair(alg, { extractable: true });
  return [purpose, {
    id: crypto.randomUUID(), publicKey: await exportSPKI(pair.publicKey),
    privateKey: await exportPKCS8(pair.privateKey), created: Date.now(), alg,
  }];
})));

// Pause real initial scans until all callers observed the same empty D1 table.
// Only scheduling changes: reads, writes, and OpenAuth key generation remain real.
function synchronizeEmptyScans(adapters, purpose) {
  let arrived = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  return adapters.map((adapter) => {
    let first = true;
    return {
      ...adapter,
      async *scan(prefix) {
        if (first && prefix[0] === purpose) {
          first = false;
          const rows = await Array.fromAsync(adapter.scan(prefix));
          assert.deepEqual(rows, []);
          if (++arrived === adapters.length) release();
          await ready;
          yield* rows;
          return;
        }
        yield* adapter.scan(prefix);
      },
    };
  });
}

describe("issuer storage with real isolated D1 and KV", () => {
  let runtime;
  let db;
  let namespace;
  let storage;

  before(async () => {
    runtime = new Miniflare({
      modules: true, script: "export default { fetch() { return new Response('issuer storage tests'); } };",
      compatibilityDate: "2025-10-08", d1Databases: ["AUTH_DB"], kvNamespaces: ["AUTH_STORAGE"],
    });
    db = await runtime.getD1Database("AUTH_DB");
    namespace = await runtime.getKVNamespace("AUTH_STORAGE");
    for (const file of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
      if (file === "0006_issuer_keys.sql") {
        await db.prepare("INSERT INTO user (id, email) VALUES (?, ?)").bind("migration-user", "preserved@example.test").run();
        await db.prepare("INSERT INTO browser_sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)")
          .bind("a".repeat(64), "migration-user", "b".repeat(43), Date.now() + 60_000).run();
      }
      const sql = await readFile(`migrations/${file}`, "utf8");
      await db.exec(sql.replace(/^--.*$/gm, "").replace(/\r?\n/g, " "));
    }
  });

  beforeEach(async () => {
    await db.exec("DELETE FROM issuer_keys");
    await db.prepare("DELETE FROM user WHERE id != ?").bind("migration-user").run();
    await db.prepare("INSERT INTO user (id, email) VALUES (?, ?)").bind("test-user", "grant@example.test").run();
    for (const key of (await namespace.list()).keys) await namespace.delete(key.name);
    storage = createIssuerStorage(db, namespace);
  });

  after(async () => { await runtime?.dispose(); });

  test("the additive migration preserves existing users and browser sessions", async () => {
    assert.equal(await db.prepare("SELECT email FROM user WHERE id = ?").bind("migration-user").first("email"),
      "preserved@example.test");
    assert.equal(await db.prepare("SELECT user_id FROM browser_sessions WHERE token_hash = ?")
      .bind("a".repeat(64)).first("user_id"), "migration-user");
  });

  test("empty key reads and scans are missing without importing old KV key material", async () => {
    for (const purpose of purposes) {
      const record = fixtures[purpose];
      await namespace.put(`${purpose}\u001f${record.id}`, JSON.stringify(record));
      assert.equal(await storage.get([purpose, record.id]), undefined);
      assert.deepEqual(await Array.fromAsync(storage.scan([purpose])), []);
    }
  });

  for (const purpose of purposes) {
    test(`${purpose} is shared across adapters and cannot be overwritten, expired, or removed`, async () => {
      const original = fixtures[purpose];
      const key = [purpose, original.id];
      const independent = createIssuerStorage(db, namespace);
      await storage.set(key, original);
      assert.deepEqual(await independent.get(key), original);
      assert.deepEqual(await Array.fromAsync(independent.scan([purpose])), [[key, original]]);
      await independent.set(key, { ...original, created: original.created + 1 });
      const losing = { ...original, id: crypto.randomUUID(), created: original.created + 2 };
      await independent.set([purpose, losing.id], losing);
      assert.deepEqual(await storage.get(key), original);
      assert.equal(await storage.get([purpose, losing.id]), undefined);
      await assert.rejects(storage.set(key, original, new Date(Date.now() + 60_000)), failure);
      await assert.rejects(storage.remove(key), failure);
      assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM issuer_keys").first("count"), 1);
      assert.deepEqual((await namespace.list()).keys, []);
    });

    test(`12 concurrent OpenAuth ${purpose} creators converge on one D1 winner`, { timeout: 30_000 }, async () => {
      const adapters = synchronizeEmptyScans(Array.from({ length: 12 }, () => createIssuerStorage(db, namespace)), purpose);
      const load = purpose === "encryption:key" ? encryptionKeys : signingKeys;
      const results = await Promise.all(adapters.map((adapter) => load(adapter)));
      assert.ok(results.every((keys) => keys.length === 1));
      assert.equal(new Set(results.map(([key]) => key.id)).size, 1);
      assert.equal(new Set(results.map(([key]) => JSON.stringify(key.jwk))).size, 1);
      assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM issuer_keys WHERE purpose = ?").bind(purpose).first("count"), 1);
      const [reread] = await load(createIssuerStorage(db, namespace));
      assert.equal(reread.id, results[0][0].id);
      assert.deepEqual((await namespace.list()).keys, []);
    });
  }

  test("legacy RS512 keys are deliberately absent and can never be written or removed through the adapter", async () => {
    const key = ["oauth:key", crypto.randomUUID()];
    await namespace.put(key.join("\u001f"), JSON.stringify({ privateKey: "old-private-key-must-never-load" }));
    assert.equal(await storage.get(key), undefined);
    assert.deepEqual(await Array.fromAsync(storage.scan(["oauth:key"])), []);
    assert.deepEqual(await legacySigningKeys(storage), []);
    await assert.rejects(storage.set(key, fixtures["signing:key"]), failure);
    await assert.rejects(storage.remove(key), failure);
    assert.ok(await namespace.get(key.join("\u001f")));
  });

  test("reserved malformed and unknown key paths never fall through to KV", async () => {
    const id = fixtures["signing:key"].id;
    for (const key of [[], ["signing:key"], ["encryption:key", "not-a-uuid"], ["signing:key", id, "extra"],
      ["future:key", id], ["oauth:key", id, "extra"], ["signing:key\u001f", id]]) {
      await assert.rejects(storage.get(key), failure);
      await assert.rejects(storage.set(key, fixtures["signing:key"]), failure);
      await assert.rejects(storage.remove(key), failure);
    }
    for (const prefix of [[], ["signing:key", id], ["encryption:key", ""], ["future:key"], ["oauth:key", id]]) {
      await assert.rejects(Array.fromAsync(storage.scan(prefix)), failure);
    }
    assert.deepEqual((await namespace.list()).keys, []);
  });

  test("candidate key records reject invalid schema, future fields, algorithms, and ID mismatch", async () => {
    const original = fixtures["signing:key"];
    for (const value of [null, [], {}, { ...original, id: crypto.randomUUID() },
      { ...original, publicKey: "not a public PEM" }, { ...original, privateKey: "private-sensitive-data" },
      { ...original, publicKey: "x".repeat(8193) }, { ...original, privateKey: "x".repeat(16385) },
      { ...original, created: -1 }, { ...original, created: 0.5 }, { ...original, created: Number.MAX_SAFE_INTEGER + 1 },
      { ...original, created: "now" }, { ...original, alg: "RS512" }, { ...original, alg: "RSA-OAEP-512" },
      { ...original, expired: Date.now() }, { ...original, expired: 0 }, { ...original, future: true }]) {
      await assert.rejects(storage.set(["signing:key", original.id], value), failure);
    }
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM issuer_keys").first("count"), 0);
    assert.deepEqual((await namespace.list()).keys, []);
  });

  test("persisted malformed records fail promptly through get, scan, and actual OpenAuth helpers", { timeout: 10_000 }, async () => {
    for (const purpose of purposes) {
      const record = fixtures[purpose];
      const invalid = ["not-json-with-private-detail", "null", "[]", "{}",
        JSON.stringify({ ...record, id: crypto.randomUUID() }), JSON.stringify({ ...record, expired: 0 }),
        JSON.stringify({ ...record, expired: Date.now() }), JSON.stringify({ ...record, future: true }),
        JSON.stringify({ ...record, alg: "RS512" }), JSON.stringify({ ...record, privateKey: "private-sensitive-data" }),
        JSON.stringify({ ...record, created: -1 })];
      for (const value of invalid) {
        await db.prepare("INSERT OR REPLACE INTO issuer_keys (purpose, key_id, value) VALUES (?, ?, ?)")
          .bind(purpose, record.id, value).run();
        await assert.rejects(storage.get([purpose, record.id]), failure);
        await assert.rejects(storage.get([purpose, crypto.randomUUID()]), failure);
        await assert.rejects(Array.fromAsync(storage.scan([purpose])), failure);
        await assert.rejects((purpose === "encryption:key" ? encryptionKeys : signingKeys)(storage), failure);
        assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM issuer_keys WHERE purpose = ?").bind(purpose).first("count"), 1);
      }
    }
    assert.deepEqual((await namespace.list()).keys, []);
  });

  test("reads do not cache valid key records over subsequent persisted corruption", async () => {
    const record = fixtures["signing:key"];
    const key = ["signing:key", record.id];
    await storage.set(key, record);
    assert.deepEqual(await storage.get(key), record);
    await db.prepare("UPDATE issuer_keys SET value = ? WHERE purpose = ?").bind("invalid-private-detail", key[0]).run();
    await assert.rejects(storage.get(key), failure);
    await assert.rejects(Array.fromAsync(storage.scan([key[0]])), failure);
    await assert.rejects(createIssuerStorage(db, namespace).get(key), failure);
  });

  test("key database failures expose only the generic storage error", async () => {
    await db.exec("CREATE TRIGGER reject_issuer_key BEFORE INSERT ON issuer_keys BEGIN SELECT RAISE(ABORT, 'private-storage-detail'); END;");
    try {
      const record = fixtures["signing:key"];
      await assert.rejects(storage.set(["signing:key", record.id], record), (error) => {
        assert.equal(error.message, failure.message);
        assert.equal(error.cause, undefined);
        return true;
      });
    } finally { await db.exec("DROP TRIGGER reject_issuer_key"); }
  });

  test("OAuth code storage accepts a 60-second expiry after a millisecond has elapsed", async () => {
    const key = ["oauth:code", "expiry-regression"];
    const value = { type: "user", properties: { id: "test-user" } };
    await storage.set(key, value, new Date(Date.now() + 59_999));
    assert.deepEqual(await createIssuerStorage(db, namespace).get(key), value);
  });

  test("OAuth code and refresh values keep KV TTL, scan, overwrite, and removal semantics", async () => {
    const beforeSeconds = Math.floor(Date.now() / 1000);
    const expiry = new Date(Date.now() + 180_000);
    const code = ["oauth:code", "test-code"];
    const refresh = ["oauth:refresh", "user:subject", "test-refresh"];
    const codeValue = { type: "user", properties: { id: "test-user" }, pkce: { challenge: "test-challenge" } };
    const refreshValue = { type: "user", properties: { id: "test-user" }, subject: "user:subject", clientID: "openauth-demo" };
    await storage.set(code, codeValue, expiry);
    await storage.set(refresh, refreshValue, expiry);
    const other = createIssuerStorage(db, namespace);
    assert.deepEqual(await other.get(code), codeValue);
    assert.deepEqual(await other.get(refresh), refreshValue);
    assert.deepEqual(await Array.fromAsync(other.scan(["oauth:code"])), [[code, codeValue]]);
    assert.deepEqual(await Array.fromAsync(other.scan(["oauth:refresh", "user:subject"])), [[refresh, refreshValue]]);
    const listed = await namespace.list();
    assert.equal(listed.keys.length, 2);
    assert.ok(listed.keys.every((key) => key.expiration >= beforeSeconds + 178 && key.expiration <= beforeSeconds + 182));
    await other.set(refresh, { ...refreshValue, timeUsed: 100 }, expiry);
    assert.equal((await storage.get(refresh)).timeUsed, 100);
    await other.remove(code);
    await other.remove(refresh);
    assert.equal(await storage.get(code), undefined);
    assert.deepEqual(await Array.fromAsync(storage.scan(["oauth:refresh"])), []);
    assert.deepEqual((await namespace.list()).keys, []);
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM issuer_keys").first("count"), 0);
  });

  for (const purpose of ["oauth:code", "oauth:refresh"]) {
    test(`${purpose} fails closed without exposing details when the user lookup fails`, async () => {
      const key = [purpose, "failed-user-lookup"];
      const value = { type: "user", properties: { id: "test-user" } };
      await storage.set(key, value, new Date(Date.now() + 180_000));
      assert.deepEqual(await storage.get(key), value);
      const failingDb = { prepare() { throw new Error("private-database-detail"); } };
      await assert.rejects(createIssuerStorage(failingDb, namespace).get(key), (error) => {
        assert.equal(error.message, "Unable to access authentication storage");
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.deepEqual(await storage.get(key), value, "lookup failure does not alter the stored grant");
    });

    test(`${purpose} grants stop after deletion and never follow an email to a new user`, async () => {
      const key = [purpose, "deleted-user-grant"];
      const value = { type: "user", properties: { id: "test-user", email: "grant@example.test" },
        subject: "test-user", clientID: "openauth-demo", pkce: { challenge: "keep-original-fields" }, ttl: { access: 3600 } };
      await storage.set(key, value, new Date(Date.now() + 180_000));
      assert.deepEqual(await storage.get(key), value);
      await db.prepare("DELETE FROM user WHERE id = ?").bind("test-user").run();
      assert.equal(await storage.get(key), undefined);
      assert.equal(await createIssuerStorage(db, namespace).get(key), undefined);
      await db.prepare("INSERT INTO user (id, email) VALUES (?, ?)").bind("replacement-user", "grant@example.test").run();
      assert.equal(await storage.get(key), undefined);
      // Cleanup can still see and remove residual records; get never deletes them.
      assert.deepEqual(await Array.fromAsync(storage.scan([purpose])), [[key, value]]);
      assert.equal((await namespace.list()).keys.length, 1);
      // An already in-flight request may write after deletion, but cannot renew again.
      await storage.set(key, { ...value, timeUsed: Date.now() }, new Date(Date.now() + 180_000));
      assert.equal(await storage.get(key), undefined);
      const replacement = { ...value, properties: { id: "replacement-user" } };
      await storage.set(key, replacement);
      assert.deepEqual(await storage.get(key), replacement);
      await storage.remove(key);
      assert.deepEqual(await Array.fromAsync(storage.scan([purpose])), []);
    });

    test(`${purpose} rejects malformed subject properties without trusting legacy subject or email`, async () => {
      const key = [purpose, "malformed-grant"];
      for (const value of [null, [], {}, { subject: "test-user" }, { type: "admin", properties: { id: "test-user" } },
        { type: "user" }, { type: "user", properties: null }, { type: "user", properties: { id: "" } },
        { type: "user", properties: { id: 1 } }, { type: "user", properties: { id: "x".repeat(256) } },
        { type: "user", properties: { email: "grant@example.test" } },
        { type: "user", properties: { id: "missing", email: "grant@example.test" }, subject: "test-user" }]) {
        await storage.set(key, value);
        assert.equal(await storage.get(key), undefined);
      }
    });
  }
});
