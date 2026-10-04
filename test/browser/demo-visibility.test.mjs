import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createBrowserApp, signIn } from "../helpers/browser.mjs";
import { controlVisibility, loadVisibilityWorkerModules, nextHandlerCompletion } from "../helpers/browser-visibility.mjs";

let app;
before(async () => { app = await createBrowserApp({ modules: await loadVisibilityWorkerModules() }); });
afterEach(() => { app.assertNoUnexpectedRequests(); });
after(async () => { await app?.dispose(); });

function profile(name) {
  return { sub: `visibility-${name}`, email: `visibility-${name}@example.test`, email_verified: true,
    given_name: `Private ${name}`, family_name: "Visibility" };
}

async function waitForProfile(page, expected) {
  await page.locator("#account").waitFor({ state: "visible" });
  assert.equal(await page.locator("#email").textContent(), expected.email);
}

async function assertCleared(page) {
  assert.deepEqual(await page.evaluate(() => ({
    texts: ["email", "account-id", "delete-email"].map((id) => document.getElementById(id).textContent),
    names: ["first-name", "last-name"].map((id) => document.getElementById(id).value),
    hidden: ["account", "delete-confirmation"].map((id) => document.getElementById(id).hidden),
    disabled: ["profile-fields", "logout", "delete-open", "delete-confirm"].map((id) => document.getElementById(id).disabled),
  })), { texts: ["", "", ""], names: ["", ""], hidden: [true, true], disabled: [true, true, true, true] });
}

async function holdResponse(page, path, method) {
  // Capture the exact upcoming handler invocation before the triggering click.
  // A later visible GET may complete before this held GET is released.
  const completed = await nextHandlerCompletion(page, method === "GET" ? "loadProfile" : "mutate");
  const ready = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delivered = Promise.withResolvers();
  let heldRequest;
  async function outcome(promise, label, timeout = 5000) {
    let timer;
    try {
      const result = await Promise.race([promise, new Promise((resolve) => {
        timer = setTimeout(() => resolve({ error: new Error(`Timed out waiting for ${label}`) }), timeout);
      })]);
      if (result.error) throw result.error;
      return result;
    } finally { clearTimeout(timer); }
  }
  await page.route(`${app.origin}${path}`, async (route) => {
    if (heldRequest || route.request().method() !== method) return route.continue();
    heldRequest = route.request();
    try {
      // Only delivery is delayed; authorization, D1 writes, status and body all
      // come from the unchanged authenticated request to the actual Worker.
      const response = await route.fetch({ timeout: 5000 });
      ready.resolve({ status: response.status() });
      if (await release.promise) await route.fulfill({ response });
      else await route.abort();
      delivered.resolve({});
    } catch (error) {
      // Both promises resolve even on failure: a test waiting only for ready
      // must never leave an independently rejected delivery promise behind.
      ready.resolve({ error });
      delivered.resolve({ error });
    }
  });
  return {
    async ready() { return (await outcome(ready.promise, "the held Worker response")).status; },
    async deliver() {
      assert.ok(heldRequest, "wait for the Worker response before releasing it");
      const observed = page.waitForResponse((response) => response.request() === heldRequest, { timeout: 5000 })
        .then((response) => ({ response }), (error) => ({ error }));
      release.resolve(true);
      await outcome(delivered.promise, "response delivery");
      const { response } = await outcome(observed, "the browser response");
      assert.equal(response.status(), method === "GET" || method === "PATCH" ? 200 : 204);
      await completed();
    },
    async dispose() {
      release.resolve(false);
      try { if (heldRequest) await outcome(delivered.promise, "held route teardown", 6000); }
      finally { await page.unrouteAll({ behavior: "ignoreErrors" }); }
    },
  };
}

test("trusted Chromium visibility clears private DOM and revalidates the same live document", { timeout: 20000 }, async () => {
  const expected = profile("revalidate");
  const client = await signIn(app, expected);
  try {
    const page = client.page;
    await waitForProfile(page, expected);
    const visibility = await controlVisibility(page);
    await page.locator("#first-name").fill("Private unsaved draft");
    await page.locator("#delete-open").click();
    await page.locator("#delete-confirmation").waitFor({ state: "visible" });
    await visibility.hide();
    await assertCleared(page);
    await app.db.prepare("UPDATE user SET first_name = ? WHERE email = ?").bind("Updated while hidden", expected.email).run();
    const refreshed = page.waitForResponse(`${app.origin}/api/profile`, { timeout: 5000 })
      .then((response) => ({ response }), (error) => ({ error }));
    await visibility.show();
    const refreshResult = await refreshed;
    assert.ifError(refreshResult.error);
    assert.equal(refreshResult.response.status(), 200);
    await waitForProfile(page, expected);
    assert.equal(await page.locator("#first-name").inputValue(), "Updated while hidden");
    assert.equal(await page.locator("#delete-confirmation").isVisible(), false);
    await visibility.assertSameDocument();
  } finally { await client.context.close(); }
});

for (const deliverWhileHidden of [true, false]) {
  test(`late real profile GET cannot repopulate ${deliverWhileHidden ? "a hidden document" : "a newer visible profile"}`, { timeout: 20000 }, async () => {
    const expected = profile(deliverWhileHidden ? "late-hidden" : "late-visible");
    const client = await signIn(app, expected);
    let pending;
    try {
      const page = client.page;
      await waitForProfile(page, expected);
      const visibility = await controlVisibility(page);
      pending = await holdResponse(page, "/api/profile", "GET");
      await page.locator("#refresh").click();
      assert.equal(await pending.ready(), 200);
      await visibility.hide();
      if (deliverWhileHidden) { await pending.deliver(); await assertCleared(page); }
      await app.db.prepare("UPDATE user SET first_name = ? WHERE email = ?").bind("Newest visible profile", expected.email).run();
      const refreshed = page.waitForResponse(`${app.origin}/api/profile`, { timeout: 5000 })
        .then((response) => ({ response }), (error) => ({ error }));
      await visibility.show();
      const refreshResult = await refreshed;
      assert.ifError(refreshResult.error);
      assert.equal(refreshResult.response.status(), 200);
      await waitForProfile(page, expected);
      if (!deliverWhileHidden) await pending.deliver();
      assert.equal(await page.locator("#first-name").inputValue(), "Newest visible profile");
      await visibility.assertSameDocument();
    } finally {
      try { await pending?.dispose(); }
      finally { await client.context.close(); }
    }
  });
}

for (const action of ["save", "logout", "delete"]) {
  test(`hidden pending ${action} remains locked after its real successful response reaches the live document`, { timeout: 20000 }, async () => {
    const expected = profile(`pending-${action}`);
    const client = await signIn(app, expected);
    let pending;
    try {
      const page = client.page;
      await waitForProfile(page, expected);
      const visibility = await controlVisibility(page);
      pending = await holdResponse(page, action === "save" ? "/api/profile" : action === "delete" ? "/api/account" : "/logout",
        action === "save" ? "PATCH" : action === "delete" ? "DELETE" : "POST");
      if (action === "save") {
        await page.locator("#first-name").fill("Saved before hiding");
        await page.getByRole("button", { name: "Save changes" }).click();
      } else if (action === "logout") await page.locator("#logout").click();
      else { await page.locator("#delete-open").click(); await page.locator("#delete-confirm").click(); }
      assert.equal(await pending.ready(), action === "save" ? 200 : 204);
      if (action === "save") {
        assert.equal(await app.db.prepare("SELECT first_name FROM user WHERE email = ?").bind(expected.email).first("first_name"), "Saved before hiding");
      }
      await visibility.hide();
      await pending.deliver();
      await assertCleared(page);
      const profileRequests = client.requests.filter(({ path }) => path === "/api/profile").length;
      await visibility.show();
      await assertCleared(page);
      assert.equal(await page.locator("#status").textContent(), "We could not confirm the last action. Sign in again before making more changes.");
      assert.equal(await page.locator("#signed-out").isVisible(), true);
      assert.equal(client.requests.filter(({ path }) => path === "/api/profile").length, profileRequests, "returning visible must not silently unlock an uncertain action");
      await visibility.assertSameDocument();
    } finally {
      try { await pending?.dispose(); }
      finally { await client.context.close(); }
    }
  });
}
