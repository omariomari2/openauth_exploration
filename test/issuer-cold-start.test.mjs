import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestApp, createHttpClient, ORIGIN } from "./helpers/worker.mjs";

for (const warm of [false, true]) {
  test(`${warm ? "warm" : "cold"} issuer keeps simultaneous browser logins usable`, async (t) => {
    const app = await createTestApp();
    try {
      if (warm) {
        assert.equal((await createHttpClient(app.runtime).fetch("/google/authorize")).status, 302);
        assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM issuer_keys WHERE purpose = ?")
          .bind("encryption:key").first("count"), 1);
      }
      const clients = Array.from({ length: 6 }, () => createHttpClient(app.runtime));
      const logins = await Promise.all(clients.map((client) => client.fetch("/login")));
      assert.ok(logins.every((response) => response.status === 302));
      const authorizations = await Promise.all(clients.map((client, i) => client.fetch(logins[i].headers.get("location"))));
      assert.ok(authorizations.every((response) => response.status === 302));
      const providers = await Promise.all(clients.map((client, i) => client.fetch(authorizations[i].headers.get("location"))));
      const profiles = [];
      const keyCount = await app.db.prepare("SELECT COUNT(*) AS count FROM issuer_keys WHERE purpose = ?")
        .bind("encryption:key").first("count");
      assert.equal(keyCount, 1);
      for (let i = 0; i < clients.length; i++) {
        assert.equal(providers[i].status, 302);
        const google = new URL(providers[i].headers.get("location"));
        assert.equal(google.origin, "https://accounts.google.com");
        const code = `cold-start-code-${i}`;
        const access = `cold-start-access-${i}`;
        // Each fixture checks its code/token so a response cannot hide an identity mix-up.
        const called = { token: false, userInfo: false };
        app.fetchMock.get("https://oauth2.googleapis.com").intercept({
          path: "/token", method: "POST",
        }).reply(200, async (options) => {
          called.token = true;
          const body = await new Response(options.body).text();
          assert.equal(new URLSearchParams(body).get("code"), code);
          return JSON.stringify({ access_token: access, token_type: "Bearer", expires_in: 3600 });
        }, { headers: { "content-type": "application/json" } });
        app.fetchMock.get("https://openidconnect.googleapis.com").intercept({
          path: "/v1/userinfo", method: "GET",
        }).reply(200, (options) => {
          called.userInfo = true;
          assert.ok(JSON.stringify(options.headers).includes(`Bearer ${access}`));
          return JSON.stringify({ sub: `concurrent-sub-${i}`, email: `concurrent-${i}@example.test`, email_verified: true });
        },
          { headers: { "content-type": "application/json" } });
        const response = await clients[i].fetch(`/google/callback?${new URLSearchParams({ code, state: google.searchParams.get("state") })}`);
        if (response.status !== 302) t.diagnostic(JSON.stringify({ flow: i, keyCount, called }));
        assert.equal(response.status, 302, `provider callback ${i}`);
        const callback = new URL(response.headers.get("location"), ORIGIN);
        assert.equal(callback.pathname, "/callback", `provider cookie ${i} must still decrypt`);
        const session = await clients[i].fetch(callback.href);
        assert.equal(session.status, 303, `application callback ${i}`);
        const profile = await clients[i].fetch("/api/profile");
        assert.equal(profile.status, 200);
        profiles.push(await profile.json());
      }
      assert.equal(new Set(profiles.map((profile) => profile.user.id)).size, clients.length);
      profiles.forEach((profile, i) => assert.equal(profile.user.email, `concurrent-${i}@example.test`));
      assert.equal(await app.db.prepare("SELECT COUNT(*) AS count FROM issuer_keys").first("count"), 2);
      app.fetchMock.assertNoPendingInterceptors();
    } finally { await app.dispose(); }
  });
}
