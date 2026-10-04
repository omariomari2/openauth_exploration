import { joinKey, splitKey, type StorageAdapter } from "@openauthjs/openauth/storage/storage";

function storageError(): Error {
  return new Error("Unable to access authentication storage");
}

function unwrap(raw: string | null) {
  if (raw === null) return undefined;
  try {
    const envelope = JSON.parse(raw);
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope) ||
      Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, "value") || !Object.hasOwn(envelope, "expiresAt")) {
      return undefined;
    }
    if (envelope.expiresAt !== null &&
      (!Number.isSafeInteger(envelope.expiresAt) || Date.now() >= envelope.expiresAt)) return undefined;
    return envelope.value;
  } catch { return undefined; }
}

// Fresh dedicated namespaces only: raw legacy values are intentionally not accepted.
// This preserves logical expiry, not atomic consumption or global KV consistency.
export function createExpiringKvStorage(namespace: KVNamespace): StorageAdapter {
  async function read(key: string) {
    try {
      // Evaluate expiry after the awaited read; never delete a potentially replaced value.
      return unwrap(await namespace.get(key, "text"));
    } catch { throw storageError(); }
  }
  return {
    async get(key) {
      try { return await read(joinKey(key)); }
      catch { throw storageError(); }
    },
    async set(key, value, expiry) {
      try {
        const expiresAt = expiry === undefined ? null : expiry instanceof Date ? expiry.getTime() : NaN;
        if (expiresAt !== null && !Number.isSafeInteger(expiresAt)) throw storageError();
        const serialized = JSON.stringify({ value, expiresAt });
        if (!Object.hasOwn(JSON.parse(serialized), "value")) throw storageError();
        // Both KV expiration methods require at least 60 seconds of physical retention.
        // https://developers.cloudflare.com/kv/api/write-key-value-pairs/#expiring-keys
        const expirationTtl = expiresAt === null ? undefined : Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000));
        await namespace.put(joinKey(key), serialized, { expirationTtl });
      } catch { throw storageError(); }
    },
    async remove(key) {
      try { await namespace.delete(joinKey(key)); }
      catch { throw storageError(); }
    },
    async *scan(prefix) {
      try {
        let cursor: string | undefined;
        while (true) {
          const page = await namespace.list({ prefix: joinKey([...prefix, ""]), cursor });
          for (const key of page.keys) {
            const value = await read(key.name);
            if (value !== undefined) yield [splitKey(key.name), value];
          }
          if (page.list_complete) break;
          cursor = page.cursor;
        }
      } catch { throw storageError(); }
    },
  };
}
