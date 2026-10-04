import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createBrowserApp, signIn } from "../helpers/browser.mjs";

let app;
before(async () => { app = await createBrowserApp(); });
afterEach(() => { app.assertNoUnexpectedRequests(); });
after(async () => { await app?.dispose(); });

function googleProfile(name, extra = {}) {
  return { sub: `safety-${name}`, email: `safety-${name}@example.test`, email_verified: true,
    given_name: `Safety ${name}`, family_name: "Profile", ...extra };
}

async function waitForProfile(page, email) {
  await page.locator("#account").waitFor({ state: "visible" });
  assert.equal(await page.locator("#email").textContent(), email);
}

async function assertPersonalDataCleared(page, privateValues) {
  await page.locator("#account").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#delete-confirmation").isVisible(), false);
  for (const selector of ["#email", "#account-id", "#delete-email"]) {
    assert.equal(await page.locator(selector).textContent(), "", `${selector} must be empty`);
  }
  for (const selector of ["#first-name", "#last-name"]) {
    assert.equal(await page.locator(selector).inputValue(), "", `${selector} must be empty`);
  }
  for (const selector of ["#save", "#logout", "#delete-open", "#delete-confirm"]) {
    assert.equal(await page.locator(selector).isDisabled(), true, `${selector} must be disabled`);
  }
  const markup = await page.content();
  for (const value of privateValues) assert.equal(markup.includes(value), false, "personal data must leave the markup");
}

function responseFor(page, path, method) {
  return page.waitForResponse((response) => response.url() === `${app.origin}${path}` && response.request().method() === method);
}

test("deletion can be cancelled, then confirmed for the displayed account without deleting another account", async () => {
  const alice = googleProfile("delete-alice");
  const bob = googleProfile("delete-bob");
  let first, second;
  try {
    second = await signIn(app, bob);
    await waitForProfile(second.page, bob.email);
    first = await signIn(app, alice);
    const page = first.page;
    await waitForProfile(page, alice.email);
    const aliceId = await app.db.prepare("SELECT id FROM user WHERE email = ?").bind(alice.email).first("id");
    const bobBefore = await app.db.prepare("SELECT * FROM user WHERE email = ?").bind(bob.email).first();
    let deletions = 0;
    page.on("request", (request) => {
      if (request.method() === "DELETE" && request.url() === `${app.origin}/api/account`) deletions++;
    });
    await page.locator("#delete-open").click();
    await page.locator("#delete-confirmation").waitFor({ state: "visible" });
    assert.equal(await page.locator("#delete-email").textContent(), alice.email);
    await page.locator("#delete-cancel").click();
    await page.locator("#delete-confirmation").waitFor({ state: "hidden" });
    assert.equal(deletions, 0, "cancelling must not submit a deletion");
    assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM user WHERE id = ?").bind(aliceId).first("count"), 1);
    await page.locator("#delete-open").click();
    await page.locator("#delete-confirmation").waitFor({ state: "visible" });
    assert.equal(await page.locator("#delete-email").textContent(), alice.email);
    const [deleted] = await Promise.all([responseFor(page, "/api/account", "DELETE"), page.locator("#delete-confirm").click()]);
    assert.equal(deleted.status(), 204);
    await page.locator("#signed-out").waitFor({ state: "visible" });
    await assertPersonalDataCleared(page, [alice.email, aliceId, alice.given_name]);
    assert.equal(deletions, 1);
    assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM user WHERE id = ?").bind(aliceId).first("count"), 0);
    assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions WHERE user_id = ?").bind(aliceId).first("count"), 0);
    assert.deepEqual(await app.db.prepare("SELECT * FROM user WHERE email = ?").bind(bob.email).first(), bobBefore);
    await second.page.reload();
    await waitForProfile(second.page, bob.email);
  } finally { await Promise.all([first?.context.close(), second?.context.close()]); }
});

test("HTML-looking names remain literal input values through loading, saving and reloading", async () => {
  const profile = googleProfile("literal", {
    given_name: '\"><img id="injected-profile-image" src="/unexpected-image">',
    family_name: '<svg id="injected-profile-svg"></svg>',
  });
  let client;
  try {
    client = await signIn(app, profile);
    const page = client.page;
    await waitForProfile(page, profile.email);
    assert.equal(await page.locator("#first-name").inputValue(), profile.given_name);
    assert.equal(await page.locator("#last-name").inputValue(), profile.family_name);
    assert.equal(await page.locator("#injected-profile-image, #injected-profile-svg").count(), 0);
    const firstName = '<b id="edited-profile-markup">Changed</b>';
    const lastName = '</input><script id="edited-profile-script">0</script>';
    await page.locator("#first-name").fill(firstName);
    await page.locator("#last-name").fill(lastName);
    const [saved] = await Promise.all([responseFor(page, "/api/profile", "PATCH"), page.locator("#save").click()]);
    assert.equal(saved.status(), 200);
    await page.getByText("Changes saved.", { exact: true }).waitFor();
    assert.deepEqual(await app.db.prepare("SELECT first_name AS firstName, last_name AS lastName FROM user WHERE email = ?")
      .bind(profile.email).first(), { firstName, lastName });
    await page.reload();
    await waitForProfile(page, profile.email);
    assert.equal(await page.locator("#first-name").inputValue(), firstName);
    assert.equal(await page.locator("#last-name").inputValue(), lastName);
    assert.equal(await page.locator("#injected-profile-image, #injected-profile-svg, #edited-profile-markup, #edited-profile-script").count(), 0);
  } finally { await client?.context.close(); }
});

test("a deletion confirmation for one account cannot delete a different account signed in through another tab", async () => {
  const alice = googleProfile("switch-alice");
  const bob = googleProfile("switch-bob");
  let client;
  try {
    client = await signIn(app, alice);
    const originalPage = client.page;
    await waitForProfile(originalPage, alice.email);
    await originalPage.locator("#delete-open").click();
    await originalPage.locator("#delete-confirmation").waitFor({ state: "visible" });
    assert.equal(await originalPage.locator("#delete-email").textContent(), alice.email);
    const aliceId = await app.db.prepare("SELECT id FROM user WHERE email = ?").bind(alice.email).first("id");
    client.page = await client.newPage();
    await signIn(app, bob, { client });
    await waitForProfile(client.page, bob.email);
    const bobId = await app.db.prepare("SELECT id FROM user WHERE email = ?").bind(bob.email).first("id");
    if (await originalPage.locator("#delete-confirmation").isVisible()) {
      // Headless pages can remain visible together: exercise the stale CSRF
      // rejection rather than deliberately changing browser lifecycle events.
      assert.equal(await originalPage.locator("#delete-email").textContent(), alice.email);
      const [rejected] = await Promise.all([
        responseFor(originalPage, "/api/account", "DELETE"), originalPage.locator("#delete-confirm").click(),
      ]);
      assert.equal(rejected.status(), 403);
      await originalPage.locator("#signed-out").waitFor({ state: "visible" });
    }
    // A browser that hides the old tab may clear it proactively; that is safe too.
    await assertPersonalDataCleared(originalPage, [alice.email, aliceId, alice.given_name]);
    assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM user WHERE id IN (?, ?)")
      .bind(aliceId, bobId).first("count"), 2);
    await client.page.reload();
    await waitForProfile(client.page, bob.email);
  } finally { await client?.context.close(); }
});

test("refreshing an expired session removes personal data and disables account mutations", async () => {
  const profile = googleProfile("expired");
  let client;
  try {
    client = await signIn(app, profile);
    const page = client.page;
    await waitForProfile(page, profile.email);
    const userId = await app.db.prepare("SELECT id FROM user WHERE email = ?").bind(profile.email).first("id");
    await page.locator("#delete-open").click();
    await page.locator("#delete-confirmation").waitFor({ state: "visible" });
    await app.db.prepare("UPDATE browser_sessions SET expires_at = 0 WHERE user_id = ?").bind(userId).run();
    const [expired] = await Promise.all([responseFor(page, "/api/profile", "GET"), page.locator("#refresh").click()]);
    assert.equal(expired.status(), 401);
    await page.locator("#signed-out").waitFor({ state: "visible" });
    await assertPersonalDataCleared(page, [profile.email, userId, profile.given_name]);
    assert.equal(await page.locator("#login").isVisible(), true);
    assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM user WHERE id = ?").bind(userId).first("count"), 1);
  } finally { await client?.context.close(); }
});
