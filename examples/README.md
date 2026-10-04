# Supported integration example

This project supports one Google-first, same-origin private-profile demo. Its
working browser and API implementation lives in `src/` and is served by the
configured Worker. These guides explain how to run and adapt that implementation:

- [Browser integration](frontend-integration/README.md): sign-in, session-backed
  profile reads and edits, sign-out, and account deletion through the existing UI.
- [Protected API](api-protection/README.md): the current credential boundaries and
  request/response contracts, with links to implementation and tests.
- [Project setup](../README.md) and [verification evidence](../docs/verification.md).

## Legacy retirement and migration

The following obsolete implementations were removed on 2026-10-03, together
with their value and type re-exports from `src/index.ts`:

- `src/client-sdk.ts`
- `src/helpers/token-validation.ts`
- `src/middleware/auth.ts`
- `examples/frontend-integration/vanilla-js.html`
- `examples/frontend-integration/react-example.tsx`
- `examples/api-protection/worker.ts`

This is an intentional breaking source-import change. The old SDK stored bearer
credentials in localStorage and omitted the required PKCE flow; its profile
contract differed from the implemented API. The helpers included unsigned token
decoding and unsafe role/state utilities. The API example advertised fabricated
ecommerce data. Keeping these implementations would misrepresent the supported
authentication and ownership protections.

The in-repo consumers were the entrypoint re-exports, frontend SDK snippets and
React import, the vanilla page's independent SDK copy, and the middleware API
example. Those consumers are now retired. The npm package is marked `private`,
but usage in other repositories or copied applications is unknown; this removal
does not establish that all external consumers migrated. Owners of such copies
must audit their imports and behavior before upgrading. Git history preserves
the removed source for investigation, not as a supported fallback.

Previously emitted `dist/client-sdk.js`, `dist/helpers/token-validation.js` and
`dist/middleware/auth.js` can survive an incremental TypeScript build. Remove
those obsolete build artifacts from existing checkouts and stop importing them;
they are not part of the current Worker bundle or a supported package API.

The guides above migrate the approved profile use case to the existing demo.
They do not provide replacement SDK exports, framework hooks, arbitrary client
registration, cross-origin authentication, role middleware, rate limiting, or
ecommerce features. Existing database migrations and data are unchanged by this
retirement.

Local integration and Chromium tests exercise the canonical implementation with
real local D1/KV and fixtures for Google's external responses. Real Google login,
production HTTPS behavior and an isolated live deployment remain unverified; see
the evidence document for the exact completed checks and outstanding gaps.
