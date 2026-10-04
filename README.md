# OpenAuth authentication service

This service provides Google sign-in and private user profiles on Cloudflare Workers.
Users can edit their names, sign out, and delete their accounts.

The API uses TypeScript and OpenAuth. D1 stores users and sessions. KV stores temporary OAuth records.
The browser uses HttpOnly session cookies and keeps tokens out of localStorage.

## Set up

Use Node **24.19.0** and npm **11.17.0**. You do not need cloud credentials.

Install the dependencies:

```sh
npm ci --ignore-scripts
```

## Run the tests

1. Compile the Worker and browser code.

   ```sh
   npm run build
   ```

2. Run the backend tests.

   ```sh
   npm test
   ```

3. Install Chromium.

   ```sh
   node node_modules/playwright/cli.js install chromium
   ```

   On Linux, use [Playwright's setup instructions](https://playwright.dev/docs/ci-intro#setting-up-github-actions) to install the required system libraries.

4. Run the browser tests.

   ```sh
   npm run test:browser
   ```

`npm run check` builds the Worker bundle without deployment.
`npm audit --ignore-scripts` checks dependencies for known vulnerabilities.

The tests use local workerd, D1, KV, and Chromium. They simulate Google's responses.
[GitHub CI](https://github.com/omariomari2/openauth_exploration/actions/runs/37176367468) passed 206 backend tests and 26 browser tests.
CI does not deploy the service.

## Run with Google

Complete [Set up](#set-up) before these steps.
Keep the client secret out of Git, issues, screenshots, and the browser console.

1. Create a Google OAuth **Web application** client with [Google's setup guide](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred).
   If the client uses testing mode, add your Google account to its test users.
2. Register `http://localhost:8787/google/callback` as the authorized redirect URI.
   Do not use the service's internal `/callback` route for Google.
3. Copy `.dev.vars.example` to `.dev.vars`.
   Enter the client's ID and secret in `.dev.vars`. Git ignores this file.
4. Apply the local migrations. Start the Worker:

   ```sh
   npm run migrate:local
   npm run dev
   ```

5. Open `http://localhost:8787/`. Select **Continue with Google**.

Use `localhost`, not `127.0.0.1`, to match `ISSUER_ORIGIN` in `wrangler.json`.
Wrangler reads the credentials from [the local secret file](https://developers.cloudflare.com/workers/configuration/secrets/#local-development-with-secrets).
Do not use `wrangler secret put` for local setup.

## Before deployment

Real Google login and HTTPS sessions still need live verification.

Do not deploy with the resource IDs in `wrangler.json`. They belong to the original setup.
The remote npm scripts require a separate `wrangler.deploy.json` with dedicated Worker, D1, and KV resources.
That file does not exist yet.

Before deployment, complete the [deployment checklist](tasks/todo.md).
It includes authentication rate limits, Google configuration, and live account-isolation tests.
The database retention and restore requirements are in the [API contract](docs/profile-api.md).

## Details

- [API and security behavior](docs/profile-api.md)
- [Integration guide](examples/README.md)
- [Test results and known limits](docs/verification.md)

Based on [Cloudflare's OpenAuth template](https://github.com/cloudflare/templates/tree/main/openauth-template).
This project is not an official Cloudflare service.
