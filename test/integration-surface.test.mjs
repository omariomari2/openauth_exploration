import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createTestApp } from "./helpers/worker.mjs";

test("the bundled Worker exposes no legacy SDK, middleware or unverified JWT helpers", async () => {
  const app = await createTestApp({ modules: [
    { type: "ESModule", path: path.resolve("test/export-surface-entry.mjs"), contents: `
      import * as worker from "../dist/worker/index.js";
      export default { fetch() { return Response.json(Object.keys(worker)); } };
    ` },
    { type: "ESModule", path: path.resolve("dist/worker/index.js") },
  ] });
  try {
    const response = await app.runtime.dispatchFetch("https://auth.example.test/");
    assert.deepEqual(await response.json(), ["default"]);
  } finally { await app.dispose(); }
});
