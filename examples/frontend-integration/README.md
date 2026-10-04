# Same-origin browser integration

The supported browser example is the private-profile screen served by this
Worker at `/`. Follow the [project setup](../../README.md), run `npm run dev`,
and open the configured `ISSUER_ORIGIN`. Google credentials and its registered
callback are required for a real sign-in. Opening a local HTML file or serving
the screen from another origin is unsupported.

The implementation is [page.html](../../src/demo/page.html),
[client.mjs](../../src/demo/client.mjs), [view.mjs](../../src/demo/view.mjs), and
[styles.css](../../src/demo/styles.css). The Worker bundles and serves these
files. Edit this implementation when adapting the demo; it is the code exercised
by the browser tests, with no separate example copy to synchronize.

## Migrate from the removed SDK and frontend files

`vanilla-js.html`, `react-example.tsx`, `src/client-sdk.ts`, and the SDK exports
from `src/index.ts` were removed. This is an intentional breaking source-import
change. There is no replacement `AuthClient` class or `useAuth` hook. See the
[retirement record](../README.md) for scope and unknown external consumers.

| Former operation | Supported demo flow |
| --- | --- |
| `login()` and client/callback configuration | Navigate to `/login`; the server owns state, PKCE and the exact callback. |
| `handleCallback()` and token exchange | The server handles `/callback` and redirects to `/` with an opaque HttpOnly session cookie. |
| `isAuthenticated()`, `getStoredUser()`, `getCurrentUser()` | Read `GET /api/profile`; use its `user` and keep its `csrfToken` only in memory. A cached user is not proof of a live session. |
| `authenticatedFetch()` | Use the fixed relative demo routes with `credentials: "same-origin"`, `cache: "no-store"` and `redirect: "error"`, as in `client.mjs`. |
| `logout()` | Send `POST /logout` with the current `X-CSRF-Token`; success is `204`. This revokes the demo session. |
| Browser token refresh | Sign in again when the session expires; browser code does not receive access or refresh tokens. |

The profile envelope is `{ user, csrfToken }`. Names are `user.firstName` and
`user.lastName`, each a string or `null`; the old flat snake_case object and
`avatar_url` are not the contract. The complete field list, errors and mutation
rules are in the [profile API](../../docs/profile-api.md).

Profile saves send only changed names to `PATCH /api/profile`, using JSON and
the current `X-CSRF-Token`. Account deletion uses `DELETE /api/account` after an
explicit confirmation bound to the displayed account/session. The browser supplies
the Origin header; the server requires its exact configured origin. These routes
reject Authorization headers and account selectors.

Preserve the canonical client's account/session checks, one pending mutation,
stale-response suppression and private-data clearing on sign-out or page hiding.
An unknown mutation result locks further editing until sign-in; do not retry the
write automatically. A role displayed in the UI is not an authorization check.

Owners of copied legacy clients should remove their SDK imports and token-storage
code, and remove the old `openauth_tokens`, `openauth_user`,
`openauth_token_expires`, and `openauth_state` localStorage keys at the origin that
created them, without reading or logging their contents. Clearing those keys does
not revoke previously issued bearer credentials or sign out of Google.

## Verification

`npm test` exercises the bundled Worker and `npm run test:browser` exercises this
screen in Chromium, using isolated D1/KV and fixtures for Google's endpoints.
See [verification evidence](../../docs/verification.md) for results and remaining
gaps. Real Google accounts and the isolated live deployment remain unverified.
