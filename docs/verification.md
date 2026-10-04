# Verification record

## Local runtime baseline (2026-10-03)

- Node 24.19.0, npm 11.17.0, Windows x64.
- `npm test`: four passing tests against the bundled Worker, real workerd,
  isolated D1 (all three existing migrations), and isolated KV.
- `npm run build`: passed.
- The harness explicitly lists the bundled ES module. Automatic dependency
  scanning cannot resolve Hono's dynamic `cloudflare:workers` built-in import.
- Requests use manual redirects so tests assert the first response, not the
  redirected page. No cloud credentials or remote database operations are used.

This is a baseline, not evidence that authentication is secure or that real
Google login works. Those checks remain open in `tasks/todo.md`.

## Toolchain and explicit deployment operations

- Dependency upgrades: four runtime tests and TypeScript pass before/after each
  change; clean `npm ci --ignore-scripts` and full audit pass with zero advisories.
- The deployment-script regression failed on the automatic remote migration hook
  before its removal, then passed. Remote migrations now require `migrate:remote`.
- Removed renamed-Worker dev/prod shortcuts that shared the same database/KV.
  Existing bindings are unchanged and must not be used for the isolated demo.

## Google identity helper

- Eighteen focused tests pass against validated UserInfo fixtures and real local
  D1, including simultaneous sign-ins, case-variant email conflicts, batch rollback,
  legacy-row preservation and deletion cascade. Invalid/missing claims and stalled
  or oversized provider responses fail closed. TypeScript passes.
- The identity schema and mapping helpers received an independent security review
  with no actionable findings. They are not yet evidence of a working login flow:
  deployed Google verification remains pending.

## Bundled Google issuer integration

- Integration tests traverse the actual authorization/provider/callback routes,
  mocking only Google's token and UserInfo endpoints; other outbound network calls
  are blocked. Two verified subjects create distinct users; unverified email is
  rejected without creating a user. Password routes return 404.
- The Worker regression exposed an unsupported `redirect: "error"` setting that
  Node helper tests missed. UserInfo now uses manual redirects and rejects every
  non-200 status, preventing credential forwarding. The fixed bundled flow passes.
- Independent review found no actionable issues in this slice. These checks use
  provider fixtures, not real Google accounts or browser sessions.

## Browser-authentication persistence

- Thirteen real-D1 tests pass for independent random browser binding, atomic
  single-use callback consumption (one winner among twelve simultaneous calls),
  expiry, hashed session tokens, logout, per-user isolation and deletion cleanup.
- An independent reviewer found no actionable issues and reran all thirteen tests.
- The full local suite now passes 40 tests and TypeScript builds. HTTP cookie,
  CSRF and browser integration are still pending; these helpers alone do not prove
  a secure browser login.

## Strict access-token verifier

- Thirty-seven signed-token tests pass for ES256 signatures, exact issuer and
  single-client audience, required expiry/subject claims, access/user schema,
  forged signatures, malformed input and key rotation. The returned identity is
  `properties.id`, not the JWT subject. Verification never refreshes a token.
- JOSE 5.9.6 is declared directly at its existing installed version. A fresh local
  JWKS resolver uses only caller-supplied trusted keys; it performs no network IO.
- Independent review checked the implementation against OpenAuth's emitted claims
  and JOSE's validation semantics, reran all 37 tests and found no actionable issues.
- This verifier is not yet connected to the protected HTTP API. Passing its unit
  tests does not establish end-to-end access control or a working browser session.
