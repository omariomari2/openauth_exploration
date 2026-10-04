import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createBrowserApp, signIn } from "../helpers/browser.mjs";

test("an uncertain save locks the screen until reauthentication, even when the D1 write succeeded", async () => {
  const app = await createBrowserApp({ modules: [
    { type: "ESModule", path: path.resolve("test/browser/recovery-entry.mjs"), contents: `
      import worker from "../../dist/worker/index.js";
      export default { fetch(request, env, ctx) {
        if (request.method === "PATCH") {
          const database = env.AUTH_DB;
          function statement(sql, value) {
            return new Proxy(value, { get(target, property) {
              if (property === "bind") return (...args) => statement(sql, target.bind(...args));
              if (property === "first" && sql.trim().startsWith("UPDATE user SET")) {
                return async (...args) => { await target.first(...args); throw new Error("Simulated lost write acknowledgement"); };
              }
              const member = Reflect.get(target, property, target);
              return typeof member === "function" ? member.bind(target) : member;
            } });
          }
          env = { ...env, AUTH_DB: new Proxy(database, { get(target, property) {
            if (property === "prepare") return (sql) => statement(sql, target.prepare(sql));
            const member = Reflect.get(target, property, target);
            return typeof member === "function" ? member.bind(target) : member;
          } }) };
        }
        return worker.fetch(request, env, ctx);
      } };
    ` },
    { type: "ESModule", path: path.resolve("dist/worker/index.js") },
  ] });
  const profile = { sub: "uncertain-save", email: "uncertain-save@example.test", email_verified: true, given_name: "Before" };
  try {
    const client = await signIn(app, profile);
    const page = client.page;
    await page.locator("#account").waitFor({ state: "visible" });
    await page.clock.install();
    await page.getByLabel("First name", { exact: true }).fill("Actually saved");
    const failed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/profile" && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save changes" }).click();
    assert.equal((await failed).status(), 500);
    await page.getByText("We could not confirm the last action. Sign in again before making more changes.", { exact: true }).waitFor();
    assert.equal(await app.db.prepare("SELECT first_name FROM user WHERE email = ?").bind(profile.email).first("first_name"), "Actually saved");
    assert.equal(await page.locator("#account").isVisible(), false);
    assert.equal(await page.locator("#email").textContent(), "");
    assert.equal(await page.locator("#first-name").inputValue(), "");
    assert.equal(await page.locator("#retry").isVisible(), false);
    const afterFailure = client.requests.length;
    await page.clock.fastForward(120_000);
    assert.equal(client.requests.length, afterFailure, "no automatic recovery reads or mutation retries while locked");
    await page.getByRole("link", { name: "Continue with Google" }).click();
    await page.locator("#account").waitFor({ state: "visible" });
    assert.equal(await page.locator("#first-name").inputValue(), "Actually saved");
    assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"), 1);
    app.assertNoUnexpectedRequests();
  } finally { await app.dispose(); }
});
