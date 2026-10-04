import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createBrowserApp, signIn } from "../helpers/browser.mjs";

const alice = { sub: "chromium-alice", email: "alice@example.test", email_verified: true, given_name: "Alice", family_name: "Example" };
const bob = { sub: "chromium-bob", email: "bob@example.test", email_verified: true, given_name: "Bob", family_name: "Other" };
let app;

before(async () => { app = await createBrowserApp(); });
afterEach(() => { app.assertNoUnexpectedRequests(); });
after(async () => { await app?.dispose(); });

async function profileFromBrowser(client) {
  const response = await client.page.goto(`${app.origin}/api/profile`);
  assert.equal(response.status(), 200);
  assert.equal(response.headers()["cache-control"], "no-store");
  return response.json();
}

test("Chromium follows the real PKCE callback, retains HttpOnly cookies, and reads current D1 profile data", async () => {
  const client = await signIn(app, alice);
  const { user } = await profileFromBrowser(client);
  const stored = await app.db.prepare(`SELECT id, email, first_name AS firstName,
    last_name AS lastName, role, created_at AS createdAt FROM user WHERE email = ?`).bind(alice.email).first();
  assert.deepEqual(user, stored);
  // Inspect metadata only; cookie values never enter assertions or page JavaScript.
  const metadata = (await client.context.cookies(app.origin)).map(({ name, httpOnly, secure, sameSite, path, domain }) =>
    ({ name, httpOnly, secure, sameSite, path, domain }));
  assert.deepEqual(metadata.find(({ name }) => name === "local-openauth-session"), {
    name: "local-openauth-session", httpOnly: true, secure: false, sameSite: "Lax", path: "/", domain: "127.0.0.1",
  });
  assert.equal(metadata.some(({ name }) => name === "local-openauth-login"), false);
  await app.db.prepare("UPDATE user SET first_name = ?, role = ? WHERE id = ?").bind("Current Alice", "reader", user.id).run();
  const current = await profileFromBrowser(client);
  assert.equal(current.user.firstName, "Current Alice");
  assert.equal(current.user.role, "reader");
  assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM login_transactions").first("count"), 0);
  await client.context.close();
});

test("isolated Chromium contexts keep accounts separate and logout clears only its own browser session", async () => {
  const first = await signIn(app, alice);
  const second = await signIn(app, bob);
  const firstProfile = await profileFromBrowser(first);
  const secondProfile = await profileFromBrowser(second);
  assert.equal(firstProfile.user.email, alice.email);
  assert.equal(secondProfile.user.email, bob.email);
  assert.notEqual(firstProfile.user.id, secondProfile.user.id);
  assert.equal((await profileFromBrowser(first)).user.id, firstProfile.user.id);
  const anonymous = await app.newClient(alice);
  const unauthorized = await anonymous.page.goto(`${app.origin}/api/profile`);
  assert.equal(unauthorized.status(), 401);

  // APIRequestContext shares this isolated browser's own cookie jar. CSRF comes
  // from the test API response; no cookies or credentials are copied into it.
  const logout = await first.context.request.post(`${app.origin}/logout`, {
    headers: { Origin: app.origin, "X-CSRF-Token": firstProfile.csrfToken }, maxRedirects: 0,
  });
  assert.equal(logout.status(), 204);
  const afterLogout = await first.page.goto(`${app.origin}/api/profile`);
  assert.equal(afterLogout.status(), 401);
  assert.equal((await profileFromBrowser(second)).user.id, secondProfile.user.id);
  assert.equal((await first.context.cookies(app.origin)).some(({ name }) => name === "local-openauth-session"), false);
  await Promise.all([first.context.close(), second.context.close(), anonymous.context.close()]);
});
