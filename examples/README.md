# Integration guide

Start with [project setup](../README.md).

This project supports one Google-first service for private profiles.
The browser and API share one origin. The configured Worker serves the implementation in `src/`.

- [Browser integration](frontend-integration/README.md) covers sign-in, session-based profile reads and edits, sign-out, and account deletion through the existing UI.
- [Protected API](api-protection/README.md) covers credential rules and request/response contracts. It links to the implementation and tests.

These guides do not provide replacement SDK exports, framework hooks, arbitrary client registration, or cross-origin authentication.
They do not provide role middleware, rate limiting, or ecommerce features.

## Migrate an older integration

The npm package is `private`. Use in other repositories or copied applications is unknown.
The removal does not prove that external users have migrated.

1. Check your imports and application behavior before upgrading.
2. Adapt your profile workflow with the guides above.
3. Stop importing the obsolete build files listed below.
4. Remove those three files from existing checkouts.

Incremental TypeScript builds can leave these files:

- `dist/client-sdk.js`
- `dist/helpers/token-validation.js`
- `dist/middleware/auth.js`

These files are outside the current Worker bundle. They are not a supported package API.
The retirement did not change existing database migrations or data.

## Removed source files

On 2026-10-03, the repository removed these files and their value and type re-exports from `src/index.ts`.
This intentionally breaks source imports.

Worker modules:

- `src/client-sdk.ts`
- `src/helpers/token-validation.ts`
- `src/middleware/auth.ts`

Standalone examples:

- `examples/frontend-integration/vanilla-js.html`
- `examples/frontend-integration/react-example.tsx`
- `examples/api-protection/worker.ts`

The old SDK stored bearer credentials in localStorage. It omitted the required PKCE flow.
Its profile contract differed from the API. The helpers decoded tokens without checking signatures.
They also included unsafe role/state utilities.
The API example advertised fabricated ecommerce data. These implementations misrepresented the supported authentication and ownership protections.

The repository retired its entrypoint re-exports, frontend SDK snippets, and React import.
It also retired the vanilla page's independent SDK copy and the middleware API example.
Git history retains the removed source for investigation. It is not a supported fallback.

## Verification limits

Local integration and Chromium tests exercise the implementation with real local D1/KV.
They use fixtures for Google's external responses.
Real Google login, production HTTPS behavior, and an isolated live deployment remain unverified.

Read the [verification evidence](../docs/verification.md) for completed checks and remaining gaps.
