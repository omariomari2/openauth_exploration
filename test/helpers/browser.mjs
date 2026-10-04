import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { CLIENT_ID, createTestApp } from "./worker.mjs";
import { createBrowserNetwork } from "./browser-network.mjs";

// The bundled Worker serves real HTTP and uses real isolated D1/KV. Only Google
// is replaced: its authorization page, token endpoint, and UserInfo endpoint.
export async function createBrowserApp(options = {}) {
  const app = await createTestApp({ ...options, serve: true });
  let browser;
  let network;
  try {
    network = await createBrowserNetwork(app.origin);
    // Playwright creates a temporary browser profile. No user Chrome state,
    // storageState, injected session cookies, or deployable auth bypass is used.
    browser = await chromium.launch({ headless: true, args: network.args });
    const failures = [];
    return {
      ...app,
      async newClient(profile, contextOptions = {}) {
        assert.ok(!("proxy" in contextOptions), "the test browser network boundary cannot be overridden");
        const context = await browser.newContext({ ...contextOptions, serviceWorkers: "block" });
        context.setDefaultTimeout(10_000);
        const requests = [];
        const client = { context, requests, googleVisits: 0, setGoogleProfile(value) { profile = value; } };
        context.on("response", (response) => {
          const url = new URL(response.url());
          // Record paths and statuses only, never query strings or headers.
          if (url.origin === app.origin) requests.push({ path: url.pathname, status: response.status() });
        });
        client.newPage = async () => {
          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          // Fetch intercepts every redirect hop. Playwright route.continue() only
          // routes the first URL, allowing subsequent redirect URLs to bypass it.
          cdp.on("Fetch.requestPaused", async ({ requestId, request, resourceType }) => {
            const url = new URL(request.url);
            try {
              if (url.origin === app.origin) return await cdp.send("Fetch.continueRequest", { requestId });
              if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" ||
                request.method !== "GET" || resourceType !== "Document") {
                failures.push(`Unexpected browser destination: ${url.origin}${url.pathname}`);
                return await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
              }
              assert.equal(url.searchParams.get("client_id"), "test-google-client");
              assert.equal(url.searchParams.get("response_type"), "code");
              assert.equal(url.searchParams.get("redirect_uri"), `${app.origin}/google/callback`);
              assert.equal(url.searchParams.get("code_challenge_method"), "S256");
              const challenge = url.searchParams.get("code_challenge");
              assert.ok(challenge && /^[A-Za-z0-9_-]{43}$/.test(challenge), "Google receives an S256 challenge");
              const state = url.searchParams.get("state");
              assert.ok(state, "Google receives provider state");
              const code = `fixture-code-${randomUUID()}`;
              const access = `fixture-access-${randomUUID()}`;
              app.fetchMock.get("https://oauth2.googleapis.com")
                .intercept({ path: "/token", method: "POST" })
                .reply(200, async ({ body }) => {
                  // Miniflare forwards a streaming body, which cannot be matched
                  // by Undici's synchronous body predicate. Validate after reading.
                  const chunks = [];
                  for await (const chunk of body) chunks.push(Buffer.from(chunk));
                  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
                  if (params.get("code") !== code || params.get("grant_type") !== "authorization_code" ||
                    params.get("client_id") !== "test-google-client" || params.get("client_secret") !== "test-google-secret" ||
                    params.get("redirect_uri") !== `${app.origin}/google/callback` ||
                    createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url") !== challenge) {
                    failures.push("Google token request failed fixture validation");
                    return JSON.stringify({ error: "invalid_grant" });
                  }
                  return JSON.stringify({ access_token: access, token_type: "Bearer", expires_in: 3600 });
                }, { headers: { "content-type": "application/json" } });
              app.fetchMock.get("https://openidconnect.googleapis.com")
                .intercept({ path: "/v1/userinfo", method: "GET", headers: { authorization: `Bearer ${access}` } })
                .reply(200, profile, { headers: { "content-type": "application/json" } });
              client.googleVisits++;
              const callback = new URL(url.searchParams.get("redirect_uri"));
              callback.search = new URLSearchParams({ code, state }).toString();
              await cdp.send("Fetch.fulfillRequest", {
                requestId, responseCode: 302, responseHeaders: [{ name: "location", value: callback.href }],
              });
            } catch {
              if (page.isClosed()) return;
              failures.push(`Browser interception failed: ${url.origin}${url.pathname}`);
              await cdp.send("Fetch.failRequest", { requestId, errorReason: "Failed" }).catch(() => {});
            }
          });
          await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
          return page;
        };
        client.page = await client.newPage();
        return client;
      },
      assertNoUnexpectedRequests() {
        network.assertNoUnexpectedRequests();
        assert.deepEqual(failures, [], "browser requests stay within the Worker and Google fixture");
        app.fetchMock.assertNoPendingInterceptors();
      },
      async dispose() {
        try { await browser.close(); }
        finally {
          try { await network.dispose(); }
          finally { await app.dispose(); }
        }
      },
    };
  } catch (error) {
    try { await browser?.close(); }
    finally {
      try { await network?.dispose(); }
      finally { await app.dispose(); }
    }
    throw error;
  }
}

export async function signIn(app, profile, { client, start = "/login", contextOptions } = {}) {
  client ??= await app.newClient(profile, contextOptions);
  client.setGoogleProfile(profile);
  const previousVisits = client.googleVisits;
  const previousRequests = client.requests.length;
  const authorize = client.page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.origin === app.origin && url.pathname === "/authorize";
  });
  const response = await client.page.goto(`${app.origin}${start}`);
  const request = new URL((await authorize).url());
  assert.equal(request.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(request.searchParams.get("redirect_uri"), `${app.origin}/callback`);
  assert.equal(request.searchParams.get("code_challenge_method"), "S256");
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(request.searchParams.get("code_challenge")), "browser begins PKCE authorization");
  assert.equal(response.status(), 200, JSON.stringify({
    requests: client.requests, googleVisits: client.googleVisits,
    pending: app.fetchMock.pendingInterceptors().map(({ origin, path, method }) => ({ origin, path, method })),
  }));
  assert.ok(client.page.url() === `${app.origin}/`, "sign-in lands on the app root without callback parameters");
  assert.ok(client.requests.slice(previousRequests).some(({ path, status }) => path === "/callback" && status === 303), "real callback establishes the session");
  assert.equal(client.googleVisits, previousVisits + 1);
  app.assertNoUnexpectedRequests();
  return client;
}
