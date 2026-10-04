# Protected profile API example

The supported API example runs inside the same Worker as the
[browser demo](../frontend-integration/README.md). Follow the
[project setup](../../README.md), run `npm run dev`, open the configured origin,
and use the screen to sign in, read and edit your private profile, sign out, or
confirm account deletion. There is no second Worker to deploy.

| Route | Credential and behavior |
| --- | --- |
| `GET /api/profile` | Current opaque browser session; returns `{ user, csrfToken }`. |
| `PATCH /api/profile` | Current browser session, exact Origin and `X-CSRF-Token`; updates only supplied `firstName`/`lastName` fields. |
| `POST /logout` | Current browser session, exact Origin and `X-CSRF-Token`; revokes that demo session and returns `204`. |
| `DELETE /api/account` | Current browser session, exact Origin and `X-CSRF-Token`; deletes that account's data and returns `204`. |
| `GET /userinfo` | A verified access bearer token for this demo's exact issuer/audience; returns `{ user }`. Cookies cannot authorize it. |

The [profile API contract](../../docs/profile-api.md) specifies request bodies,
response fields, errors, expiry, deletion and concurrency limits. Browser
profile/account routes accept no query selectors or Authorization headers. The
server derives the account from verified credentials and reads current D1 data.
The UI uses `/api/profile`; it does not obtain a bearer token for `/userinfo`.

## Migrate from the removed middleware Worker

The previous `worker.ts`, `src/middleware/auth.ts`,
`src/helpers/token-validation.ts`, and their exports from `src/index.ts` were
removed. This is an intentional breaking source-import change; there is no
drop-in `requireAuth`, role middleware, token-decoding helper or rate limiter.
The [retirement record](../README.md) identifies unknown external consumers.

For the supported private profile use case, replace the old
`/api/protected/profile` request with the same-origin browser flow above. Replace
flat snake_case profile reads with `response.user` and its camelCase fields.
Do not copy the old wildcard CORS policy, forward browser credentials to a second
service, or use decoded JWT claims as database IDs or authorization decisions.

The former products, orders, cart, wishlist, recommendations and admin handlers
returned fabricated example data. Those routes have no replacement in this
authentication demo. Arbitrary OAuth clients, cross-origin applications and
role-based application APIs require a separately specified and verified design.

Read [browser-auth.ts](../../src/browser-auth.ts) for session and write ownership
checks, [bearer-profile.ts](../../src/bearer-profile.ts) for `/userinfo`, and
[token-verification.ts](../../src/token-verification.ts) for signed-claim checks.
These are internal Worker modules; use the full [entrypoint](../../src/index.ts)
so request-origin, issuer, cookie and response protections remain in effect.

## Verification

`npm test` exercises the actual bundled Worker with isolated D1/KV. Relevant
coverage includes [bearer profiles](../../test/bearer-profile.test.mjs),
[profile mutations](../../test/profile-mutations.test.mjs),
[session revocation](../../test/profile-revocation.test.mjs) and
[account deletion](../../test/account-deletion.test.mjs). Google's external
responses are fixtures. See [verification evidence](../../docs/verification.md);
local tests do not establish a successful live Google deployment.
