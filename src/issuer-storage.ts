import { createExpiringKvStorage } from "./expiring-kv-storage.ts";
import type { StorageAdapter } from "@openauthjs/openauth/storage/storage";
import * as v from "valibot";

const algorithms = { "encryption:key": "RSA-OAEP-512", "signing:key": "ES256" } as const;
type Purpose = keyof typeof algorithms;
const idSchema = v.pipe(v.string(), v.uuid());
const keySchema = v.strictObject({
  id: idSchema,
  publicKey: v.pipe(v.string(), v.maxLength(8192),
    v.regex(/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----(?:\r?\n)?$/)),
  privateKey: v.pipe(v.string(), v.maxLength(16_384),
    v.regex(/^-----BEGIN PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PRIVATE KEY-----(?:\r?\n)?$/)),
  created: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  alg: v.picklist(["RSA-OAEP-512", "ES256"]),
});

function invalidKey(): Error {
  return new Error("Unable to access issuer keys");
}

function route(key: string[], scan = false): Purpose | "kv" | "legacy" {
  if (!Array.isArray(key) || key.length === 0 || key.some((part) => typeof part !== "string")) throw invalidKey();
  const purpose = key[0];
  if (purpose === "oauth:code" || purpose === "oauth:refresh") return "kv";
  if (purpose !== "encryption:key" && purpose !== "signing:key" && purpose !== "oauth:key") throw invalidKey();
  if (scan ? key.length !== 1 : key.length !== 2 || !v.is(idSchema, key[1])) throw invalidKey();
  return purpose === "oauth:key" ? "legacy" : purpose;
}

function parseKey(purpose: Purpose, id: string, value: unknown) {
  const result = v.safeParse(keySchema, value);
  if (!result.success || result.output.id !== id || result.output.alg !== algorithms[purpose]) throw invalidKey();
  return result.output;
}

// Pinned to OpenAuth 0.4.3's serialized keys and post-set re-scan contract.
// This fresh, dedicated demo deliberately ignores legacy oauth:key KV entries.
// Keys cannot expire, rotate, or be removed through this adapter; future formats fail closed.
export function createIssuerStorage(db: D1Database, namespace: KVNamespace): StorageAdapter {
  const kv = createExpiringKvStorage(namespace);
  async function read(purpose: Purpose) {
    try {
      // Direct D1 calls use the primary; no Sessions API or cached reads.
      // https://developers.cloudflare.com/d1/best-practices/read-replication/
      const row = await db.prepare("SELECT key_id, value FROM issuer_keys WHERE purpose = ?")
        .bind(purpose).first<{ key_id: string; value: string }>();
      return row ? parseKey(purpose, row.key_id, JSON.parse(row.value)) : undefined;
    } catch { throw invalidKey(); }
  }
  return {
    async get(key) {
      const purpose = route(key);
      if (purpose === "kv") return kv.get(key);
      if (purpose === "legacy") return undefined;
      const value = await read(purpose);
      return value?.id === key[1] ? value : undefined;
    },
    async set(key, value, expiry) {
      const purpose = route(key);
      if (purpose === "kv") return kv.set(key, value, expiry);
      if (purpose === "legacy" || expiry !== undefined) throw invalidKey();
      try {
        const record = parseKey(purpose, key[1], value);
        // Losing candidates succeed without replacing the winner. OpenAuth then re-scans.
        await db.prepare("INSERT INTO issuer_keys (purpose, key_id, value) VALUES (?, ?, ?) ON CONFLICT(purpose) DO NOTHING")
          .bind(purpose, record.id, JSON.stringify(record)).run();
      } catch { throw invalidKey(); }
    },
    async remove(key) {
      if (route(key) !== "kv") throw invalidKey();
      return kv.remove(key);
    },
    async *scan(prefix) {
      const purpose = route(prefix, true);
      if (purpose === "kv") { yield* kv.scan(prefix); return; }
      if (purpose === "legacy") return;
      const value = await read(purpose);
      if (value) yield [[purpose, value.id], value];
    },
  };
}
