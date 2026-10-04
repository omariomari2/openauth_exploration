import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { ORIGIN, completeGoogleAuthorization, createHttpClient, createTestApp } from "./helpers/worker.mjs";

const bundlePath = path.resolve("dist/worker/index.js");
const actions = {
  revoke: "DELETE FROM browser_sessions",
  expire: "UPDATE browser_sessions SET expires_at = 0",
  "rotate CSRF": "UPDATE browser_sessions SET csrf_token = " +
    "(CASE WHEN substr(csrf_token, 1, 1) = 'A' THEN 'B' ELSE 'A' END) || substr(csrf_token, 2)",
};

async function testModules(action) {
  let bundle = await readFile(bundlePath, "utf8");
  // Run with PROFILE_GUARD_MUTATION=1 to prove these assertions fail without
  // write-time authorization. Only the in-memory test module is changed.
  if (process.env.PROFILE_GUARD_MUTATION === "1") {
    const guard = `AND EXISTS (SELECT 1 FROM browser_sessions
        WHERE token_hash = ? AND user_id = user.id AND csrf_token = ?
          AND expires_at > unixepoch('subsec') * 1000)`;
    assert.equal(bundle.split(guard).length - 1, 1, "mutation must match exactly the PATCH guard");
    // Keep the two bind placeholders, but remove their authorization semantics.
    bundle = bundle.replace(guard, "AND (? IS NOT NULL AND ? IS NOT NULL)");
  }
  const contents = `
    import worker from "../dist/worker/index.js";
    export default {
      async fetch(request, env, ctx) {
        if (request.method !== "PATCH" || new URL(request.url).pathname !== "/api/profile") {
          return worker.fetch(request, env, ctx);
        }
        const original = env.AUTH_DB;
        let sessionHash;
        let changes = 0;
        let snapshots = 0;
        function wrap(sql, statement) {
          const normalized = sql.replace(/\\s+/g, " ").trim();
          return new Proxy(statement, { get(target, property) {
            if (property === "bind") return (...args) => {
              if (normalized.includes("FROM browser_sessions WHERE token_hash = ? AND expires_at > ?")) {
                sessionHash = args[0];
              }
              return wrap(sql, target.bind(...args));
            };
            if (property === "first" && normalized.startsWith("SELECT id, email, first_name AS firstName")) {
              return async (...args) => {
                const profile = await target.first(...args);
                if (profile && sessionHash && snapshots++ === 0) {
                  const result = await original.prepare(${JSON.stringify(actions[action] + " WHERE token_hash = ? AND user_id = ?")})
                    .bind(sessionHash, profile.id).run();
                  changes += result.meta.changes;
                }
                // Return the genuine saved snapshot, after the session changed.
                return profile;
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
        response.headers.set("X-Test-Session-Changes", String(changes));
        response.headers.set("X-Test-Profile-Snapshots", String(snapshots));
        return response;
      }
    };
  `;
  return [
    { type: "ESModule", path: path.resolve("test/profile-revocation-entry.mjs"), contents },
    { type: "ESModule", path: bundlePath, contents: bundle },
  ];
}

async function signIn(app) {
  const client = createHttpClient(app.runtime);
  const login = await client.fetch("/login");
  assert.equal(login.status, 302);
  const authorization = await completeGoogleAuthorization(app, client, {
    sub: "profile-revocation-user", email: "profile-revocation@example.test", email_verified: true,
    given_name: "Original", family_name: "Name",
  }, login.headers.get("location"));
  assert.equal(authorization.status, 302);
  assert.equal((await client.fetch(authorization.headers.get("location"))).status, 303);
  const response = await client.fetch("/api/profile");
  assert.equal(response.status, 200);
  const tokenHash = createHash("sha256").update(client.cookies.get("__Host-openauth-session")).digest("hex");
  return { client, tokenHash, ...await response.json() };
}

for (const action of Object.keys(actions)) {
  test(`PATCH cannot write when its authenticated session changes before the update: ${action}`, async () => {
    const app = await createTestApp({ modules: await testModules(action) });
    try {
      const first = await signIn(app);
      const other = await signIn(app);
      assert.equal(first.user.id, other.user.id);
      assert.notEqual(first.tokenHash, other.tokenHash);
      assert.equal(await app.db.prepare("SELECT COUNT(*) FROM browser_sessions WHERE user_id = ?")
        .bind(first.user.id).first("COUNT(*)"), 2);
      const response = await first.client.fetch("/api/profile", {
        method: "PATCH", headers: { Origin: ORIGIN, "X-CSRF-Token": first.csrfToken, "Content-Type": "application/json" },
        body: JSON.stringify({ firstName: "MustNotWrite" }),
      });
      assert.equal(response.headers.get("X-Test-Profile-Snapshots"), "1", "handler already read the authenticated profile");
      assert.equal(response.headers.get("X-Test-Session-Changes"), "1", "exactly the selected session changed");
      const changed = await app.db.prepare("SELECT expires_at, csrf_token FROM browser_sessions WHERE token_hash = ?")
        .bind(first.tokenHash).first();
      if (action === "revoke") assert.equal(changed, null);
      if (action === "expire") assert.equal(changed.expires_at, 0);
      if (action === "rotate CSRF") assert.notEqual(changed.csrf_token, first.csrfToken);
      const survivor = await app.db.prepare("SELECT expires_at, csrf_token FROM browser_sessions WHERE token_hash = ?")
        .bind(other.tokenHash).first();
      assert.ok(survivor.expires_at > Date.now());
      assert.equal(survivor.csrf_token, other.csrfToken);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
      assert.equal(await app.db.prepare("SELECT first_name FROM user WHERE id = ?").bind(first.user.id).first("first_name"), "Original");
      const profile = await other.client.fetch("/api/profile");
      assert.equal(profile.status, 200);
      assert.deepEqual(await profile.json(), { user: other.user, csrfToken: other.csrfToken });
      app.fetchMock.assertNoPendingInterceptors();
    } finally { await app.dispose(); }
  });
}
