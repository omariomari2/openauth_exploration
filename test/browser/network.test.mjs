import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium } from "playwright";
import { createBrowserApp } from "../helpers/browser.mjs";
import { createBrowserNetwork } from "../helpers/browser-network.mjs";

async function localEndpoint(handler) {
  const server = createServer(handler);
  let connections = 0;
  server.on("connection", () => { connections++; });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    get connections() { return connections; },
    async dispose() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("a browser-created popup cannot connect to a second loopback listener", async () => {
  const forbidden = await localEndpoint((_request, response) => response.end("unexpected request"));
  let app;
  try {
    app = await createBrowserApp();
    const client = await app.newClient();
    // This blank test document creates its own popup; client.newPage() is not used.
    await client.page.setContent(`<a href="${forbidden.origin}/blocked" target="_blank">Open popup</a>`);
    const [popup] = await Promise.all([
      client.page.waitForEvent("popup"), client.page.getByRole("link", { name: "Open popup" }).click(),
    ]);
    await popup.waitForLoadState();
    assert.equal(forbidden.connections, 0, "the popup's first connection must be blocked before reaching its destination");
    assert.throws(() => app.assertNoUnexpectedRequests(), /Blocked browser destination/);
  } finally {
    await app?.dispose();
    await forbidden.dispose();
  }
});

test("the browser network boundary blocks a popup redirect and HTTPS CONNECT before contacting either destination", async () => {
  const forbidden = await localEndpoint((_request, response) => response.end("unexpected request"));
  let redirected = false;
  // A dedicated local HTTP fixture verifies proxy behavior without replacing
  // any response in the production Worker's authentication flow.
  const allowed = await localEndpoint((request, response) => {
    if (request.url === "/redirect") {
      redirected = true;
      response.writeHead(302, { Location: `${forbidden.origin}/blocked?not-logged=1` });
      response.end();
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<a href="/redirect" target="_blank">Open redirect</a>');
    }
  });
  let network, browser;
  try {
    network = await createBrowserNetwork(allowed.origin);
    browser = await chromium.launch({ headless: true, args: network.args });
    const page = await browser.newPage();
    await page.goto(allowed.origin);
    const [popup] = await Promise.all([
      page.waitForEvent("popup"), page.getByRole("link", { name: "Open redirect" }).click(),
    ]);
    await popup.waitForLoadState();
    assert.equal(redirected, true, "the allowed local server really issues the redirect");
    assert.equal(forbidden.connections, 0, "a redirect cannot reach another loopback port");
    await assert.rejects(page.goto(forbidden.origin.replace("http:", "https:") + "/blocked"), /ERR_TUNNEL_CONNECTION_FAILED/);
    assert.equal(forbidden.connections, 0, "CONNECT must not create a TCP connection to its target");
    assert.throws(() => network.assertNoUnexpectedRequests(), (error) => {
      assert.ok(error.message.includes(`Blocked browser destination: ${forbidden.origin}`));
      assert.ok(error.message.includes(`Blocked browser destination: ${forbidden.origin.replace("http:", "https:")}`));
      assert.equal(error.message.includes("not-logged"), false);
      return true;
    });
  } finally {
    await browser?.close();
    await network?.dispose();
    await allowed.dispose();
    await forbidden.dispose();
  }
});
