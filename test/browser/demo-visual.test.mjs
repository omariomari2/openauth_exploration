import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { createBrowserApp, signIn } from "../helpers/browser.mjs";

function luminance(hex) {
  const channels = hex.trim().replace("#", "").match(/../g).map((value) => parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

test("the profile screen fits mobile and desktop, exposes keyboard labels and meets text contrast", async () => {
  const app = await createBrowserApp();
  const profile = { sub: "visual-profile", email: "a-long-student-profile-address-for-layout@example.test",
    email_verified: true, given_name: "Bright", family_name: "Example" };
  try {
    const client = await app.newClient(profile);
    const page = client.page;
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (!["error", "warning"].includes(message.type())) return;
      // Chromium reports the expected anonymous /api/profile 401 as a resource
      // error. It is the API's unauthenticated contract, not a JavaScript defect.
      if (message.location().url === `${app.origin}/api/profile` && /status of 401/.test(message.text())) return;
      errors.push(message.text());
    });
    await mkdir("test-results", { recursive: true });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(app.origin);
    await page.locator("#signed-out").waitFor({ state: "visible" });
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(":focus").getAttribute("id"), "login");
    await page.screenshot({ path: "test-results/demo-signed-out-320.png", fullPage: true });
    await signIn(app, profile, { client });
    await page.locator("#account").waitFor({ state: "visible" });
    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.locator("html").evaluate((node) => node.scrollWidth <= window.innerWidth), `overflow at ${width}px`);
      await page.screenshot({ path: `test-results/demo-profile-${width}.png`, fullPage: true });
    }
    assert.equal(await page.getByRole("heading", { level: 1, name: "Private profile" }).count(), 1);
    for (const name of ["First name", "Last name"]) assert.equal(await page.getByLabel(name, { exact: true }).isEnabled(), true);
    await page.locator("#delete-open").focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(":focus").getAttribute("id"), "delete-confirmation");
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(":focus").getAttribute("id"), "delete-confirm");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(":focus").getAttribute("id"), "delete-open");
    const colors = await page.locator("html").evaluate((node) => {
      const style = getComputedStyle(node);
      return Object.fromEntries(["text", "muted", "surface", "background", "accent", "danger"].map((name) => [name, style.getPropertyValue(`--${name}`)]));
    });
    for (const [foreground, background] of [[colors.text, colors.surface], [colors.muted, colors.surface],
      [colors.muted, colors.background], ["#ffffff", colors.accent], ["#ffffff", colors.danger]]) {
      const [dark, light] = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
      assert.ok((light + 0.05) / (dark + 0.05) >= 4.5, "normal text contrast must meet 4.5:1");
    }
    assert.deepEqual(errors, []);
    app.assertNoUnexpectedRequests();
  } finally { await app.dispose(); }
});
