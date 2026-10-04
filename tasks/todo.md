# Task checklist

- [x] Inspect current source, establish baseline and dedicated branch/author.
- [x] Confirm Google-first scope with owner.
- [x] Review architecture/security contract before implementation; incorporate
  browser-bound callbacks, request-log redaction, prevalidated redirects and
  configured issuer origin. Owner chose fresh-context reviews and tests only.
- [x] Toolchain: triage audit, pin compatible dependencies, disable install scripts,
  add a runnable test harness and remove automatic remote migration hooks.
  Verify clean install, build, dry-run and a real-runtime baseline test.
- [x] Identity: add provider-subject mapping and fail-closed Google profile parsing.
  Verify malformed/unverified profiles, repeat/concurrent login and email conflict.
- [x] Resolve cold-start issuer key initialization with one immutable D1 winner.
  Verify twelve concurrent creators and the actual bundled Worker key storage.
- [x] Fix the separate upstream KV expiry-rounding failure (59-second TTL from
  a 60-second authorization code). Preserve logical expiry; rerun full flows.
- [x] Profile API: verify signed subject/audience and load only the current user.
  Verify missing/forged/expired/wrong-issuer/wrong-audience/cross-user requests.
- [x] Browser API mutations: bounded name-only profile updates and account deletion.
  Verify exact-session authorization at the database write, cascades, failure
  behavior, isolation, and rejection of deleted accounts' OAuth grants.
- [x] Local browser session: one-time PKCE/state transaction, exact callback,
  opaque cookie, expiry and logout. HTTP negative/replay tests and real Chromium
  flows pass against isolated workerd/D1/KV; Google endpoints are fixtures.
  Production HTTPS cookie enforcement is part of the live verification below.
- [x] Demo screen: login, profile/API, logout and account-data deletion; no token
  localStorage. Verify account/session changes, drafts and uncertain writes.
- [x] Replace unsupported legacy SDK/example paths with the tested same-origin
  implementation and migration guides; verify no retired exports remain.
- [x] Local checkpoint: complete user flow with real workerd, D1 and KV; inspect
  browser console, cookie metadata, redirects, errors and responsive screenshots.
- [ ] Verify hidden-tab visibility, BFCache restoration and delayed responses in
  a still-live document. Current trusted pagehide tests do not prove these cases.
- [x] Prepare credential-free CI with locked install and automated checks; lint and
  review its source. Document local setup, provider configuration, security and
  retention boundaries, breaking integrations and exact verification evidence.
- [ ] After explicit push approval, verify a GitHub-hosted CI run and configure
  required checks with owner approval. No hosted green-run claim yet.
- [ ] Add and verify scheduled cleanup of expired sessions/login transactions;
  login-triggered cleanup alone does not bound idle database retention.
- [ ] Fresh-context security/quality review; resolve findings and rerun affected tests.
- [ ] Confirm Cloudflare account, isolated bindings and Google OAuth configuration.
- [ ] Deploy isolated demo and verify real Google login for two separate accounts,
  protected data access, expiry/logout and cookie settings.
- [ ] Final audit: all SPEC requirements have direct evidence, commits are atomic,
  sole author/committer is omariomari2, tree is clean, limitations are explicit.

No live-verification checkbox may be satisfied by a local mock or dry-run.
