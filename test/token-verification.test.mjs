import assert from "node:assert/strict";
import { test } from "node:test";
import { CompactSign, SignJWT, exportJWK, generateKeyPair } from "jose";
import { verifyAccessToken } from "../src/token-verification.ts";

const issuer = "https://auth.example.test";
const audience = "profile-demo";
const [current, rotated, attacker, otherAlgorithm] = await Promise.all([
  generateKeyPair("ES256"), generateKeyPair("ES256"),
  generateKeyPair("ES256"), generateKeyPair("ES384"),
]);
const currentJwk = { ...await exportJWK(current.publicKey), kid: "current", alg: "ES256" };
const rotatedJwk = { ...await exportJWK(rotated.publicKey), kid: "rotated", alg: "ES256" };
const config = { issuer, audience, jwks: { keys: [currentJwk] } };

function claims(overrides = {}) {
  return {
    iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 300,
    sub: "user:openauth-subject-hash", mode: "access", type: "user",
    properties: { id: "database-user-id" }, ...overrides,
  };
}

function sign(payload = claims(), key = current.privateKey, header = {}) {
  return new SignJWT(payload).setProtectedHeader({ alg: "ES256", kid: "current", ...header }).sign(key);
}

test("verified access tokens return the database ID rather than the JWT subject", async () => {
  assert.equal(await verifyAccessToken(await sign(), config), "database-user-id");
  assert.equal(await verifyAccessToken(await sign(claims({ properties: { id: "a".repeat(255) } })), config),
    "a".repeat(255));
});

test("tampering with a signed token cannot replace its database identity", async () => {
  const [header, , signature] = (await sign()).split(".");
  const replacement = Buffer.from(JSON.stringify(claims({ properties: { id: "victim" } }))).toString("base64url");
  assert.equal(await verifyAccessToken(`${header}.${replacement}.${signature}`, config), null);
});

test("a forged signature with a copied trusted key ID fails closed", async () => {
  assert.equal(await verifyAccessToken(await sign(claims(), attacker.privateKey), config), null);
});

for (const [name, overrides] of [
  ["different issuer", { iss: "https://attacker.example.test" }],
  ["issuer with a trailing slash", { iss: `${issuer}/` }],
  ["different audience", { aud: "another-client" }],
  ["single-element audience array", { aud: [audience] }],
  ["multi-client audience array", { aud: [audience, "another-client"] }],
  ["expired token", { exp: 1 }],
  ["expiration at the current second", { exp: Math.floor(Date.now() / 1000) }],
  ["nonnumeric expiration", { exp: "9999999999" }],
  ["null expiration", { exp: null }],
  ["future not-before", { nbf: Math.floor(Date.now() / 1000) + 3600 }],
  ["refresh token mode", { mode: "refresh" }],
  ["wrong subject type", { type: "service" }],
  ["empty JWT subject", { sub: "" }],
  ["nonstring JWT subject", { sub: 42 }],
  ["null properties", { properties: null }],
  ["array properties", { properties: [] }],
  ["missing database ID", { properties: {} }],
  ["empty database ID", { properties: { id: "" } }],
  ["nonstring database ID", { properties: { id: 42 } }],
  ["oversized database ID", { properties: { id: "a".repeat(256) } }],
]) {
  test(`rejects ${name}`, async () => {
    assert.equal(await verifyAccessToken(await sign(claims(overrides)), config), null);
  });
}

for (const name of ["iss", "aud", "exp", "sub", "mode", "type", "properties"]) {
  test(`requires the ${name} claim`, async () => {
    const payload = claims();
    delete payload[name];
    assert.equal(await verifyAccessToken(await sign(payload), config), null);
  });
}

test("rejects an overflowing numeric expiration in an otherwise signed JWT", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify(claims({ exp: "overflow" })).replace('"overflow"', "1e400"));
  const token = await new CompactSign(encoded).setProtectedHeader({ alg: "ES256", kid: "current" })
    .sign(current.privateKey);
  assert.equal(await verifyAccessToken(token, config), null);
});

test("rejects other signature algorithms even with their matching public key", async () => {
  const jwk = { ...await exportJWK(otherAlgorithm.publicKey), kid: "other", alg: "ES384" };
  const token = await sign(claims(), otherAlgorithm.privateKey, { alg: "ES384", kid: "other" });
  assert.equal(await verifyAccessToken(token, { ...config, jwks: { keys: [jwk] } }), null);
});

test("rejects an unsigned token", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims())).toString("base64url");
  assert.equal(await verifyAccessToken(`${header}.${payload}.`, config), null);
});

test("rejects an unknown key and accepts rotation only with the supplied replacement JWKS", async () => {
  const oldToken = await sign();
  const newToken = await sign(claims(), rotated.privateKey, { kid: "rotated" });
  assert.equal(await verifyAccessToken(oldToken, config), "database-user-id");
  assert.equal(await verifyAccessToken(newToken, config), null);
  const updated = { ...config, jwks: { keys: [rotatedJwk] } };
  assert.equal(await verifyAccessToken(newToken, updated), "database-user-id");
  assert.equal(await verifyAccessToken(oldToken, updated), null);
});

test("takes a fresh snapshot when the supplied JWKS is rotated in place", async () => {
  const mutable = { ...config, jwks: { keys: [currentJwk] } };
  assert.equal(await verifyAccessToken(await sign(), mutable), "database-user-id");
  mutable.jwks.keys = [rotatedJwk];
  const token = await sign(claims(), rotated.privateKey, { kid: "rotated" });
  assert.equal(await verifyAccessToken(token, mutable), "database-user-id");
  assert.equal(await verifyAccessToken(await sign(), mutable), null);
});

test("malformed, empty, ambiguous, and unsuitable JWKS fail closed", async () => {
  const token = await sign();
  for (const jwks of [null, {}, { keys: [] }, { keys: [null] }, { keys: [{}] },
    { keys: [currentJwk, currentJwk] }, { keys: [{ ...currentJwk, use: "enc" }] },
    { keys: [{ ...currentJwk, key_ops: ["sign"] }] },
    { keys: [{ ...currentJwk, x: "invalid-coordinate" }] }]) {
    assert.equal(await verifyAccessToken(token, { ...config, jwks }), null);
  }
});

test("rejects malformed inputs and oversized otherwise valid signed tokens", async () => {
  for (const token of [undefined, null, 42, {}, "", "a.b", "a.b.c", " ", "💥".repeat(9000)]) {
    assert.equal(await verifyAccessToken(token, config), null);
  }
  const oversized = await sign(claims({ padding: "x".repeat(16_384) }));
  assert.ok(oversized.length > 16_384);
  assert.equal(await verifyAccessToken(oversized, config), null);
});
