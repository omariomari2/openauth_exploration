import assert from "node:assert/strict";
import { test } from "node:test";
import { readProfilePatch } from "../src/profile-input.ts";

const request = (body, headers = {}) => new Request("https://auth.example.test/api/profile", {
  method: "PATCH", headers: { "Content-Type": "application/json", ...headers }, body, duplex: "half",
});

test("profile input preserves Unicode, trims names, distinguishes omission and explicit clearing", async () => {
  assert.deepEqual(await readProfilePatch(request('{"firstName":"  Zoë 王  "}')), { firstName: "Zoë 王" });
  assert.deepEqual(await readProfilePatch(request('{"firstName":null,"lastName":"  "}')), { firstName: null, lastName: null });
});

test("profile input counts actual streamed UTF-8 bytes despite a misleading length header", async () => {
  const response = await readProfilePatch(request(JSON.stringify({ firstName: "王".repeat(1400) }), { "Content-Length": "1" }));
  assert.equal(response.status, 413);
});

test("profile input rejects malformed UTF-8, unexpected fields and non-object JSON", async () => {
  for (const body of [new Uint8Array([0xff]), "null", "[]", "{}", '{"constructor":"bad"}',
    '{"__proto__":{"firstName":"Bad"}}', '{"firstName":"Valid","role":"admin"}']) {
    const response = await readProfilePatch(request(body));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_profile" });
  }
});

test("profile input rejects unsupported encodings and oversized declared length before reading", async () => {
  assert.equal((await readProfilePatch(request("{}", { "Content-Encoding": "gzip" }))).status, 415);
  assert.equal((await readProfilePatch(request("{}", { "Content-Length": "4097" }))).status, 413);
});

test("profile input rejects C1 controls as well as ASCII controls", async () => {
  for (const control of ["\u0085", "\u009b"]) {
    const response = await readProfilePatch(request(JSON.stringify({ firstName: `A${control}B` })));
    assert.equal(response.status, 400);
  }
});

test("profile input rejects trailing control characters before trimming", async () => {
  for (const suffix of ["\n", "\r", "\r\n", "\t"]) {
    const response = await readProfilePatch(request(JSON.stringify({ lastName: `Name${suffix}` })));
    assert.equal(response.status, 400);
  }
});

test("profile input cancels a stalled incoming body at its deadline", { timeout: 8000 }, async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const started = performance.now();
  const response = await readProfilePatch(request(stream));
  assert.equal(response.status, 408);
  assert.ok(performance.now() - started < 7000);
  assert.equal(cancelled, true);
});
