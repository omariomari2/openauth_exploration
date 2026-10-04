import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { Miniflare } from "miniflare";
import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import { joinKey } from "@openauthjs/openauth/storage/storage";
import { createExpiringKvStorage } from "../src/expiring-kv-storage.ts";

const failure = { message: "Unable to access authentication storage" };

describe("expiring authentication storage with real isolated KV", () => {
  let runtime;
  let namespace;
  let storage;

  before(async () => {
    runtime = new Miniflare({
      modules: true, script: "export default { fetch() { return new Response('KV expiry tests'); } };",
      compatibilityDate: "2025-10-08", kvNamespaces: ["AUTH_STORAGE"],
    });
    namespace = await runtime.getKVNamespace("AUTH_STORAGE");
  });
  beforeEach(async () => {
    for (const key of (await namespace.list()).keys) await namespace.delete(key.name);
    storage = createExpiringKvStorage(namespace);
  });
  after(async () => { await runtime?.dispose(); });

  test("the installed adapter reproduces the real KV rejection at 59,999 milliseconds", async () => {
    await assert.rejects(CloudflareStorage({ namespace }).set(["oauth:code", "upstream-reproduction"],
      { subject: "test-user" }, new Date(Date.now() + 59_999)), /Expiration TTL must be at least 60/);
  });

  test("a 59,999 millisecond lifetime stores for 60 seconds but expires at the original exact millisecond", async (t) => {
    let now = Date.now();
    const initial = now;
    t.mock.method(Date, "now", () => now);
    const key = ["oauth:code", "short-lived"];
    const value = { subject: "test-user" };
    const expiresAt = now + 59_999;
    await assert.doesNotReject(storage.set(key, value, new Date(expiresAt)));
    assert.deepEqual(await namespace.get(joinKey(key), "json"), { value, expiresAt });
    const physical = (await namespace.list()).keys[0].expiration;
    assert.ok(physical >= Math.floor(initial / 1000) + 60 && physical <= Math.floor(initial / 1000) + 62);
    now = expiresAt - 1;
    assert.deepEqual(await storage.get(key), value);
    now = expiresAt;
    assert.equal(await storage.get(key), undefined);
    assert.deepEqual(await Array.fromAsync(storage.scan(["oauth:code"])), []);
    assert.ok(await namespace.get(joinKey(key))); // Logical expiry never deletes physical data on a read.
  });

  test("longer fractional lifetimes round physical TTL upward while retaining their exact expiry", async (t) => {
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    const key = ["oauth:code", "longer-lived"];
    await storage.set(key, { valid: true }, new Date(now + 60_001));
    const physical = (await namespace.list()).keys[0].expiration;
    assert.ok(physical >= Math.floor(now / 1000) + 61 && physical <= Math.floor(now / 1000) + 63);
    assert.equal((await namespace.get(joinKey(key), "json")).expiresAt, now + 60_001);
  });

  test("missing expiry stays explicit null and get, overwrite, remove, and prefix boundaries are preserved", async () => {
    const key = ["oauth:refresh", "user:subject", "token"];
    assert.equal(await storage.get(key), undefined);
    await storage.set(key, { version: 1 });
    await storage.set(["oauth:refresh-extra", "ignored"], { unrelated: true });
    const independent = createExpiringKvStorage(namespace);
    assert.deepEqual(await independent.get(key), { version: 1 });
    assert.deepEqual(await namespace.get(joinKey(key), "json"), { value: { version: 1 }, expiresAt: null });
    assert.equal((await namespace.list()).keys.find((entry) => entry.name === joinKey(key)).expiration, undefined);
    await independent.set(key, { version: 2 });
    assert.deepEqual(await Array.fromAsync(storage.scan(["oauth:refresh", "user:subject"])), [[key, { version: 2 }]]);
    assert.deepEqual(await Array.fromAsync(storage.scan(["oauth:refresh"])), [[key, { version: 2 }]]);
    await independent.remove(key);
    assert.equal(await storage.get(key), undefined);
    assert.deepEqual(await Array.fromAsync(storage.scan(["oauth:refresh"])), []);
  });

  test("an already-expired write replaces a live value with an immediately unusable envelope", async (t) => {
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    const key = ["oauth:code", "overwrite-expired"];
    await storage.set(key, { version: "live" }, new Date(now + 120_000));
    await storage.set(key, { version: "expired" }, new Date(now - 1));
    assert.equal(await storage.get(key), undefined);
    assert.deepEqual(await namespace.get(joinKey(key), "json"), { value: { version: "expired" }, expiresAt: now - 1 });
    assert.ok((await namespace.list()).keys[0].expiration);
  });

  test("invalid expiry dates fail before writing a value", async () => {
    for (const expiry of [new Date(NaN), new Date(Infinity), null, 123, "tomorrow", { getTime: () => Date.now() }]) {
      await assert.rejects(storage.set(["oauth:code", "invalid-expiry"], { valid: true }, expiry), failure);
    }
    assert.deepEqual((await namespace.list()).keys, []);
  });

  test("malformed or legacy records fail closed in both get and scan", async () => {
    const invalid = ["broken-json-private-detail", "null", "[]", "{}", '{"subject":"legacy"}',
      '{"expiresAt":null}', '{"value":{}}', '{"value":{},"expiresAt":"never"}',
      '{"value":{},"expiresAt":false}', '{"value":{},"expiresAt":1e400}',
      '{"value":{},"expiresAt":9007199254740992}', '{"value":{},"expiresAt":1.5}',
      '{"value":{},"expiresAt":null,"unknown":true}'];
    for (let index = 0; index < invalid.length; index++) {
      const key = ["oauth:code", `invalid-${index}`];
      await namespace.put(joinKey(key), invalid[index]);
      assert.equal(await storage.get(key), undefined);
    }
    await namespace.put(joinKey(["oauth:code", "epoch-expired"]), '{"value":{},"expiresAt":0}');
    assert.equal(await storage.get(["oauth:code", "epoch-expired"]), undefined);
    assert.deepEqual(await Array.fromAsync(storage.scan(["oauth:code"])), []);
    assert.equal((await namespace.list()).keys.length, invalid.length + 1);
  });

  test("reads check expiry after KV finishes, so an in-flight value cannot cross the boundary", async (t) => {
    let now = Date.now();
    const expiresAt = now + 10;
    t.mock.method(Date, "now", () => now);
    const key = ["oauth:code", "delayed-read"];
    await storage.set(key, { valid: true }, new Date(expiresAt));
    const delayed = createExpiringKvStorage({
      get: async (...args) => { const result = await namespace.get(...args); now = expiresAt; return result; },
    });
    assert.equal(await delayed.get(key), undefined);
  });

  test("scan reads use a fresh clock for every value", async (t) => {
    let now = Date.now();
    const expiresAt = now + 10;
    t.mock.method(Date, "now", () => now);
    await storage.set(["oauth:code", "first"], { index: 1 }, new Date(expiresAt));
    await storage.set(["oauth:code", "second"], { index: 2 }, new Date(expiresAt));
    let reads = 0;
    const delayed = createExpiringKvStorage({
      list: (...args) => namespace.list(...args),
      get: async (...args) => { const result = await namespace.get(...args); if (++reads === 2) now = expiresAt; return result; },
    });
    assert.deepEqual(await Array.fromAsync(delayed.scan(["oauth:code"])), [[["oauth:code", "first"], { index: 1 }]]);
  });

  test("scan continues through an empty page and a page containing only expired values", async () => {
    await storage.set(["oauth:code", "a-expired"], { expired: true }, new Date(0));
    await storage.set(["oauth:code", "b-live"], { index: 1 });
    await storage.set(["oauth:code", "c-live"], { index: 2 });
    let pages = 0;
    const paginated = createExpiringKvStorage({
      get: (...args) => namespace.get(...args),
      list: async ({ prefix, cursor }) => {
        pages++;
        if (cursor === undefined) return { keys: [], list_complete: false, cursor: "empty-page" };
        return namespace.list({ prefix, limit: 1, cursor: cursor === "empty-page" ? undefined : cursor });
      },
    });
    assert.deepEqual(await Array.fromAsync(paginated.scan(["oauth:code"])), [
      [["oauth:code", "b-live"], { index: 1 }], [["oauth:code", "c-live"], { index: 2 }],
    ]);
    assert.ok(pages >= 4);
  });

  test("an expired read cannot delete a concurrently replaced live value", async () => {
    const key = ["oauth:code", "replaced"];
    await storage.set(key, { version: "expired" }, new Date(0));
    const delayed = createExpiringKvStorage({
      get: async (...args) => {
        const stale = await namespace.get(...args);
        await storage.set(key, { version: "replacement" });
        return stale;
      },
      delete: (...args) => namespace.delete(...args),
    });
    assert.equal(await delayed.get(key), undefined);
    assert.deepEqual(await storage.get(key), { version: "replacement" });
  });

  test("storage and serialization errors contain neither secret key names nor values", async () => {
    const error = () => { throw new Error("secret-key-and-value-provider-detail"); };
    const broken = createExpiringKvStorage({ get: error, put: error, delete: error, list: error });
    const key = ["oauth:code", "secret-code"];
    for (const operation of [() => broken.get(key), () => broken.set(key, { secret: "value" }),
      () => broken.remove(key), () => Array.fromAsync(broken.scan(["oauth:code"]))]) {
      await assert.rejects(operation(), (caught) => {
        assert.equal(caught.message, failure.message);
        assert.equal(caught.cause, undefined);
        return true;
      });
    }
    const cyclic = {};
    cyclic.self = cyclic;
    for (const value of [cyclic, undefined, 1n]) await assert.rejects(storage.set(key, value), failure);
  });
});
