import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createBrowserApp, signIn } from "../helpers/browser.mjs";

let app;
before(async () => { app = await createBrowserApp(); });
afterEach(() => { app.assertNoUnexpectedRequests(); });
after(async () => { await app?.dispose(); });

function googleProfile(name) {
  return { sub: `draft-${name}`, email: `draft-${name}@example.test`, email_verified: true,
    given_name: `First ${name}`, family_name: `Last ${name}` };
}

function responseFor(page, method) {
  return page.waitForResponse((response) => response.url() === `${app.origin}/api/profile` &&
    response.request().method() === method);
}

async function pollProfile(page) {
  const response = responseFor(page, "GET");
  await page.clock.fastForward(60_000);
  assert.equal((await response).status(), 200);
  await page.waitForFunction(() => !document.getElementById("profile-fields").disabled);
}

test("background validation preserves a dirty draft and its baseline so saving does not overwrite an untouched name", async () => {
  const profile = googleProfile("baseline");
  const client = await app.newClient(profile);
  try {
    const page = client.page;
    await page.clock.install();
    await signIn(app, profile, { client });
    await page.locator("#account").waitFor({ state: "visible" });
    const draft = "Locally edited first name";
    const remoteLastName = "Surname changed elsewhere";
    await page.locator("#first-name").fill(draft);
    await app.db.prepare("UPDATE user SET last_name = ? WHERE email = ?").bind(remoteLastName, profile.email).run();

    await pollProfile(page);
    assert.equal(await page.locator("#first-name").inputValue(), draft);
    assert.equal(await page.locator("#last-name").inputValue(), profile.family_name);
    const saveRequest = page.waitForRequest((request) => request.url() === `${app.origin}/api/profile` && request.method() === "PATCH");
    const saveResponse = responseFor(page, "PATCH");
    await page.locator("#save").click();
    assert.deepEqual((await saveRequest).postDataJSON(), { firstName: draft });
    assert.equal((await saveResponse).status(), 200);
    await page.getByText("Changes saved.", { exact: true }).waitFor();
    assert.deepEqual(await app.db.prepare("SELECT first_name AS firstName, last_name AS lastName FROM user WHERE email = ?")
      .bind(profile.email).first(), { firstName: draft, lastName: remoteLastName });
    assert.equal(await page.locator("#last-name").inputValue(), remoteLastName);
  } finally { await client.context.close(); }
});

for (const change of ["account", "session"]) {
  test(`background validation discards a dirty draft and deletion confirmation after another tab changes the ${change}`, async () => {
    const original = googleProfile(`${change}-original`);
    const replacement = change === "account" ? googleProfile("account-replacement") : original;
    const client = await app.newClient(original);
    try {
      const page = client.page;
      await page.clock.install();
      await signIn(app, original, { client });
      await page.locator("#account").waitFor({ state: "visible" });
      const originalId = await page.locator("#account-id").textContent();
      const priorSession = await app.db.prepare("SELECT csrf_token AS csrfToken FROM browser_sessions WHERE user_id = ?")
        .bind(originalId).first();
      const draft = `Unsaved ${change} draft`;
      await page.locator("#first-name").fill(draft);
      await page.locator("#delete-open").click();
      await page.locator("#delete-confirmation").waitFor({ state: "visible" });
      const mutations = [];
      page.on("request", (request) => {
        if (["PATCH", "DELETE", "POST"].includes(request.method())) mutations.push(request.method());
      });

      client.page = await client.newPage();
      await signIn(app, replacement, { client });
      await client.page.locator("#account").waitFor({ state: "visible" });
      const replacementId = await client.page.locator("#account-id").textContent();
      assert.equal(replacementId === originalId, change === "session");
      const nextSession = await app.db.prepare("SELECT csrf_token AS csrfToken FROM browser_sessions WHERE user_id = ?")
        .bind(replacementId).first();
      assert.equal(priorSession.csrfToken === nextSession.csrfToken, false, "real sign-in must establish a fresh CSRF token");
      // Both headless pages remain visible: this must exercise polling rather
      // than the separate hide/restore path that also discards private state.
      assert.equal(await page.evaluate(() => document.hidden), false);
      assert.equal(await page.locator("#first-name").inputValue(), draft);
      assert.equal(await page.locator("#delete-confirmation").isVisible(), true);

      await pollProfile(page);
      assert.equal(await page.locator("#email").textContent(), replacement.email);
      assert.equal(await page.locator("#account-id").textContent(), replacementId);
      assert.equal(await page.locator("#first-name").inputValue(), replacement.given_name);
      assert.equal(await page.locator("#last-name").inputValue(), replacement.family_name);
      assert.equal(await page.locator("#delete-confirmation").isVisible(), false);
      assert.equal(await page.locator("#delete-email").textContent(), "");
      await page.locator("#save").click();
      await page.getByText("No changes to save.", { exact: true }).waitFor();
      assert.deepEqual(mutations, [], "revalidation and an unchanged form must not save or delete either account");
      for (const profile of new Set([original, replacement])) {
        assert.deepEqual(await app.db.prepare("SELECT first_name AS firstName, last_name AS lastName FROM user WHERE email = ?")
          .bind(profile.email).first(), { firstName: profile.given_name, lastName: profile.family_name });
      }
    } finally { await client.context.close(); }
  });
}
