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

## Account deletion and residual grants

- The initial real refresh/code regressions reproduced successful token issuance
  after the D1 account was deleted. Each grant read now validates its original
  user ID against D1; malformed/missing subjects and database failures fail closed.
  Adapter tests preserve the full OpenAuth payload, expiry and cleanup behavior.
- Eight bundled-Worker deletion tests cover session/CSRF requirements, request
  boundaries, all account-row cascades, four cookie clears, isolation and old
  credentials after a fresh signup using the same Google identity.
- Four additional tests intervene after a genuine authenticated profile read:
  revoke/expire/rotate the exact session, or fail the DELETE before execution.
  Deletion is denied without clearing cookies; failure preserves the account and
  related rows. Disabling only the SQL guard in memory makes all three session
  race tests fail (`DELETE_GUARD_MUTATION=1`).
- Two real-issuer tests delete the user after the grant lookup but before code
  exchange/refresh completes. Issuance may finish, but its access token is denied,
  its next refresh is rejected, and the real KV record retains a bounded one-hour
  lifetime from its final write. Disabling the grant guard in memory makes both
  renewal assertions fail (`GRANT_GUARD_MUTATION=1`). Neither wrapper is shipped.
- Test-fixture corrections were verified separately: Miniflare drops empty
  headers before the Worker receives them, and D1's affected-row count includes
  cascades. Tests now send real nonempty competing credentials and count the
  deleted user via `RETURNING id`; no production checks were weakened.
- Independent implementation and test reviews found no actionable defects.
  The retention documentation distinguishes live account deletion from residual
  grants, pending anonymous transactions, in-flight requests and D1 backup history.
- `npm test`: 198 passed, zero failed/skipped; `npm run check`: build and dry-run
  passed; `npm audit --ignore-scripts`: zero known vulnerabilities. No push,
  deployment or changes to live resources were performed.
  Browser UI, CI and real Google/browser deployment verification remain unfinished.

## Isolated Chromium session harness

The browser suite uses the bundled Worker over loopback HTTP, real isolated D1/KV,
and temporary Chromium contexts. Only Google's authorization page, token endpoint
and UserInfo are fixtures; the Worker has no test-login bypass. CDP intercepts the
managed pages' Google redirects. A deny-only local proxy additionally confines
Chromium HTTP(S), including new popups, to the exact Worker origin. It never
forwards traffic. Worker outbound requests are separately confined by the fetch
mock. The test runner's explicit local API requests are not browser traffic.
Sign-ins run sequentially so each one-use Google token fixture is consumed by its
corresponding browser flow.

Install and run locally (no cloud credentials):

```sh
npm ci --ignore-scripts
node node_modules/playwright/cli.js install chromium
npm run test:browser
```

Chromium is an explicit test-only download, not an npm install hook. These tests
check the actual PKCE callback, loopback HttpOnly/SameSite cookie metadata, current
D1 profile data, two-account isolation and per-session logout. They do not prove
real Google login, production HTTPS cookie-prefix enforcement or a completed UI.

The proxy uses Chromium's documented [exact-origin bypass and subtraction of
implicit loopback rules](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md).
This is a test HTTP(S) boundary, not a general-purpose browser security sandbox.

- Review identified missing Google client-credential validation in the fixture.
  Four tests reproduced successful login with missing/wrong client IDs or secrets
  during token exchange; they now reject those requests without creating sessions.
- A popup regression reproduced one escaped TCP connection before the proxy fix.
  Popup, redirected-popup and HTTPS CONNECT probes now reach no forbidden listener;
  all probe destinations are controlled local servers, not public services.
- Independent follow-up review found no remaining actionable issues in this slice.
  After a clean script-disabled install, build and dry-run bundle passed, all 198
  existing backend tests passed, and eight browser-foundation tests passed:
  `node --test --test-concurrency=1 test/browser/network.test.mjs test/browser/harness.test.mjs test/browser/session.test.mjs`.
  The dependency audit reported zero known vulnerabilities. Unfinished UI work is
  excluded from this commit; no push, deployment or live-resource changes occurred.

## Same-origin profile screen

- The initial HTTP screen tests failed on the old root redirect, missing HEAD
  handling and absent asset/CSP support. The real-browser save test failed before
  the client handler existed. The screen now supports Google sign-in, profile
  editing, sign-out and account-bound deletion confirmation without token storage
  or external assets. Worker TypeScript and browser JavaScript type checks pass.
- Three HTTP tests verify the identity-independent shell, same-origin assets,
  security headers, methods and origin rejection. The wrong-origin probe uses
  Node's raw HTTP client with Miniflare's own local routing header: Undici Fetch
  retries 421 by destroying the connection, which caused Windows workerd socket
  diagnostics despite correct responses. The raw probe checks the same 421/error
  body without retrying. No production behavior or log filtering changed.
- Browser tests verify save/reload/logout, cancel/confirm deletion, cross-account
  isolation, literal HTML-looking names, stale confirmation and expired sessions.
  A test-only database wrapper proves that a write can succeed before its response
  fails; the screen clears private data, forbids automatic retries and requires
  reauthentication. The wrapper is not deployed.
- Background revalidation retains a dirty draft and its original baseline only
  for the same account and CSRF token. Tests change D1 independently and sign in
  through a second tab, proving untouched fields survive saves and account/session
  changes discard old drafts and deletion confirmations.
- Trusted pagehide events clear private DOM and disable controls before real
  navigation. A held real successful PATCH response verifies the uncertain-action
  lock at pagehide. History return loads updated D1 data. Both observed events had
  `persisted=false`: these tests do not prove BFCache restoration, hidden-tab
  visibility behavior or late-response suppression in a still-live document.
  Those remain explicit verification gaps, not passing assertions.
- Screenshots were inspected at 320, 768, 1024 and 1440 pixels with no horizontal
  overflow. Browser checks cover labels, deletion keyboard/focus behavior and
  selected text contrast pairs at 4.5:1. No JavaScript/CSP errors were observed;
  the expected anonymous profile 401 is narrowly excluded from console failures.
  This is not a complete accessibility certification or performance assessment.
- Fresh-context source and test reviews found no remaining actionable defects
  in this slice after adding draft and pagehide coverage. Local verification:
  `npm run build`, `npm test` (201 passed), and
  `node --test --test-concurrency=1 test/browser/*.test.mjs` (20 passed), with no
  failed or skipped tests. Google remains a boundary fixture; production HTTPS,
  real Google accounts and isolated deployment remain unverified. CI and supported
  external integration examples are still pending. No push or live changes.

## Legacy integration retirement

- With owner approval, removed the obsolete SDK, unsigned-token helpers, middleware
  and standalone HTML/React/API examples, including their entrypoint re-exports.
  The replacement guides point to the existing tested same-origin implementation,
  describe the breaking source imports and identify external copied consumers as
  unknown. No database migration or dependency changed in this retirement.
- A bundled-Worker export regression first reproduced the legacy exports, then
  passed after removal. Existing ignored TypeScript outputs for the three retired
  source modules were also removed; incremental builds do not remove stale files.
  Git history preserves the source, but it is not a supported fallback.
- Fresh-context review found an old tracked analysis guide that still appeared
  current. It now carries a prominent historical/unsupported warning and links to
  the supported guides. Follow-up review found no remaining retirement issue.
- After a clean script-disabled install, build and bundling passed; 202 backend
  tests and 20 Chromium tests passed with zero failures or skips. The dependency
  audit reported zero known vulnerabilities. The Worker bundle is 347.07 KiB
  (79.26 KiB gzip), down from 365.78 KiB (83.33 KiB gzip) before retirement.
  Google remains a fixture in these tests; no push or live changes occurred.

## Credential-free CI and local setup

- The new Actions workflow passes actionlint 1.7.12 and fresh-context security
  review. A separate source-level Linux portability review found no blocker;
  this is not a Linux execution result. See the [CI decision](decisions/006-ci-checks.md)
  for pinned tools, permissions and verification limits. No GitHub-hosted job has
  run for this branch and no branch-protection settings have changed.
- The rewritten README distinguishes local setup from unverified deployment and
  documents the Google callback and ignored local secret file. The checked-in
  `.dev.vars.example` contains placeholders only; `.dev.vars` remains ignored.
- Actual Wrangler local migration applied all six migrations successfully into
  the isolated `test-results/wrangler-setup-check` persistence directory. Local
  dev, explicitly bound to 127.0.0.1 with remote bindings disabled, returned 200
  for `/` and all three assets at the canonical localhost origin; `/api/profile`
  returned 401 without credentials. All five responses used no-store. The owned
  dev process was stopped afterward. This did not use real Google credentials or
  any remote database, and does not verify a successful provider login.
