# Implementation plan

Scope: the Google-first authentication demo approved by the owner; see `SPEC.md`.

## Architecture decisions to verify

- Retain OpenAuth 0.4.3 and use its documented code/PKCE/client APIs. Enforce the
  audience explicitly: this pinned verifier ignores its audience option.
- Validate Google's UserInfo response and bind identity by provider subject,
  never automatically by email. Record legacy-account conflict handling.
- Keep the demo and profile API same-origin. Use D1 for atomic transaction
  consumption and revocable opaque browser sessions; retain KV for OpenAuth's
  storage. Do not promise globally atomic behavior from eventual-consistent KV.
- Use short-lived OpenAuth access tokens and do not retain provider tokens longer
  than required. The browser demo can establish a bounded application session
  after verification; its logout contract is independent of Google sign-out.
- Test with Node's runner and real Miniflare bindings. Avoid adding a large test
  framework solely to run a small Worker. Isolate external provider fixtures.
- Review/update vulnerable dependencies coherently, pin tooling and block install
  scripts. The baseline audit reports nine high-severity findings.

## Order and checkpoints

1. Baseline/toolchain and safe deployment commands.
2. Identity mapping, migration and negative provider tests.
3. Signed-token verification and real private profile API.
4. PKCE transaction and revocable browser session.
5. Browser demo and supported client/example integration.
6. CI, reproducible setup, security/retention documentation and review.
7. Dedicated deployment and real two-account Google/browser smoke checks.

Commit each verified slice separately. Stop on a failing build/test and fix the
root cause before moving to the next slice. Keep review-driven fixes separate
when they form an independent logical change.

Parallel research/review is safe; serialize shared schema/contracts and commits.
Do not let agents independently deploy, alter Git identity or commit mixed work.

## Baseline evidence (2026-10-03)

- Source: `810f0d4`, clean clone; branch `feat/verified-auth-demo`.
- Node 24.19.0, npm 11.17.0, Windows x64.
- `npm ci --ignore-scripts --no-audit --no-fund`: passed, 63 packages.
- `npm run build`: passed.
- Direct Wrangler 4.21.2 dry-run: passed, 291.20 KiB bundle, 63.73 KiB gzip.
- No automated tests/CI. `npm audit`: nine high, no critical findings.
- `wrangler whoami`: unauthenticated. No deployment performed.
- Existing `deploy:dev`/`deploy:prod` share bindings; `predeploy` migrates remote
  data before building. Neither is safe for the isolated demo workflow.

## Design review disposition

Fresh-context review found four actionable gaps in the proposal: missing explicit
browser binding of OAuth transactions; OpenAuth's query-string logger; unsafe
error redirects before authorization allowlisting; and trusted forwarded headers.
All four are now explicit SPEC requirements with regression tests planned. The
owner selected fresh-context reviews and tests only, without a separate CLI review.
Source checks confirmed the dependency behaviors in installed OpenAuth 0.4.3 and
Hono; no findings were dismissed as noise.

## Risks

Google credentials and authenticated Cloudflare deployment require owner input.
Do not reuse committed resource IDs without confirming ownership and isolation.
Keep the original database and historical migrations intact. Existing example
APIs are sketches; update compatibility notes when replacing unsafe client APIs.
Tests with simulated Google responses prove app behavior, not a real Google login.
