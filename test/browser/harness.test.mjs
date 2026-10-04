import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createBrowserApp, signIn } from "../helpers/browser.mjs";

const profile = { sub: "fixture-check", email: "fixture-check@example.test", email_verified: true };

for (const binding of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
  for (const value of ["", "wrong-fixture-credential"]) {
    test(`Google fixture rejects ${value ? "wrong" : "missing"} ${binding} in the token exchange`, async () => {
      const app = await createBrowserApp({ modules: [
        { type: "ESModule", path: path.resolve("test/browser/fixture-entry.mjs"), contents: `
          import worker from "../../dist/worker/index.js";
          export default { fetch(request, env, ctx) {
            if (new URL(request.url).pathname === "/google/callback") {
              env = { ...env, ${binding}: ${JSON.stringify(value)} };
            }
            return worker.fetch(request, env, ctx);
          } };
        ` },
        { type: "ESModule", path: path.resolve("dist/worker/index.js") },
      ] });
      try {
        await assert.rejects(signIn(app, profile));
        assert.throws(() => app.assertNoUnexpectedRequests(), /Google token request failed fixture validation/);
        assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions").first("count"), 0);
      } finally { await app.dispose(); }
    });
  }
}
