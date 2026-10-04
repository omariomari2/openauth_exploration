# OpenAuth private-profile demo

A student authentication project built from the Cloudflare OpenAuth template.
Google sign-in creates a private D1-backed profile served by the same Cloudflare
Worker as the browser interface. OpenAuth handles the OAuth exchange; the browser
receives an opaque HttpOnly session cookie, not access or refresh tokens.

This is a working **local demo**, not a production-readiness claim. Real Google
login, production HTTPS cookies and a dedicated deployment still need verification.
See [verification evidence](docs/verification.md) and [remaining work](tasks/todo.md).
No password login, ecommerce backend, React SDK or arbitrary external OAuth clients
are supported.

## What it demonstrates

- Validated Google identities mapped by provider subject, without email auto-linking.
- Browser-bound, one-use S256 PKCE login; revocable one-hour D1 sessions and CSRF checks.
- Owner-scoped profile reads/updates, account deletion and a separately verified
  bearer profile endpoint. Account deletion cannot affect another user's records.
- A same-origin screen that clears private data on session changes, confirms
  deletion, and requires reauthentication after an uncertain write.
- Tests against real local workerd, D1, KV and Chromium. Only Google is simulated.

The [API contract](docs/profile-api.md) describes exact responses, failure behavior,
retention and deletion limits. The [integration guide](examples/README.md) points to
the actual tested implementation and explains the intentional legacy API removal.

## Run automated checks without cloud credentials

Use Node **24.19.0** and npm **11.17.0**, matching the checked toolchain and CI.
Dependency lifecycle scripts are disabled in `.npmrc`.

```sh
npm ci --ignore-scripts
npm run build
npm test
node node_modules/playwright/cli.js install chromium
npm run test:browser
npm run check
npm audit --ignore-scripts
```

On Linux, Playwright may also need system libraries; its
[CI instructions](https://playwright.dev/docs/ci-intro#setting-up-github-actions)
use `install --with-deps chromium`. The explicit browser download is test-only.
Tests create isolated temporary data and do not use configured remote resources.
Build output and screenshots in `test-results/` are ignored by Git.

[CI](.github/workflows/ci.yml) is prepared for pushes, pull requests and manual runs.
It pins Actions, Node and npm, installs without package scripts, then runs type
checks, backend/browser tests and an advisory audit. It has read-only repository
permissions, no cloud secrets and no deployment step. A GitHub-hosted run and
required-check branch protection are **not yet verified or configured**.

## Run the local Google-login demo

Real login requires your own Google OAuth configuration. Never paste credentials
into a commit, issue, screenshot or browser console.

1. Create a Google OAuth **Web application** client using Google's
   [credential setup](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred).
   Configure the consent screen and, if it is in testing mode, the intended test
   accounts. Register this exact authorized redirect URI:
   `http://localhost:8787/google/callback`.
2. Copy `.dev.vars.example` to `.dev.vars` and fill in that client's ID and secret.
   Wrangler reads this ignored file for
   [local secrets](https://developers.cloudflare.com/workers/configuration/secrets/#local-development-with-secrets).
   Do not use `wrangler secret put` for this local step.
3. Apply migrations **locally**, then start the Worker:

   ```sh
   npm run migrate:local
   npm run dev
   ```

4. Open `http://localhost:8787/` and choose **Continue with Google**. Keep the
   browser host and port equal to `ISSUER_ORIGIN` in `wrangler.json`; localhost
   and 127.0.0.1 are different origins.

Google's `/google/callback` is distinct from the demo's internal `/callback`.
The latter is registered inside this app for its single `openauth-demo` client;
do not replace it with a frontend callback or exchange codes in browser code.
These are setup instructions; successful real-provider verification is still pending.

## Deployment boundary

**Do not deploy using the resource IDs currently committed in `wrangler.json`.**
They are inherited bindings, not approved isolated demo resources.

Remote npm helpers explicitly require `wrangler.deploy.json`, which is deliberately
absent until an isolated deployment is approved and configured. They fail if that
file is missing. Do not copy the inherited IDs into it. Local dev explicitly uses
`--local`; checks and dry runs keep using `wrangler.json` without remote writes.
This guard covers the provided helpers, not manually entered Wrangler commands.

Deployment requires an approved Cloudflare account, a dedicated Worker/D1/KV set,
a canonical HTTPS issuer origin, matching Google redirect configuration and secrets.
Remote migrations and deployment are separate explicit operations, never npm
lifecycle hooks. Confirm isolation and the rollback/retention plan before either.
No existing live database has been migrated as part of this work.

Platform logs/traces are disabled to avoid recording OAuth callback URLs.
Application failure logs contain only an event and generated request ID, not
provider responses, names, email addresses or credentials. See the
[logging decision](docs/decisions/002-authentication-logging.md).

## Read the implementation

- [Browser interface](src/demo/): HTML/CSS and strictly checked JavaScript.
- [Browser authentication](src/browser-auth.ts): login, callback, private API and logout.
- [Identity mapping](src/identity.ts): verified provider data and D1 ownership.
- [Bearer verification](src/token-verification.ts) and [profile route](src/bearer-profile.ts).
- [Storage decisions](docs/decisions/004-issuer-key-storage.md) and
  [OAuth expiry](docs/decisions/005-oauth-state-expiry.md).
- [Specification](SPEC.md), [plan](tasks/plan.md) and [test evidence](docs/verification.md).

Based on [Cloudflare's OpenAuth template](https://github.com/cloudflare/templates/tree/main/openauth-template).
This repository is an independent student project, not an official Cloudflare service.
