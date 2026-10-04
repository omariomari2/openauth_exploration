# Browser integration

## Open the profile screen

1. Complete [project setup](../../README.md), including Google credentials and the registered callback.
2. Run `npm run dev`.
3. Open the configured `ISSUER_ORIGIN` at `/`.

The Worker serves the screen. Local HTML files and screens on another origin are unsupported.

## Adapt the client

Edit [page.html](../../src/demo/page.html), [client.mjs](../../src/demo/client.mjs),
[view.mjs](../../src/demo/view.mjs), and [styles.css](../../src/demo/styles.css).
The Worker bundles these files. The browser tests exercise them directly.

Navigate to `/login` to sign in. The server manages state, PKCE and the exact callback.
It handles `/callback` and redirects to `/` with an opaque HttpOnly session cookie.
Browser code receives no access or refresh tokens. Sign in again when the session expires.

`GET /api/profile` returns `{ user, csrfToken }`.
`user.firstName` and `user.lastName` are strings or `null`.
Keep `csrfToken` only in memory. A cached user does not prove that the session is valid.

Use fixed relative routes with `credentials: "same-origin"`, `cache: "no-store"` and `redirect: "error"`, as in `client.mjs`.

## Change data or sign out

| Action | Request |
| --- | --- |
| Save names | `PATCH /api/profile` with only changed names in JSON |
| Delete the account | `DELETE /api/account` after confirmation for the displayed account and session |
| Sign out | `POST /logout`; success returns `204` and revokes the browser session |

Each request needs the current `X-CSRF-Token`.
The browser supplies the Origin header. The server requires its exact configured origin.
Profile edits and account deletion reject Authorization headers and account selectors.
See the [API contract](../../docs/profile-api.md) for fields, errors and request rules.

Preserve the client's account and session checks. Allow only one pending write.
Ignore stale responses. Clear private data on sign-out or page hiding.
An unknown write result locks editing until another sign-in. Do not retry the write automatically.
A displayed role is not an authorization check.

## Test the integration

`npm test` checks the bundled Worker. `npm run test:browser` checks the screen in Chromium.
Tests use isolated D1/KV and simulated Google responses.
Real Google accounts and the isolated live deployment remain unverified.
Read the [verification evidence](../../docs/verification.md) for results and remaining gaps.
