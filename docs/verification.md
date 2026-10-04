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

## Issuer request-policy helper

- Six focused tests pass for canonical HTTPS/loopback configuration, exact client
  and callback registration, S256 requirements, duplicate/unsupported parameters,
  origin validation and forwarding-header removal.
- Fresh review found that Hono decodes encoded route names after the policy's
  literal path check. Regression tests reproduced missing-PKCE authorization via
  `/%61uthorize`; rejecting encoded path aliases closes that bypass for this demo's
  fixed ASCII routes. The reviewer checked the fix and found no further helper issues.
- The helper lands separately from HTTP wiring. The existing demo redirect needs
  a browser-bound login transaction before this stricter policy can be enabled.

## Issuer cookie boundary adapter

- Seventeen focused tests pass using a real JOSE-encrypted fixture. The adapter
  maps OpenAuth's two internal cookie names to host-prefixed HTTPS names, strips
  untrusted legacy names, rejects duplicates and preserves cookie deletion.
- Independent review found no actionable adapter issues and reran all 17 tests.
  The adapter is committed separately; HTTP wiring and the two-browser transplant
  regression belong to the following browser-flow change. These tests do not
  substitute for verification of prefix enforcement in a real browser.

## Browser HTTP flow

- The bundled Worker now handles login, callback exchange, verified session
  creation, private profile reads and CSRF-protected logout. Seventeen HTTP
  integration tests cover two accounts, transplant/replay/concurrent callbacks,
  PKCE failure, transaction/session expiry, repeat-login rotation, duplicate
  cookies, current D1 profile data and per-session logout revocation.
- The regression for a sibling-domain provider-cookie injection first reproduced
  a callback that contacted Google and could select the attacker's account. With
  host-prefixed issuer cookies it contacts no Google endpoint and creates no user
  or session. OpenAuth restarts at the exact same-origin Google authorization
  route on mismatched provider state; this is not an accepted application callback.
- Three additional HTTP tests verify security headers, generic internal failures
  and separate loopback HTTP cookies. Logging tests also verify protected-cookie
  deletion and the absence of sensitive values in captured runtime logs.
- `npm test`: 123 passed, zero failed/skipped. `npm run build` and
  `git diff --check`: passed. Only Google's external endpoints are mocked.
- One earlier legitimate-login setup returned 400 and did not recur in focused,
  full-file and full-suite diagnostic runs. Its cause remains unproven; no retries
  or skipped assertions were added to hide it.
- A separate source-level probe confirmed OpenAuth's cold-key race: concurrent
  empty-store initialization can persist two encryption keys, while a later
  callback decrypts only with the newest one. The older key still decrypts its
  original cookie. This must be fixed before deployment; it is not assumed to
  explain the unrelated mid-suite failure.
- The browser UI, signed-bearer `/userinfo`, profile edits/deletion, CI, real-browser
  checks and real Google deployment verification remain unfinished. The current
  authenticated root returns profile JSON, not the final demo interface.

## Deterministic issuer keys

- Thirteen adapter tests pass against real isolated D1 and KV. A scheduling barrier
  makes twelve independent adapters observe an empty key table before running the
  installed OpenAuth generators; all converge on one persisted key per purpose.
  Tests cover immutability, corrupt rows, generic errors, legacy-key isolation and
  preservation of existing user/session rows by the additive migration.
- A bundled-Worker regression failed before wiring the adapter, then passed:
  concurrent provider/JWKS requests use D1 keys and leave no key material in KV.
  Twenty focused key, logging and runtime tests plus TypeScript build pass. The
  logging fixture now applies migrations because issuer keys require D1.
  Independent adapter review found no actionable issues. This is local evidence,
  not a multi-region deployment or real Google/browser verification.
- The separate intermittent callback failure was localized to the upstream KV
  write. A deterministic real-KV probe confirms that its floor calculation turns
  59,999 remaining milliseconds into an unsupported TTL of 59 seconds. That fix
  is a separate slice; a full-suite pass is still required afterward.

## OAuth-state expiry

- A deterministic issuer-storage regression first failed on real KV with
  `Invalid expiration_ttl of 59`. It now passes through the expiry-aware adapter.
  Twelve focused tests cover the exact deadline, longer/fractional lifetimes,
  malformed envelopes, invalid dates, delayed reads, expired overwrites, scan
  pagination and avoiding deletion of a newer concurrent value.
- The bundled cold/warm tests start six browser-client flows together, then
  complete their distinct Google fixtures sequentially and verify six isolated
  private profiles. They are actual workerd/D1/KV tests, not real-browser tests.
  Warm-up success is asserted explicitly. Deterministic key-race evidence remains
  in the separate concurrent-generator tests rather than depending on timing here.
  Five additional consecutive cold/warm runs passed (60 fixture-backed logins),
  with the diagnostic command set to stop immediately on any failure.
- Fresh-context adapter and integration reviews found no actionable defects.
  `npm test`: 152 passed, zero failed/skipped; TypeScript build and full dependency
  audit pass, with zero known advisories. No retries or skipped assertions were
  added to production or to the test suite.
- These fixes resolve the two locally identified reliability defects. The UI,
  API mutations, CI and deployed two-account Google/browser verification remain
  unfinished. The branch is local only; no push or deployment was performed.

## Bearer profile HTTP API

- Nine bundled-Worker tests first failed because `/userinfo` did not exist, then
  passed after wiring the handler. They cover real OpenAuth-issued access tokens,
  two-account isolation, signed negative claims, forgery/tampering, header/query
  ambiguity, browser-cookie fallback rejection and deleted/recreated accounts.
  Only Google's external endpoints are mocked; no deployable auth bypass exists.
- Current D1 profile fields and role are returned, not stale or extra JWT claims.
  Fresh-context design/code review found no actionable issues in this slice.
- All 161 tests in this committed slice pass (`node --test --test-concurrency=1`
  over the tracked test files plus the new bearer test); TypeScript build passes.
  Real Google accounts and browser behavior are still unverified.

## Profile updates

- The first HTTP test failed with `405` before PATCH existed. Seven input tests
  and seven bundled-Worker tests now cover field allowlisting, clearing/omission,
  Unicode, invalid controls, SQL/HTML-like data, CSRF, cross-account isolation,
  concurrent independent edits and oversized/stalled bodies. The five-second
  timeout is verified against both the reader and an actual Worker request.
- Review reproduced acceptance of C1 controls; the focused regression failed
  before extending the rejection range and passed afterward.
- Three deterministic tests use a test-only entry wrapper around the unchanged
  Worker and real D1. After the authenticated profile is read, the wrapper revokes,
  expires or changes the CSRF token of that exact session, leaving another session
  for the same user live. All writes are rejected. Disabling the SQL guard only in
  the in-memory test module (`PROFILE_GUARD_MUTATION=1`) makes all three tests fail.
  The earlier timing-dependent revocation test was replaced by these stronger tests.
- Forty-six focused browser, bearer and profile tests pass, as does TypeScript.
  The test wrapper is not part of the deployable bundle. Browser rendering and
  account deletion are separate unfinished slices.
