import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createBrowserApp } from "../helpers/browser.mjs";

let app;
before(async () => { app = await createBrowserApp(); });
afterEach(() => { app.assertNoUnexpectedRequests(); });
after(async () => { await app?.dispose(); });
const alice = { sub: "ui-alice", email: "ui-alice@example.test", email_verified: true, given_name: "Alice", family_name: "Example" };

test("browser UI signs in, saves a private profile and signs out without retaining personal markup", async () => {
  const client = await app.newClient(alice);
  try {
    const errors = [];
    client.page.on("pageerror", (error) => errors.push(error.message));
    await client.page.goto(app.origin);
    await client.page.getByRole("link", { name: "Continue with Google" }).click();
    await client.page.locator("#account").waitFor({ state: "visible" });
    assert.equal(await client.page.locator("#email").textContent(), alice.email);
    await client.page.getByLabel("First name", { exact: true }).fill("Changed Alice");
    await client.page.getByRole("button", { name: "Save changes" }).click();
    await client.page.getByText("Changes saved.", { exact: true }).waitFor();
    assert.equal(await app.db.prepare("SELECT first_name FROM user WHERE email = ?").bind(alice.email).first("first_name"), "Changed Alice");
    await client.page.reload();
    await client.page.locator("#account").waitFor({ state: "visible" });
    assert.equal(await client.page.getByLabel("First name", { exact: true }).inputValue(), "Changed Alice");
    await client.page.getByRole("button", { name: "Sign out", exact: true }).click();
    await client.page.getByText("Signed out of this demo.", { exact: true }).waitFor();
    assert.equal(await client.page.locator("#account").isVisible(), false);
    assert.equal(await client.page.locator("#email").textContent(), "");
    assert.equal(await client.page.getByLabel("First name", { exact: true }).inputValue(), "");
    assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"), 0);
    assert.deepEqual(errors, []);
  } finally { await client.context.close(); }
});
