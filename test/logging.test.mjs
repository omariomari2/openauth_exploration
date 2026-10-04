import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Miniflare } from "miniflare";

test("OAuth query values and provider errors stay out of runtime logs", { timeout: 20000 }, async () => {
  let output = "";
  let captured;
  const captureReady = new Promise((resolve) => { captured = resolve; });
  const runtime = new Miniflare({
    workers: [{
      name: "auth",
      modules: [{ type: "ESModule", path: path.resolve("dist/worker/index.js") }],
      compatibilityDate: "2025-10-08",
      compatibilityFlags: ["nodejs_compat"],
      kvNamespaces: ["AUTH_STORAGE"],
      d1Databases: ["AUTH_DB"],
      bindings: { GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret" },
    }, {
      name: "capture-control",
      modules: true,
      script: 'export default { fetch() { console.log("capture-control-stdout"); console.error("capture-control-stderr"); return new Response("ok"); } };',
      compatibilityDate: "2025-10-08",
    }],
    handleRuntimeStdio(stdout, stderr) {
      for (const stream of [stdout, stderr]) {
        stream.on("data", (chunk) => {
          output += chunk.toString();
          if (output.includes("capture-control-stdout") && output.includes("capture-control-stderr")) captured();
        });
      }
    },
  });
  let failure;
  let malformed;
  try {
    const auth = await runtime.getWorker("auth");
    await auth.fetch("https://auth.example.test/.well-known/jwks.json?code=sentinel-code&state=sentinel-state&access_token=sentinel-token");
    failure = await auth.fetch("https://auth.example.test/google/callback?error=access_denied&error_description=sentinel-private-error", { redirect: "manual" });
    await failure.text();
    const header = Buffer.from(JSON.stringify({ alg: "RSA-OAEP-512", enc: "A256GCM", crit: ["sentinel-private-cookie"] })).toString("base64url");
    malformed = await auth.fetch("https://auth.example.test/google/callback?error=access_denied", {
      redirect: "manual", headers: { Cookie: `provider=${header}....` },
    });
    await malformed.text();
    const start = await auth.fetch("https://auth.example.test/google/authorize", { redirect: "manual" });
    assert.equal(start.status, 302);
    const minted = start.headers.getSetCookie().find((cookie) => cookie.startsWith("provider="))?.split(";")[0];
    assert.ok(minted, "issuer must mint a genuine provider cookie");
    for (const cookie of [minted, `${minted}; provider=${header}....`, minted.replace("provider=e", "provider=%65")]) {
      const accepted = await auth.fetch("https://auth.example.test/.well-known/jwks.json", { headers: { Cookie: cookie } });
      assert.equal(accepted.status, 200, "genuine cookie must pass through the guard");
    }
    for (const cookie of [`provider=${header}....; ${minted}`, `provider=%65${header.slice(1)}....`]) {
      const rejected = await auth.fetch("https://auth.example.test/google/authorize", { redirect: "manual", headers: { Cookie: cookie } });
      assert.equal(rejected.status, 400);
      assert.match(rejected.headers.get("set-cookie"), /provider=;[^,]*Max-Age=0/);
    }
    const control = await runtime.getWorker("capture-control");
    await control.fetch("https://control.test/");
    await captureReady;
  } finally {
    await runtime.dispose();
  }
  // Prove both streams were captured; a silent/broken capture must not pass.
  assert.match(output, /capture-control-stdout/);
  assert.match(output, /capture-control-stderr/);
  for (const secret of ["sentinel-code", "sentinel-state", "sentinel-token", "sentinel-private-error", "sentinel-private-cookie"]) {
    assert.ok(!output.includes(secret), `runtime log leaked ${secret}`);
  }
  assert.equal(failure.status, 400);
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get("set-cookie"), /provider=;[^,]*Max-Age=0/);
  assert.match(output, /"event":"authentication_failed"/);
});

test("automatic invocation logs cannot capture callback query strings", async () => {
  const config = JSON.parse(await readFile("wrangler.json", "utf8"));
  assert.equal(config.observability.enabled, false);
  assert.equal(config.observability.logs.enabled, false);
  assert.equal(config.observability.logs.invocation_logs, false);
  assert.equal(config.observability.traces.enabled, false);
});
