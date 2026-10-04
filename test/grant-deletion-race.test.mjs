import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { joinKey } from "@openauthjs/openauth/storage/storage";
import { CLIENT_ID, ORIGIN, VERIFIER, completeGoogleAuthorization, createHttpClient, createTestApp } from "./helpers/worker.mjs";

const bundlePath = path.resolve("dist/worker/index.js");
const REFRESH_TTL = 3600;

async function testModules() {
  let bundle = await readFile(bundlePath, "utf8");
  // Mutation check only: disable the existence decision in memory, never on disk.
  if (process.env.GRANT_GUARD_MUTATION === "1") {
    const guard = "return user ? value2 : void 0;";
    assert.equal(bundle.split(guard).length - 1, 1, "mutation must match exactly the grant guard");
    bundle = bundle.replace(guard, "return value2;");
  }
  const contents = `
    import worker from "../dist/worker/index.js";
    export default { async fetch(request, env, ctx) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/token" ||
          request.headers.get("X-Test-Delete-On-Grant-Read") !== "1") return worker.fetch(request, env, ctx);
      const original = env.AUTH_DB;
      let snapshots = 0;
      let changes = 0;
      function wrap(sql, statement) {
        return new Proxy(statement, { get(target, property) {
          if (property === "bind") return (...args) => wrap(sql, target.bind(...args));
          if (property === "first" && sql.replace(/\\s+/g, " ").trim() === "SELECT id FROM user WHERE id = ?") {
            return async (...args) => {
              const user = await target.first(...args);
              if (user && snapshots++ === 0) {
                const deleted = await original.prepare("DELETE FROM user WHERE id = ? RETURNING id").bind(user.id).first();
                if (deleted?.id === user.id) changes++;
              }
              return user; // Genuine saved row; only the deletion timing is controlled.
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      }
      const database = new Proxy(original, { get(target, property) {
        if (property === "prepare") return (sql) => wrap(sql, target.prepare(sql));
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const response = await worker.fetch(request, { ...env, AUTH_DB: database }, ctx);
      response.headers.set("X-Test-Grant-Snapshots", String(snapshots));
      response.headers.set("X-Test-User-Deletions", String(changes));
      return response;
    } };
  `;
  return [
    { type: "ESModule", path: path.resolve("test/grant-deletion-race-entry.mjs"), contents },
    { type: "ESModule", path: bundlePath, contents: bundle },
  ];
}

for (const grantType of ["authorization_code", "refresh_token"]) {
  test(`in-flight ${grantType} after deletion cannot access a profile or renew its bounded residual record`, async () => {
    const app = await createTestApp({ modules: await testModules() });
    try {
      const client = createHttpClient(app.runtime);
      const authorization = await completeGoogleAuthorization(app, client, {
        sub: "grant-deletion-race", email: "grant-deletion-race@example.test", email_verified: true,
      });
      assert.equal(authorization.status, 302);
      const userId = await app.db.prepare("SELECT id FROM user WHERE email = ?").bind("grant-deletion-race@example.test").first("id");
      const code = new URL(authorization.headers.get("location")).searchParams.get("code");
      let form = { grant_type: "authorization_code", client_id: CLIENT_ID,
        redirect_uri: `${ORIGIN}/callback`, code, code_verifier: VERIFIER };
      if (grantType === "refresh_token") {
        const initial = await client.fetch("/token", { method: "POST", body: new URLSearchParams(form) });
        assert.equal(initial.status, 200);
        form = { grant_type: grantType, client_id: CLIENT_ID, refresh_token: (await initial.json()).refresh_token };
      }
      const before = Date.now();
      const response = await client.fetch("/token", { method: "POST", body: new URLSearchParams(form),
        headers: { "X-Test-Delete-On-Grant-Read": "1" } });
      const after = Date.now();
      assert.equal(response.headers.get("X-Test-Grant-Snapshots"), "1");
      assert.equal(response.headers.get("X-Test-User-Deletions"), "1");
      assert.equal(response.status, 200, "the already-authorized in-flight grant may complete");
      const tokens = await response.json();
      assert.equal(await app.db.prepare("SELECT id FROM user WHERE id = ?").bind(userId).first("id"), null);
      const profile = await client.fetch("/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      assert.equal(profile.status, 401);
      assert.deepEqual(await profile.json(), { error: "unauthorized" });

      // OpenAuth 0.4.3 generates subject:token and Storage.set uses an absolute TTL.
      // Installed source: @openauthjs/openauth/dist/esm/{issuer,storage/storage}.js.
      const pieces = tokens.refresh_token.split(":");
      const key = joinKey(["oauth:refresh", pieces.slice(0, -1).join(":"), pieces.at(-1)]);
      const namespace = await app.runtime.getKVNamespace("AUTH_STORAGE");
      const envelope = await namespace.get(key, "json");
      assert.equal(envelope.value.properties.id, userId);
      assert.equal(envelope.value.ttl.refresh, REFRESH_TTL);
      assert.ok(envelope.expiresAt >= before + REFRESH_TTL * 1000 && envelope.expiresAt <= after + REFRESH_TTL * 1000);
      const listed = await namespace.list();
      assert.equal(listed.keys.length, 1, "only the final in-flight refresh record remains");
      assert.equal(listed.keys[0].name, key);
      assert.ok(listed.keys[0].expiration >= Math.floor(before / 1000) + REFRESH_TTL &&
        listed.keys[0].expiration <= Math.ceil(after / 1000) + REFRESH_TTL);
      const renewed = await client.fetch("/token", { method: "POST", body: new URLSearchParams({
        grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: tokens.refresh_token,
      }) });
      assert.equal(renewed.status, 400);
      assert.equal((await renewed.json()).error, "invalid_grant");
      assert.deepEqual(await namespace.get(key, "json"), envelope, "rejected renewal neither extends nor erases retention");
      assert.deepEqual((await namespace.list()).keys, listed.keys);
      app.fetchMock.assertNoPendingInterceptors();
    } finally { await app.dispose(); }
  });
}
