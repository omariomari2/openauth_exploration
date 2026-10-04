import assert from "node:assert/strict";
import { get } from "node:http";
import { after, before, test } from "node:test";
import { ORIGIN, completeGoogleAuthorization, createHttpClient, createTestApp } from "./helpers/worker.mjs";

let app;
before(async () => { app = await createTestApp(); });
after(async () => { await app?.dispose(); });

async function fetchWrongOrigin(path) {
  // Fetch retries 421 by destroying the connection (noisy on Windows workerd).
  // Read the raw HTTP response using the same local routing header as Miniflare.
  const listening = await app.runtime.ready;
  return new Promise((resolve, reject) => {
    const request = get(new URL(path, listening), {
      headers: { "MF-Original-URL": `https://untrusted.example.test${path}` },
    }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => { resolve({ status: response.statusCode, body }); });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.setTimeout(5_000, () => { request.destroy(new Error("Local origin check timed out")); });
  });
}

test("the public demo shell contains no personal data and uses only same-origin external assets", async () => {
  const anonymous = createHttpClient(app.runtime);
  const response = await anonymous.fetch("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /^text\/html/);
  const html = await response.text();
  assert.match(html, /<h1[^>]*>Private profile<\/h1>/);
  assert.match(html, /href="\/assets\/demo.css"/);
  assert.match(html, /src="\/assets\/demo.mjs"/);
  assert.doesNotMatch(html, /<style|\son\w+=|style=|https?:\/\//);

  const signedIn = createHttpClient(app.runtime);
  const login = await signedIn.fetch("/login");
  const provider = await completeGoogleAuthorization(app, signedIn, {
    sub: "demo-shell-user", email: "never-in-html@example.test", email_verified: true,
    given_name: "<script>notMarkup()</script>",
  }, login.headers.get("location"));
  assert.equal((await signedIn.fetch(provider.headers.get("location"))).status, 303);
  assert.equal(await (await signedIn.fetch("/")).text(), html, "HTML is independent of identity and cookies");
  const profile = await signedIn.fetch("/api/profile");
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).user.email, "never-in-html@example.test");
  app.fetchMock.assertNoPendingInterceptors();
});

test("demo content has restrictive CSP, correct asset types and no cacheable private responses", async () => {
  for (const [path, type] of [["/", "text/html"], ["/assets/demo.css", "text/css"],
    ["/assets/demo.mjs", "text/javascript"], ["/assets/view.mjs", "text/javascript"]]) {
    const response = await createHttpClient(app.runtime).fetch(path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get("Content-Type").startsWith(type), path);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    const csp = response.headers.get("Content-Security-Policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
    if (path === "/") {
      for (const directive of ["script-src 'self'", "style-src 'self'", "connect-src 'self'"]) assert.ok(csp.includes(directive));
    }
    assert.ok((await response.text()).length > 0, "consume the asset before disposing the local runtime");
  }
});

test("static demo routes reject non-read methods and preserve request-origin validation", async () => {
  const client = createHttpClient(app.runtime);
  for (const path of ["/", "/assets/demo.css", "/assets/demo.mjs", "/assets/view.mjs"]) {
    const head = await client.fetch(path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const post = await client.fetch(path, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("Allow"), "GET, HEAD");
    await post.text();
    const foreignOrigin = await client.fetch(path, { headers: { Origin: "https://untrusted.example.test" } });
    assert.equal(foreignOrigin.status, 403);
    await foreignOrigin.text();
    const wrongOrigin = await fetchWrongOrigin(path);
    assert.equal(wrongOrigin.status, 421);
    assert.deepEqual(JSON.parse(wrongOrigin.body), { error: "unrecognized_origin" });
  }
  const anonymousProfile = await client.fetch("/api/profile");
  assert.equal(anonymousProfile.status, 401);
  await anonymousProfile.text();
});
