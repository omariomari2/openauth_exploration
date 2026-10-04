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
  // DELETE_GUARD_MUTATION=1 must make the three authorization tests fail.
  // This changes only the loaded test module, never the bundle on disk.
  if (process.env.DELETE_GUARD_MUTATION === "1") {
    const guard = `AND EXISTS (
      SELECT 1 FROM browser_sessions WHERE token_hash = ? AND user_id = user.id
        AND csrf_token = ? AND expires_at > unixepoch('subsec') * 1000
      )`;
    assert.equal(bundle.split(guard).length - 1, 1, "mutation must match exactly the DELETE guard");
    bundle = bundle.replace(guard, "AND (? IS NOT NULL AND ? IS NOT NULL)");
  }
  const contents = `
    import worker from "../dist/worker/index.js";
    export default { async fetch(request, env, ctx) {
      if (request.method !== "DELETE" || new URL(request.url).pathname !== "/api/account") {
        return worker.fetch(request, env, ctx);
      }
      const original = env.AUTH_DB;
      let sessionHash, snapshots = 0, changes = 0, failures = 0;
      function wrap(sql, statement) {
        const normalized = sql.replace(/\\s+/g, " ").trim();
        return new Proxy(statement, { get(target, property) {
          if (property === "bind") return (...args) => {
            if (normalized.includes("FROM browser_sessions WHERE token_hash = ? AND expires_at > ?")) sessionHash = args[0];
            return wrap(sql, target.bind(...args));
          };
          if (property === "first") return async (...args) => {
            if (${JSON.stringify(action)} === "fail" && normalized.startsWith("DELETE FROM user WHERE id = ?")) {
              failures++;
              throw new Error("injected-private-delete-error");
            }
            const row = await target.first(...args);
            if (normalized.startsWith("SELECT id, email, first_name AS firstName") && row && sessionHash && snapshots++ === 0) {
              const mutation = ${JSON.stringify(actions[action] ?? null)};
              if (mutation) changes += (await original.prepare(mutation + " WHERE token_hash = ? AND user_id = ?")
                .bind(sessionHash, row.id).run()).meta.changes;
            }
            return row; // Genuine authenticated snapshot, returned after the scheduling intervention.
          };
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
      for (const [name, value] of Object.entries({ snapshots, changes, failures })) response.headers.set("X-Test-" + name, String(value));
      return response;
    } };
  `;
  return [
    { type: "ESModule", path: path.resolve("test/account-deletion-revocation-entry.mjs"), contents },
    { type: "ESModule", path: bundlePath, contents: bundle },
  ];
}

async function signIn(app) {
  const client = createHttpClient(app.runtime);
  const login = await client.fetch("/login");
  assert.equal(login.status, 302);
  const authorization = await completeGoogleAuthorization(app, client, {
    sub: "deletion-revocation-user", email: "deletion-revocation@example.test", email_verified: true,
  }, login.headers.get("location"));
  assert.equal(authorization.status, 302);
  assert.equal((await client.fetch(authorization.headers.get("location"))).status, 303);
  const profile = await client.fetch("/api/profile");
  assert.equal(profile.status, 200);
  const tokenHash = createHash("sha256").update(client.cookies.get("__Host-openauth-session")).digest("hex");
  return { client, tokenHash, ...await profile.json() };
}

const removeAccount = (account) => account.client.fetch("/api/account", {
  method: "DELETE", headers: { Origin: ORIGIN, "X-CSRF-Token": account.csrfToken },
});

for (const action of Object.keys(actions)) {
  test(`DELETE rechecks its exact authenticated session before erasing the account: ${action}`, async () => {
    const app = await createTestApp({ modules: await testModules(action) });
    try {
      const first = await signIn(app);
      const other = await signIn(app);
      assert.equal(first.user.id, other.user.id);
      assert.notEqual(first.tokenHash, other.tokenHash);
      const survivor = await app.db.prepare("SELECT * FROM browser_sessions WHERE token_hash = ?").bind(other.tokenHash).first();
      const response = await removeAccount(first);
      assert.equal(response.headers.get("X-Test-snapshots"), "1", "initial authenticated profile read completed");
      assert.equal(response.headers.get("X-Test-changes"), "1", "only the selected session was changed");
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
      assert.deepEqual(response.headers.getSetCookie(), []);
      const changed = await app.db.prepare("SELECT expires_at, csrf_token FROM browser_sessions WHERE token_hash = ?")
        .bind(first.tokenHash).first();
      if (action === "revoke") assert.equal(changed, null);
      if (action === "expire") assert.equal(changed.expires_at, 0);
      if (action === "rotate CSRF") assert.notEqual(changed.csrf_token, first.csrfToken);
      assert.deepEqual(await app.db.prepare("SELECT * FROM browser_sessions WHERE token_hash = ?").bind(other.tokenHash).first(), survivor);
      const profile = await other.client.fetch("/api/profile");
      assert.equal(profile.status, 200);
      assert.deepEqual(await profile.json(), { user: other.user, csrfToken: other.csrfToken });
      app.fetchMock.assertNoPendingInterceptors();
    } finally { await app.dispose(); }
  });
}

test("a DELETE storage failure preserves the account, cascade rows, sessions, and browser cookies", async () => {
  const app = await createTestApp({ modules: await testModules("fail") });
  try {
    const account = await signIn(app);
    await app.db.batch([
      app.db.prepare("INSERT INTO user_sessions (user_id, session_token, expires_at) VALUES (?, ?, ?)")
        .bind(account.user.id, "deletion-failure-legacy-session", "2099-01-01 00:00:00"),
      app.db.prepare(`INSERT INTO user_addresses (user_id, type, first_name, last_name, address_line_1, city, state, postal_code)
        VALUES (?, 'shipping', 'Test', 'Person', '1 Test Street', 'Test City', 'IL', '00000')`).bind(account.user.id),
    ]);
    const tables = ["user", "user_identities", "browser_sessions", "user_sessions", "user_addresses"];
    const before = await Promise.all(tables.map(async (table) => (await app.db.prepare(`SELECT * FROM ${table}`).all()).results));
    const cookies = [...account.client.cookies];
    const response = await removeAccount(account);
    assert.equal(response.headers.get("X-Test-snapshots"), "1");
    assert.equal(response.headers.get("X-Test-failures"), "1", "failure was injected before DELETE executed");
    assert.equal(response.headers.get("X-Test-changes"), "0");
    assert.equal(response.status, 500);
    const failure = await response.json();
    assert.deepEqual(Object.keys(failure).sort(), ["error", "requestId"]);
    assert.equal(failure.error, "request_failed");
    assert.match(failure.requestId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    assert.deepEqual(response.headers.getSetCookie(), []);
    assert.deepEqual([...account.client.cookies], cookies);
    for (const [index, table] of tables.entries()) {
      assert.deepEqual((await app.db.prepare(`SELECT * FROM ${table}`).all()).results, before[index], table);
    }
    assert.equal((await account.client.fetch("/api/profile")).status, 200);
    app.fetchMock.assertNoPendingInterceptors();
  } finally { await app.dispose(); }
});
