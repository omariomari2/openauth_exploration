import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareIssuerRequest, readAuthSettings } from "../src/issuer-policy.ts";
import { authorizationPath, ORIGIN } from "./helpers/worker.mjs";

const settings = readAuthSettings(ORIGIN);

test("issuer configuration requires a canonical HTTPS origin or loopback HTTP", () => {
  for (const origin of [ORIGIN, "http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
    assert.equal(readAuthSettings(origin).origin, origin);
  }
  for (const origin of [undefined, "", "garbage", "http://example.test", `${ORIGIN}/`, `${ORIGIN}/path`,
    `${ORIGIN}?query=1`, `${ORIGIN}#fragment`, "https://user:password@auth.example.test"]) {
    assert.throws(() => readAuthSettings(origin));
  }
});

test("valid S256 authorization stays on the exact registered callback", () => {
  const response = prepareIssuerRequest(new Request(new URL(authorizationPath(), ORIGIN)), settings);
  assert.ok(response instanceof Request);
});

test("encoded route aliases cannot bypass authorization policy", () => {
  for (const path of ["/%61uthorize", "/authoriz%65", "/%2561uthorize", "/authoriz%", "/%74oken"]) {
    const url = new URL(authorizationPath(), ORIGIN);
    url.pathname = path;
    url.searchParams.delete("code_challenge");
    url.searchParams.delete("code_challenge_method");
    const response = prepareIssuerRequest(new Request(url), settings);
    assert.equal(response.status, 400, path);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("authorization rejects unsupported parameters locally, before any redirect or cookie", () => {
  const cases = [
    ["client_id", "attacker"], ["redirect_uri", "https://attacker.test/callback"],
    ["redirect_uri", `${ORIGIN}/callback/extra`], ["redirect_uri", `${ORIGIN}/callback?extra=1`],
    ["response_type", "token"], ["state", ""], ["code_challenge", "short"],
    ["state", `${"s".repeat(32)}\n`], ["code_challenge", `${"c".repeat(43)}\n`],
    ["code_challenge_method", "plain"], ["provider", "password"], ["audience", "different-client"],
  ];
  const urls = cases.map(([key, value]) => {
    const url = new URL(authorizationPath(), ORIGIN);
    url.searchParams.set(key, value);
    return url;
  });
  for (const key of ["state", "code_challenge", "code_challenge_method", "redirect_uri", "client_id", "response_type"]) {
    const missing = new URL(authorizationPath(), ORIGIN);
    missing.searchParams.delete(key);
    urls.push(missing);
    const duplicate = new URL(authorizationPath(), ORIGIN);
    duplicate.searchParams.append(key, duplicate.searchParams.get(key));
    urls.push(duplicate);
  }
  for (const url of urls) {
    const response = prepareIssuerRequest(new Request(url), settings);
    assert.equal(response.status, 400, url.search);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("forwarded headers cannot change the issuer origin or provider callback", () => {
  const request = prepareIssuerRequest(new Request(`${ORIGIN}/google/authorize`, { headers: {
    "x-forwarded-host": "attacker.test", "x-forwarded-proto": "http", "x-forwarded-port": "9999",
    Forwarded: "host=attacker.test", Cookie: "provider=test",
  } }), settings);
  assert.equal(request.url, `${ORIGIN}/google/authorize`);
  for (const header of ["x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "forwarded"]) {
    assert.equal(request.headers.get(header), null);
  }
  assert.equal(request.headers.get("cookie"), "provider=test");
});

test("unexpected request and browser origins fail closed", () => {
  assert.equal(prepareIssuerRequest(new Request("https://other.example.test/"), settings).status, 421);
  for (const origin of ["https://attacker.test", "null"]) {
    assert.equal(prepareIssuerRequest(new Request(`${ORIGIN}/token`, { headers: { Origin: origin } }), settings).status, 403);
  }
  assert.ok(prepareIssuerRequest(new Request(`${ORIGIN}/token`, { headers: { Origin: ORIGIN } }), settings) instanceof Request);
});
