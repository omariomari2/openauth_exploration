import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createBrowserApp, signIn } from "../helpers/browser.mjs";

let app;
before(async () => { app = await createBrowserApp(); });
afterEach(() => { app.assertNoUnexpectedRequests(); });
after(async () => { await app?.dispose(); });

function profile(name) {
  return { sub: `lifecycle-${name}`, email: `lifecycle-${name}@example.test`, email_verified: true,
    given_name: `Private ${name}`, family_name: "Lifecycle" };
}

async function waitForProfile(page, expected) {
  await page.locator("#account").waitFor({ state: "visible" });
  assert.equal(await page.locator("#email").textContent(), expected.email);
}

async function observePagehide(page) {
  // Installed after the app initializes, this observer reads the DOM after its
  // real pagehide handler runs. The synchronous witness survives document
  // teardown and stores only flags/public status, never credentials or PII.
  await page.evaluate(() => {
    window.addEventListener("pagehide", (event) => {
      sessionStorage.setItem("test-pagehide", JSON.stringify({
        trusted: event.isTrusted, persisted: event.persisted,
        cleared: ["email", "account-id", "delete-email"].every((id) => document.getElementById(id).textContent === "") &&
          ["first-name", "last-name"].every((id) => document.getElementById(id).value === ""),
        hidden: document.getElementById("account").hidden && document.getElementById("delete-confirmation").hidden,
        disabled: ["profile-fields", "logout", "delete-open", "delete-confirm"].every((id) => document.getElementById(id).disabled),
        status: document.getElementById("status").textContent,
      }));
    });
  });
}

async function pagehideWitness(page) {
  const witness = await page.evaluate(() => {
    const value = sessionStorage.getItem("test-pagehide");
    sessionStorage.removeItem("test-pagehide");
    return JSON.parse(value);
  });
  assert.ok(witness, "the old document synchronously recorded its pagehide event");
  assert.equal(witness.trusted, true);
  assert.equal(witness.cleared, true);
  assert.equal(witness.hidden, true);
  assert.equal(witness.disabled, true);
  return witness;
}

test("trusted pagehide clears private DOM and deletion confirmation before navigation, and return revalidates", { timeout: 20000 }, async (t) => {
  const expected = profile("pagehide");
  const client = await signIn(app, expected);
  try {
    const page = client.page;
    await waitForProfile(page, expected);
    await page.locator("#delete-open").click();
    await page.locator("#delete-confirmation").waitFor({ state: "visible" });
    await observePagehide(page);
    await page.goto(`${app.origin}/assets/demo.css`);
    const hidden = await pagehideWitness(page);
    t.diagnostic(`Observed real pagehide; persisted=${hidden.persisted}. No BFCache restoration claim.`);
    await app.db.prepare("UPDATE user SET first_name = ? WHERE email = ?").bind("Updated while away", expected.email).run();
    const refreshed = page.waitForResponse((response) => response.url() === `${app.origin}/api/profile`);
    await page.goBack();
    assert.equal((await refreshed).status(), 200);
    await waitForProfile(page, expected);
    assert.equal(await page.locator("#first-name").inputValue(), "Updated while away");
    assert.equal(await page.locator("#delete-confirmation").isVisible(), false);
  } finally { await client.context.close(); }
});

test("trusted pagehide locks a pending save even after the real D1 write has succeeded", { timeout: 20000 }, async (t) => {
  const expected = profile("pending-save");
  const client = await signIn(app, expected);
  const ready = Promise.withResolvers();
  const release = Promise.withResolvers();
  const page = client.page;
  try {
    await waitForProfile(page, expected);
    await observePagehide(page);
    await page.route(`${app.origin}/api/profile`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      // Execute the unchanged authenticated request against the real Worker;
      // hold only delivery of its actual response to the old document.
      const response = await route.fetch();
      ready.resolve(response.status());
      await release.promise;
      await route.fulfill({ response });
    });
    await page.locator("#first-name").fill("Saved before leaving");
    await page.getByRole("button", { name: "Save changes" }).click();
    assert.equal(await ready.promise, 200);
    assert.equal(await page.locator("#status").textContent(), "Saving changes…");
    assert.equal(await app.db.prepare("SELECT first_name FROM user WHERE email = ?").bind(expected.email).first("first_name"), "Saved before leaving");
    await page.goto(`${app.origin}/assets/demo.css`);
    const hidden = await pagehideWitness(page);
    assert.equal(hidden.status, "We could not confirm the last action. Sign in again before making more changes.");
    t.diagnostic(`Pending save observed at trusted pagehide; persisted=${hidden.persisted}. A destroyed document does not prove late-response or BFCache behavior.`);
    release.resolve();
    await page.unrouteAll({ behavior: "wait" });
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: "wait" });
    await client.context.close();
  }
});
