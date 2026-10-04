import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestApp, createHttpClient } from "./helpers/worker.mjs";

test("bundled issuer persists one D1 key per purpose and never puts key material in KV", async () => {
  const app = await createTestApp();
  try {
    const clients = Array.from({ length: 12 }, () => createHttpClient(app.runtime));
    const responses = await Promise.all(clients.map((client) => client.fetch("/google/authorize")));
    assert.ok(responses.every((response) => response.status === 302));
    const publicKeys = await Promise.all(clients.map(async (client) => {
      const response = await client.fetch("/.well-known/jwks.json");
      assert.equal(response.status, 200);
      return response.json();
    }));
    assert.ok(publicKeys.every(({ keys }) => keys.length === 1));
    assert.equal(new Set(publicKeys.map(({ keys }) => keys[0].kid)).size, 1);
    const rows = await app.db.prepare("SELECT purpose, key_id FROM issuer_keys ORDER BY purpose").all();
    assert.deepEqual(rows.results.map(({ purpose }) => purpose), ["encryption:key", "signing:key"]);
    assert.equal(rows.results[1].key_id, publicKeys[0].keys[0].kid);
    const namespace = await app.runtime.getKVNamespace("AUTH_STORAGE");
    assert.deepEqual((await namespace.list()).keys, []);
  } finally { await app.dispose(); }
});
