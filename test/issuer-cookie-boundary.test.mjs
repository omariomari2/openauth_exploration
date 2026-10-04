import assert from "node:assert/strict";
import { test } from "node:test";
import { CompactEncrypt, generateKeyPair } from "jose";
import { protectIssuerCookies, translateIssuerCookies } from "../src/observability/issuer-cookie-boundary.ts";

const { publicKey } = await generateKeyPair("RSA-OAEP-512");
const encrypted = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({ state: "test-only-state" })))
  .setProtectedHeader({ alg: "RSA-OAEP-512", enc: "A256GCM" }).encrypt(publicKey);

function request(cookie, origin = "https://auth.example.test") {
  return new Request(`${origin}/google/callback`, { headers: cookie ? { Cookie: cookie } : {} });
}

function response(cookies, init = {}) {
  const headers = new Headers({ "X-Test": "preserved", ...init.headers });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response("issuer response", { status: 201, statusText: "Created", ...init, headers });
}

test("HTTPS public cookies map to OpenAuth's internal names without changing encrypted values", () => {
  const original = request(`theme=dark; __Host-openauth-provider=${encrypted}; __Host-openauth-authorization=${encrypted}; session=opaque`);
  const translated = translateIssuerCookies(original);
  assert.ok(translated instanceof Request);
  assert.equal(translated.headers.get("Cookie"), `theme=dark; provider=${encrypted}; authorization=${encrypted}; session=opaque`);
  assert.equal(original.headers.get("Cookie"), `theme=dark; __Host-openauth-provider=${encrypted}; __Host-openauth-authorization=${encrypted}; session=opaque`);
});

test("raw legacy cookies cannot shadow the protected public cookies", () => {
  const translated = translateIssuerCookies(request(
    `provider=attacker; authorization=attacker; provider=another; __Host-openauth-provider=${encrypted}; theme=light`,
  ));
  assert.equal(translated.headers.get("Cookie"), `provider=${encrypted}; theme=light`);
  const legacyOnly = translateIssuerCookies(request(" provider =attacker;\tauthorization\t=attacker"));
  assert.equal(legacyOnly.headers.get("Cookie"), null);
});

test("only the exact case-sensitive public names are translated", () => {
  const cookies = "__host-openauth-provider=lowercase; __Host-openauth-provider-extra=extra; local-openauth-provider=local; \u00a0__Host-openauth-provider=non-ascii-prefix; unrelated=ok";
  assert.equal(translateIssuerCookies(request(cookies)).headers.get("Cookie"), cookies);
});

test("the boundary leaves percent encoding and quoted values for the existing Hono parser", () => {
  const value = '"header%252Eencrypted%2Evalue"';
  assert.equal(translateIssuerCookies(request(`__Host-openauth-provider=${value}`)).headers.get("Cookie"),
    `provider=${value}`);
});

for (const name of ["provider", "authorization"]) {
  test(`duplicate public ${name} cookies fail closed even when their values match`, async () => {
    for (const second of [encrypted, "attacker-cookie"]) {
      const result = translateIssuerCookies(request(
        `__Host-openauth-${name}=${encrypted}; \t__Host-openauth-${name}\t=${second}`,
      ));
      assert.ok(result instanceof Response);
      assert.equal(result.status, 400);
      assert.equal(result.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(await result.json(), { error: "invalid_login_cookie" });
    }
  });
}

test("request translation retains the method, body, URL, and unrelated headers", async () => {
  const original = new Request("https://auth.example.test/token", {
    method: "POST", body: "code=test-only-code", headers: { "X-Test": "preserved", Cookie: "theme=dark" },
  });
  const translated = translateIssuerCookies(original);
  assert.equal(translated.url, original.url);
  assert.equal(translated.method, "POST");
  assert.equal(translated.headers.get("X-Test"), "preserved");
  assert.equal(await translated.text(), "code=test-only-code");
  assert.equal(translateIssuerCookies(request()).headers.get("Cookie"), null);
});

test("HTTPS response cookies enforce host scope and preserve encrypted values and lifetime", async () => {
  const original = response([
    `provider=${encrypted}; Max-Age=600; Domain=.example.test; Path=/google; SameSite=None`,
    `authorization=${encrypted}; Expires=Wed, 21 Oct 2037 07:28:00 GMT; domain=example.test; PATH=/authorize; secure; httponly; samesite=Strict`,
  ]);
  const protectedResponse = protectIssuerCookies(original, request());
  assert.deepEqual(protectedResponse.headers.getSetCookie(), [
    `__Host-openauth-provider=${encrypted}; Max-Age=600; Path=/; HttpOnly; SameSite=Lax; Secure`,
    `__Host-openauth-authorization=${encrypted}; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/; HttpOnly; SameSite=Lax; Secure`,
  ]);
  assert.equal(protectedResponse.status, 201);
  assert.equal(protectedResponse.statusText, "Created");
  assert.equal(protectedResponse.headers.get("X-Test"), "preserved");
  assert.equal(await protectedResponse.text(), "issuer response");
  assert.ok(original.headers.getSetCookie()[0].startsWith("provider="));
});

test("clearing an issuer cookie clears its protected public name with the same expiry", () => {
  const cleared = protectIssuerCookies(response([
    "provider=; Max-Age=0; Path=/",
    "authorization=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Domain=example.test",
  ]), request());
  assert.deepEqual(cleared.headers.getSetCookie(), [
    "__Host-openauth-provider=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure",
    "__Host-openauth-authorization=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure",
  ]);
});

test("multiple Set-Cookie headers keep unrelated cookies unchanged, including commas in Expires", () => {
  const unrelated = "session=opaque; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure; Path=/app; SameSite=Strict";
  const result = protectIssuerCookies(response([unrelated, `provider=${encrypted}`, "theme=dark; Path=/"]), request());
  assert.deepEqual(result.headers.getSetCookie(), [
    unrelated, `__Host-openauth-provider=${encrypted}; Path=/; HttpOnly; SameSite=Lax; Secure`, "theme=dark; Path=/",
  ]);
});

for (const origin of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
  test(`validated loopback HTTP uses separate local names at ${origin}`, () => {
    const incoming = request(`local-openauth-provider=${encrypted}; local-openauth-authorization=${encrypted}; __Host-openauth-provider=unused`, origin);
    assert.equal(translateIssuerCookies(incoming).headers.get("Cookie"),
      `provider=${encrypted}; authorization=${encrypted}; __Host-openauth-provider=unused`);
    const result = protectIssuerCookies(response([`provider=${encrypted}; Secure; SameSite=None`, "authorization=; Max-Age=0"]), incoming);
    assert.deepEqual(result.headers.getSetCookie(), [
      `local-openauth-provider=${encrypted}; Path=/; HttpOnly; SameSite=Lax`,
      "local-openauth-authorization=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
    ]);
  });
}

test("HTTPS loopback still requires host-prefixed secure cookies", () => {
  const incoming = request(`__Host-openauth-provider=${encrypted}`, "https://localhost:8787");
  assert.equal(translateIssuerCookies(incoming).headers.get("Cookie"), `provider=${encrypted}`);
  assert.equal(protectIssuerCookies(response([`provider=${encrypted}`]), incoming).headers.getSetCookie()[0],
    `__Host-openauth-provider=${encrypted}; Path=/; HttpOnly; SameSite=Lax; Secure`);
});

test("duplicate local cookies are rejected on HTTP loopback", () => {
  assert.equal(translateIssuerCookies(request("local-openauth-provider=a; local-openauth-provider=b", "http://localhost:8787")).status, 400);
});

test("non-loopback HTTP cannot receive or translate insecure issuer cookies", () => {
  const incoming = request(`local-openauth-provider=${encrypted}`, "http://auth.example.test");
  assert.equal(translateIssuerCookies(incoming).status, 400);
  const result = protectIssuerCookies(response([`provider=${encrypted}`]), incoming);
  assert.equal(result.status, 400);
  assert.equal(result.headers.get("Set-Cookie"), null);
});

test("responses without cookies preserve their status and empty body", () => {
  const result = protectIssuerCookies(new Response(null, { status: 204, headers: { "X-Test": "preserved" } }), request());
  assert.equal(result.status, 204);
  assert.equal(result.body, null);
  assert.equal(result.headers.get("X-Test"), "preserved");
  assert.deepEqual(result.headers.getSetCookie(), []);
});
