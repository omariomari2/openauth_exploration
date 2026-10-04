# Protected profile API

The API runs in the same Worker as the [browser interface](../frontend-integration/README.md).
You do not need a second Worker.

1. Complete the [project setup](../../README.md).
2. Run `npm run dev` and open the configured origin.
3. Sign in to read or edit your profile, sign out, or delete your account.

## Routes

| Route | Credential and behavior |
| --- | --- |
| `GET /api/profile` | Current opaque browser session; returns `{ user, csrfToken }`. |
| `PATCH /api/profile` | Current browser session, exact Origin and `X-CSRF-Token`; updates only supplied `firstName`/`lastName` fields. |
| `POST /logout` | Current browser session, exact Origin and `X-CSRF-Token`; revokes that session and returns `204`. |
| `DELETE /api/account` | Current browser session, exact Origin and `X-CSRF-Token`; deletes that account's data and returns `204`. |
| `GET /userinfo` | Verified bearer access token for the exact issuer and audience; returns `{ user }`. Cookies cannot authorize it. |

## Credentials

Browser profile and account routes reject query selectors and Authorization headers.
The server selects the account from verified credentials and reads current D1 data.
The browser uses `/api/profile`. It does not obtain a bearer token for `/userinfo`.

The [API contract](../../docs/profile-api.md) defines request bodies, response fields, errors, expiry, deletion and concurrency limits.

## Implementation

Use the full [entrypoint](../../src/index.ts) to retain origin, issuer, cookie and response protections.
The internal modules provide these checks:

- [browser-auth.ts](../../src/browser-auth.ts): sessions and write ownership.
- [bearer-profile.ts](../../src/bearer-profile.ts): `/userinfo`.
- [token-verification.ts](../../src/token-verification.ts): signed claims.

## Verification

`npm test` runs the bundled Worker with isolated D1 and KV.
Tests cover [bearer profiles](../../test/bearer-profile.test.mjs),
[profile updates](../../test/profile-mutations.test.mjs),
[session revocation](../../test/profile-revocation.test.mjs) and
[account deletion](../../test/account-deletion.test.mjs).

Tests simulate Google's responses. They do not prove a successful live Google deployment.
See [test results and known limits](../../docs/verification.md).
