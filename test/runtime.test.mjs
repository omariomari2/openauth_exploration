import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { Miniflare } from "miniflare";
import { authorizationPath, ORIGIN } from "./helpers/worker.mjs";

let runtime;
let database;

before(async () => {
  runtime = new Miniflare({
    // Wrangler already bundled the dependency graph; workerd resolves its built-ins.
    modules: [{ type: "ESModule", path: path.resolve("dist/worker/index.js") }],
    compatibilityDate: "2025-10-08",
    compatibilityFlags: ["nodejs_compat"],
    kvNamespaces: ["AUTH_STORAGE"],
    d1Databases: ["AUTH_DB"],
    bindings: {
      GOOGLE_CLIENT_ID: "test-only-client",
      GOOGLE_CLIENT_SECRET: "test-only-secret",
      ISSUER_ORIGIN: ORIGIN,
    },
  });
  database = await runtime.getD1Database("AUTH_DB");
  const files = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(path.join("migrations", file), "utf8");
    // D1 exec accepts one statement per line, unlike migration files.
    await database.exec(sql.replace(/^--.*$/gm, "").replace(/\r?\n/g, " "));
  }
});

after(async () => {
  await runtime?.dispose();
});

test("the bundled Worker responds in workerd without cloud credentials", async () => {
  const response = await runtime.dispatchFetch("https://auth.example.test/", { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location"), ORIGIN).pathname, "/login");
});

test("the bundled OpenAuth issuer offers only Google login", async () => {
  const response = await runtime.dispatchFetch(
    new URL(authorizationPath(), ORIGIN),
    { redirect: "manual" },
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/google/authorize");
});

test("all existing migrations create usable isolated D1 tables", async () => {
  await database.prepare("INSERT INTO user (id, email) VALUES (?, ?)")
    .bind("runtime-user", "runtime@example.test").run();
  const user = await database.prepare("SELECT id, role FROM user WHERE id = ?")
    .bind("runtime-user").first();
  assert.deepEqual(user, { id: "runtime-user", role: "customer" });
  const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  for (const name of ["user", "user_addresses", "user_sessions"]) {
    assert.ok(tables.results.some((table) => table.name === name), `missing ${name}`);
  }
});

test("isolated KV bindings support OpenAuth storage operations", async () => {
  const storage = await runtime.getKVNamespace("AUTH_STORAGE");
  await storage.put("runtime-test", JSON.stringify({ ready: true }));
  assert.deepEqual(await storage.get("runtime-test", "json"), { ready: true });
  await storage.delete("runtime-test");
  assert.equal(await storage.get("runtime-test"), null);
});
