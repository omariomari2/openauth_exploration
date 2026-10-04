import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createFetchMock, Miniflare } from "miniflare";

export const ORIGIN = "https://auth.example.test";
export const CLIENT_ID = "openauth-demo";
export const VERIFIER = "v".repeat(43);

export async function loadWorkerModules(modules = [{ type: "ESModule", path: path.resolve("dist/worker/index.js") }]) {
  const bundlePath = path.resolve("dist/worker/index.js");
  const bundle = await readFile(bundlePath, "utf8");
  const loaded = [...modules];
  const paths = new Set(loaded.map((module) => path.resolve(module.path)));
  // Read only Wrangler's current hashed Text imports, not stale output files or
  // the ESM dependency graph (whose workerd built-ins must resolve in workerd).
  for (const [, asset] of bundle.matchAll(/^import .+ from "(\.\/[a-f0-9]{40}-[^"/]+\.(?:html|css|mjs))";$/gm)) {
    const assetPath = path.resolve(path.dirname(bundlePath), asset);
    if (!paths.has(assetPath)) {
      loaded.push({ type: "Text", path: assetPath });
      paths.add(assetPath);
    }
  }
  return loaded;
}

export async function createTestApp({ origin = ORIGIN, serve = false, modules } = {}) {
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const options = {
    modules: await loadWorkerModules(modules),
    ...(serve ? { host: "127.0.0.1", port: 0 } : {}),
    compatibilityDate: "2025-10-08", compatibilityFlags: ["nodejs_compat"],
    kvNamespaces: ["AUTH_STORAGE"], d1Databases: ["AUTH_DB"], fetchMock,
    bindings: { GOOGLE_CLIENT_ID: "test-google-client", GOOGLE_CLIENT_SECRET: "test-google-secret", ISSUER_ORIGIN: origin },
  };
  const runtime = new Miniflare(options);
  try {
    if (serve) {
      const listening = await runtime.ready;
      origin = listening.origin;
      // setOptions replaces all options and invalidates binding handles, so set
      // the canonical loopback origin before getting D1 or applying migrations.
      await runtime.setOptions({ ...options, bindings: { ...options.bindings, ISSUER_ORIGIN: origin } });
      assert.equal((await runtime.ready).origin, origin, "Miniflare listener must keep its assigned port");
    }
    const db = await runtime.getD1Database("AUTH_DB");
    for (const file of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
      const sql = await readFile(path.join("migrations", file), "utf8");
      await db.exec(sql.replace(/^--.*$/gm, "").replace(/\r?\n/g, " "));
    }
    return { runtime, db, fetchMock, origin, dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

// HTTP fixture only: does not claim to emulate browser cookie security policies.
export function createHttpClient(runtime) {
  const cookies = new Map();
  return {
    cookies,
    async fetch(input, init = {}) {
      const url = new URL(input, ORIGIN);
      assert.equal(url.origin, ORIGIN, "never send test cookies to another origin");
      const headers = new Headers(init.headers);
      if (!headers.has("Cookie")) headers.set("Cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
      const response = await runtime.dispatchFetch(url.href, { ...init, headers, redirect: "manual" });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0];
        const separator = pair.indexOf("=");
        const name = pair.slice(0, separator);
        if (/;\s*Max-Age=0(?:;|$)/i.test(cookie)) cookies.delete(name);
        else cookies.set(name, pair.slice(separator + 1));
      }
      return response;
    },
  };
}

export function authorizationPath() {
  return `/authorize?${new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: `${ORIGIN}/callback`, response_type: "code",
    state: "s".repeat(43), code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    code_challenge_method: "S256", provider: "google",
  })}`;
}

export async function completeGoogleAuthorization(app, client, profile, start = authorizationPath()) {
  const authorization = await client.fetch(start);
  assert.equal(authorization.status, 302);
  const provider = await client.fetch(authorization.headers.get("location"));
  assert.equal(provider.status, 302);
  const googleUrl = new URL(provider.headers.get("location"));
  assert.equal(googleUrl.origin, "https://accounts.google.com");
  assert.equal(googleUrl.searchParams.get("redirect_uri"), `${ORIGIN}/google/callback`);
  app.fetchMock.get("https://oauth2.googleapis.com")
    .intercept({ path: "/token", method: "POST" })
    .reply(200, { access_token: "test-google-access", token_type: "Bearer", expires_in: 3600 });
  app.fetchMock.get("https://openidconnect.googleapis.com")
    .intercept({ path: "/v1/userinfo", method: "GET" })
    .reply(200, (options) => {
      assert.match(JSON.stringify(options.headers), /Bearer test-google-access/);
      return JSON.stringify(profile);
    }, { headers: { "content-type": "application/json" } });
  return client.fetch(`/google/callback?${new URLSearchParams({ code: "test-google-code", state: googleUrl.searchParams.get("state") })}`);
}
