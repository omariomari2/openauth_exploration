# Test results and known limits

## Latest results

The published code passed 206 backend tests and 26 Chromium tests. The dependency audit found zero known vulnerabilities.
These tests simulate Google. They do not verify a live Google login or a Cloudflare deployment.

| Check | Result |
| --- | --- |
| [GitHub run 37176672372](https://github.com/omariomari2/openauth_exploration/actions/runs/37176672372) at `ed1a24c` | All workflow steps passed after the documentation update. |
| [GitHub run 37176367468](https://github.com/omariomari2/openauth_exploration/actions/runs/37176367468) at `0c420a6` | Ubuntu 24.04: 206 backend tests, 26 browser tests, zero failures, skips, cancellations or dependency advisories. |
| Local release checks | Clean install, build, 206 backend tests, 26 Chromium tests and dependency audit passed. |

Publication on 2026-10-03 used a fast-forward push of 31 atomic commits through `0c420a6` to `main`.
`omariomari2` is the sole author and committer of all 31 commits. Release review found no source-publication blocker.

The owner approved source publication only. No Cloudflare sign-in, resource creation, remote migration or deployment occurred.

## Known limits

These checks or controls remain incomplete:

- Real Google login with two separate accounts and an isolated deployment.
- Production HTTPS cookie-prefix enforcement and live scheduled cleanup.
- Physical browser-tab switching and actual back/forward cache restoration.
- Authentication throttling and required-check branch protection.
- Full accessibility and performance assessments.

One earlier legitimate-login setup returned `400`. Diagnostic runs did not reproduce it. Its cause remains unproven.
The separate key-initialization and KV-expiry defects have confirmed causes and fixes. Neither establishes the cause of that original `400`.

The remaining work is in `tasks/todo.md`.

## Run the browser checks

Use Node 24.19.0 and npm 11.17.0. The local verification host ran Windows x64.
Run these steps without cloud credentials:

1. Install the locked dependencies without install scripts.

   ```sh
   npm ci --ignore-scripts
   ```

2. Download Chromium for the browser tests.

   ```sh
   node node_modules/playwright/cli.js install chromium
   ```

3. Run the browser tests.

   ```sh
   npm run test:browser
   ```

Chromium is an explicit test download. The npm install does not download it through an install hook.

## Test boundaries

The tests run the bundled Worker in workerd with isolated D1 databases and KV storage.
Browser tests use loopback HTTP and temporary Chromium contexts.
They simulate Google's authorization page, token endpoint and UserInfo endpoint. The Worker contains no test-login bypass.

The browser harness intercepts Google redirects through the Chrome DevTools Protocol (CDP).
A local proxy blocks Chromium HTTP(S) traffic outside the exact Worker origin, including new popups. The proxy never forwards traffic.
The Worker fetch mock separately blocks unapproved outbound requests. Explicit local API requests from the test runner are outside the browser-traffic boundary.

Sign-ins run sequentially. Each browser flow consumes its own single-use Google token fixture.
The proxy uses Chromium's documented [exact-origin bypass and subtraction of implicit loopback rules](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md).
This HTTP(S) test boundary is not a general browser security sandbox.

The runtime harness lists the bundled ES module explicitly.
Automatic dependency scanning cannot resolve Hono's dynamic `cloudflare:workers` built-in import.
Requests use manual redirects so assertions inspect the first response.

## Historical evidence

The sections below record individual implementation changes. Their test counts are historical milestones, not additional current-suite totals.
The local milestones used no cloud credentials or remote databases. Source publication and hosted CI happened after these milestones.

Independent reviews covered the identity, storage, issuer, API, browser, removal and retention changes. Their follow-up checks found no remaining actionable findings.
The records below retain specific findings, failed regressions and verification limits.

### Runtime and toolchain

The baseline on 2026-10-03 passed four runtime tests and `npm run build`.
It used the bundled Worker, workerd, isolated KV and isolated D1 with all three existing migrations.
That baseline did not establish authentication security or real Google login.

Each dependency upgrade passed the four runtime tests and TypeScript checks before and after the change.
A clean `npm ci --ignore-scripts` and full audit passed with zero advisories.

The deployment regression first failed on an automatic remote-migration hook. It passed after that hook was removed.
Remote migrations now require `migrate:remote`.
Renamed-Worker development and production shortcuts were removed because they shared database and KV resources.
The inherited bindings stayed unchanged. They are not approved resources for an isolated deployment.

### Google identity

Eighteen focused tests passed against validated UserInfo fixtures and local D1. TypeScript checks passed.
Coverage included simultaneous sign-ins, case-variant email conflicts, batch rollback, legacy-row preservation and deletion cascades.
Malformed or missing claims, stalled responses and oversized provider responses all fail closed.

Bundled integration tests traversed the authorization, provider and callback routes.
Only Google's token and UserInfo endpoints were simulated; other outbound calls were blocked.
Two verified subjects created separate users. Unverified email created no user. Password routes returned `404`.

A Worker regression exposed unsupported `redirect: "error"` behavior that Node helper tests missed.
UserInfo now uses manual redirects and rejects every non-200 status. This prevents credential forwarding.
The bundled flow passed after the change.

### Browser-authentication storage

Thirteen D1 tests passed. An independent review reran all thirteen.
They checked independent random browser binding, atomic single-use callback consumption, expiry, hashed session tokens, logout, user isolation and deletion cleanup.
Twelve simultaneous callback-consumption calls produced exactly one winner.

The full suite then passed 40 tests and TypeScript checks.

### Access-token verification

Thirty-seven signed-token tests passed. An independent review reran all 37 against OpenAuth's claims and JOSE's validation rules.

The tests covered these boundaries:

- ES256 signatures, forged signatures, malformed inputs and key rotation.
- Exact issuer, one client audience, required expiry and subject claims.
- Access-token and user schemas.
- The database identity in `properties.id`, rather than the JWT subject.

Verification never refreshes a token.
JOSE 5.9.6 became a direct dependency at the version already installed.
Each verification uses a fresh local JWKS resolver with caller-supplied trusted keys. The resolver makes no network requests.

### Issuer request policy

Six focused tests passed for canonical HTTPS or loopback configuration, exact client registration and exact callbacks.
They also covered S256 requirements, duplicate or unsupported parameters, origin validation and forwarding-header removal.

Review found that Hono decoded route names after the policy's literal path check.
Regressions reproduced authorization without PKCE through `/%61uthorize`.
Rejecting encoded aliases closed the bypass for the service's fixed ASCII routes.
The stricter policy requires a browser-bound login transaction.

### Issuer cookies

Seventeen focused tests passed with a real JOSE-encrypted fixture. An independent review reran all 17.
The adapter maps OpenAuth's two internal cookie names to host-prefixed HTTPS names.
It removes untrusted legacy names, rejects duplicates and preserves cookie deletion.
The later HTTP tests cover the two-browser transplant regression. These adapter checks do not prove browser enforcement of HTTPS prefixes.

### Browser HTTP flow

Seventeen HTTP integration tests covered login, callback exchange, verified session creation, private profile reads and CSRF-protected logout.
Coverage included these cases:

- Separate accounts, transplanted callbacks, replay and concurrent callbacks.
- PKCE failure and transaction or session expiry.
- Repeat-login rotation and duplicate cookies.
- Current D1 profile data and per-session logout revocation.

A sibling-domain provider-cookie injection initially reached Google and could select the attacker's account.
With host-prefixed issuer cookies, the regression contacted no Google endpoint and created no user or session.
On mismatched provider state, OpenAuth restarts at the exact same-origin Google authorization route. It does not accept the application callback.

Three additional HTTP tests checked security headers, generic internal failures and separate loopback HTTP cookies.
Logging tests checked protected-cookie deletion and the absence of sensitive values in captured logs.
`npm test` passed 123 tests with zero failures or skips. `npm run build` and `git diff --check` passed.
The browser interface later replaced this milestone's authenticated JSON root.

The earlier legitimate-login `400` did not recur in focused, full-file or full-suite diagnostic runs.
No retry or skipped assertion was added to conceal it.

### Issuer key initialization

A separate source probe confirmed OpenAuth's cold-key race.
Concurrent initialization of an empty store could persist two encryption keys. A later callback tried only the newest key.
The older key could still decrypt its original cookie.

Thirteen adapter tests passed against isolated D1 and KV after the fix.
A scheduling barrier made twelve independent adapters observe an empty key table before invoking the installed OpenAuth generators.
All adapters converged on one persisted key per purpose.
Tests covered immutability, corrupt rows, generic errors, legacy-key isolation and preservation of user and session rows through the additive migration.

A bundled-Worker regression failed before adapter wiring and passed afterward.
Concurrent provider and JWKS requests used D1 keys and left no key material in KV.
Twenty focused key, logging and runtime tests passed with TypeScript checks.
The logging fixture now applies migrations because issuer keys require D1.
These results do not verify a deployment across multiple regions.

### OAuth-state expiry

A separate intermittent callback failure was traced to an upstream KV write.
Its floor calculation converted 59,999 remaining milliseconds to a rejected TTL of 59 seconds.
The deterministic real-KV regression failed with `Invalid expiration_ttl of 59` before the expiry-aware adapter, then passed.

Twelve focused tests covered exact deadlines and longer or fractional lifetimes.
They also checked malformed envelopes, invalid dates, delayed reads, expired overwrites, scan pagination and protection of newer concurrent values.

Bundled cold and warm tests started six browser-client flows together.
They completed distinct Google fixtures sequentially and verified six isolated private profiles.
Warm-up success was asserted. These were workerd/D1/KV tests, not real-browser tests.
Separate concurrent-generator tests supplied the deterministic key-race evidence.

Five additional consecutive cold/warm runs passed, covering 60 simulated logins. The diagnostic command stopped immediately on any failure.
`npm test` then passed 152 tests with zero failures or skips. TypeScript and the full dependency audit passed with zero advisories.
No production or test retries were added.

### Bearer profile API

Nine bundled-Worker tests first failed because `/userinfo` did not exist. They passed after the handler was connected.
They covered real OpenAuth access tokens, account isolation, invalid signed claims, forgery, tampering and ambiguous headers or queries.
They also rejected browser-cookie fallback and access to deleted or recreated accounts.
The endpoint returns current D1 profile fields and roles, without stale or extra JWT claims.

The tracked tests plus the new bearer tests passed all 161 cases with `node --test --test-concurrency=1`.
TypeScript checks passed. Google endpoints still used simulated responses.

### Profile updates

The first HTTP regression returned `405` before PATCH existed.
Seven input tests and seven bundled-Worker tests covered allowed fields, omission, clearing, Unicode and invalid controls.
They also checked SQL/HTML-like data, CSRF, account isolation, concurrent independent edits and oversized or stalled bodies.
Both the reader and an actual Worker request enforced the five-second timeout.

Review reproduced acceptance of C1 controls. The focused regression failed before the rejection range changed and passed afterward.

Three deterministic tests wrapped the unchanged Worker and real D1 in memory.
After the authenticated profile read, the wrapper revoked, expired or changed that exact session's CSRF token.
Another session for the same user stayed live. Every attempted write was rejected.
`PROFILE_GUARD_MUTATION=1` disabled only the SQL guard in memory and made all three tests fail.
These tests replaced a timing-dependent revocation test. The wrapper is absent from the deployable bundle.

Forty-six focused browser, bearer and profile tests passed, together with TypeScript checks.

### Account deletion

Initial refresh-token and authorization-code regressions issued tokens after deletion of the D1 account.
Each grant read now checks its original user ID in D1. Missing or malformed subjects and database failures fail closed.
Adapter tests preserve the complete OpenAuth payload, expiry and cleanup behavior.

Eight bundled-Worker deletion tests checked session and CSRF requirements, request boundaries, account-row cascades and four cookie clears.
They also checked account isolation and old credentials after a new signup with the same Google identity.

Four additional tests intervened after an authenticated profile read.
They revoked, expired or rotated the exact session, or failed DELETE before execution.
The service denied deletion without clearing cookies. Storage failure preserved the account and related rows.
`DELETE_GUARD_MUTATION=1` disabled only the SQL guard in memory and made all three session-race tests fail.

### Grants already in progress

Two real-issuer tests deleted the user after grant lookup but before code exchange or refresh completed.
Issuance could finish, but the service denied the access token and rejected its next refresh.
The real KV record retained a bounded one-hour lifetime from its final write.
`GRANT_GUARD_MUTATION=1` disabled the grant guard in memory and made both renewal assertions fail. The wrappers are not deployed.

Fixture checks confirmed that Miniflare drops empty headers before Worker execution. D1's affected-row count includes cascades.
Tests therefore send nonempty competing credentials and count the deleted user through `RETURNING id`. Production checks stayed unchanged.

Retention documentation distinguishes account deletion from residual grants, pending anonymous transactions, in-flight requests and D1 backup history.
`npm test` passed 198 tests with zero failures or skips.
`npm run check` passed the build and dry run. `npm audit --ignore-scripts` found zero known vulnerabilities.

### Chromium harness regressions

Browser checks covered the actual PKCE callback, loopback HttpOnly/SameSite cookie metadata, current D1 profiles, account isolation and per-session logout.

Four fixture regressions initially allowed token exchange with missing or incorrect Google client IDs or secrets.
The fixture now rejects those requests without creating sessions.
A popup regression initially escaped through one TCP connection.
After the proxy fix, popup, redirected-popup and HTTPS CONNECT probes reached no forbidden listener.
Every probe destination was a controlled local server.

A clean script-disabled install, build and dry-run bundle passed.
All 198 backend tests and eight browser-foundation tests passed. The audit found zero known vulnerabilities.
The browser-foundation command was:

`node --test --test-concurrency=1 test/browser/network.test.mjs test/browser/harness.test.mjs test/browser/session.test.mjs`.

### Profile screen

Initial HTTP tests failed on the old root redirect, missing HEAD handling and absent asset or CSP support.
The real-browser save test failed before the client handler existed.
The screen now supports Google sign-in, profile edits, sign-out and account-bound deletion confirmation.
The screen keeps tokens out of browser storage and loads no external assets. Worker TypeScript and browser JavaScript checks passed.

Three HTTP tests verified a shell without account data, same-origin assets, security headers, methods and origin rejection.
The wrong-origin probe uses Node's raw HTTP client and Miniflare's local routing header.
Undici Fetch retried `421` by destroying the connection, which caused Windows workerd socket diagnostics despite correct responses.
The raw probe checks the same `421` error body without retries. Production behavior and log filtering stayed unchanged.

### Screen actions and drafts

Browser tests verified save, reload, logout, cancelled or confirmed deletion, account isolation, literal HTML-looking names, stale confirmation and expired sessions.
A test-only database wrapper let a write succeed before its response failed.
The screen then cleared private data, blocked automatic retries and required another sign-in. The wrapper is not deployed.

Background checks retain a dirty draft and its original baseline only for the same account and CSRF token.
Tests changed D1 independently and signed in through a second tab.
Untouched fields survived saves. Account or session changes discarded old drafts and deletion confirmations.

### Navigation and layout

Trusted `pagehide` events cleared private DOM data and disabled controls before navigation.
A held successful PATCH response verified the uncertain-action lock at `pagehide`. History return loaded updated D1 data.
Both events had `persisted=false`. These navigation tests did not prove hidden-tab behavior, live-document late-response rejection or back/forward cache restoration.

Screenshot checks used widths of 320, 768, 1024 and 1440 pixels. No horizontal overflow appeared.
Browser checks covered labels, deletion keyboard and focus behavior, and selected text contrast pairs at 4.5:1.
No JavaScript or CSP errors appeared. Console checks exclude only the expected anonymous-profile `401`.
These checks are not a complete accessibility certification or performance assessment.

`npm run build` passed. `npm test` passed 201 cases.
`node --test --test-concurrency=1 test/browser/*.test.mjs` passed 20 cases. None failed or skipped.

### Legacy integration removal

The owner approved removal of the obsolete SDK, unsigned-token helpers, middleware, standalone HTML/React/API examples and their entrypoint re-exports.
Replacement guides describe the tested same-origin implementation and breaking source imports. External consumers of copied code remain unknown.
This change added no database migration or dependency.

A bundled-Worker export regression failed before removal and passed afterward.
Ignored TypeScript outputs for the three retired source modules were also removed because incremental builds leave stale files.
Git history retains the source, but it is unsupported.
Review found an old analysis guide that appeared current. It now has a historical/unsupported warning and links to supported guides.

A clean script-disabled install, build and bundle passed, followed by 202 backend tests and 20 Chromium tests.
None failed or skipped. The audit found zero known vulnerabilities.
The bundle fell from 365.78 KiB (83.33 KiB gzip) to 347.07 KiB (79.26 KiB gzip).

### CI and local setup

The Actions workflow passed actionlint 1.7.12 and security review.
An initial Linux source review found no portability blocker. Hosted Ubuntu execution followed later, as recorded in the latest results.
The [CI decision](decisions/006-ci-checks.md) records tool versions, permissions and verification limits.
Branch-protection settings have not changed.

The README separates local setup from deployment and identifies the Google callback and local secret file.
`.dev.vars.example` contains placeholders only. Git ignores `.dev.vars`.

Wrangler applied all six local migrations in the isolated `test-results/wrangler-setup-check` persistence directory.
Local development used `127.0.0.1` with remote bindings disabled.
At the canonical localhost origin, `/` and all three assets returned `200`; `/api/profile` returned `401` without credentials.
All five responses used `no-store`. The test's development process was stopped afterward.
This check used no Google credentials or remote database and did not establish a successful provider login.

### Scheduled retention cleanup

Regressions first failed because the Worker lacked a scheduled handler and trigger.
The hourly handler now uses the existing indexed expiry cleanup without initializing Google authentication.
Real workerd scheduled events removed expired transactions and sessions while preserving active credentials, user data and unrelated KV records.
Repeated and overlapping invocations were safe.

A real local D1 trigger aborted the second DELETE and proved that the complete batch rolled back.
Removing that test trigger let the next invocation recover.
A separate capture test injected a private database-error marker. It verified a failed event and a generic structured cleanup log.
Neither runtime stream exposed the marker. These tests installed no trigger in a live database.

Build and dry-run bundle checks passed, followed by 205 backend tests and 20 browser tests. None failed or skipped.
No dependency or migration changed.
The [retention decision](decisions/007-authentication-retention.md) distinguishes immediate expiry from physical deletion, which needs successful cleanup.
Live scheduled execution remains unverified.

### Remote-operation guard

Launch review found that remote npm helpers still selected inherited Worker, D1 and KV settings despite the README warning.
A command regression failed before the helpers changed to the separate `wrangler.deploy.json`, then passed.
The change covers both secret-setting commands. Local development now specifies `--local`.

The deployment file does not exist.
A real Wrangler deployment dry run failed with `Could not read file: wrangler.deploy.json` before any remote operation.
Both tooling tests passed. The check created no resource, credential, migration or deployment.
The recorded read-only `wrangler whoami` check reported unauthenticated.

The guard prevents accidental target selection by the supplied npm helpers. It does not restrict manually entered Wrangler commands.
Create the separate file only after account and resource approval. Copying inherited resource IDs does not provide isolation.

### Visibility and delayed responses

Six Chromium tests used trusted hidden and visible events without navigation.
They verified immediate private-data clearing, revalidation and rejection of an older profile response after a newer response.
Successful save, logout and deletion responses arriving after hiding left the uncertain-action lock active.
Requests used the actual Worker and isolated D1/KV. Only response delivery was delayed.

A test-only observer is appended to the client asset in memory. It awaits each unchanged handler, including JSON parsing, and records its invocation ID.
Assertions await that exact completion. The observer records no identity, payload or credentials and is not deployed.
A temporary probe removed lifecycle invalidation and delayed parsing by 150 ms. Four intended assertions failed.
All probe changes were removed. Injected request and delivery failures exited without unhandled rejections; waits and context teardown remain bounded.

Review caught premature completion assertions and unobserved failure promises.
The fixes covered those failures and both visible-refresh waiters. Follow-up review found no remaining actionable findings.

The helper isolates a guarded private CDP-session dependency in Playwright 1.63.0.
Chromium emits the events. Document markers and the absence of `pagehide` show that the original document remains alive.
This does not prove physical tab switching or back/forward cache restoration.

### Back/forward cache limit

Separate navigation checks in Chromium 153.0.8010.12 still returned `persisted=false` after removal of Playwright's explicit BFCache-disable flag.
The result occurred with and without the harness's Fetch interception.
Reported reasons included `no-store` document and fetch responses, browser-delegate limits and browsing-instance limits.
Chrome documents the [no-store fetch eviction rule](https://developer.chrome.com/docs/web-platform/bfcache-ccns).
Production privacy headers stayed unchanged. Actual back/forward cache restoration remains unverified.

### Local checks before publication

After `npm ci --ignore-scripts`, both `npm run build` and `npm run bundle:test` passed.
`node --test --test-concurrency=1 test/*.test.mjs` passed 206 tests in 83.27 seconds.
The same command over `test/browser/*.test.mjs` passed 26 tests in 39.39 seconds.
There were no failures, cancellations or skips. The audit found zero advisories, and actionlint 1.7.12 passed.
These results preceded source publication and the hosted CI runs listed at the top.
