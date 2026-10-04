# Task checklist

- [x] Inspect current source, establish baseline and dedicated branch/author.
- [x] Confirm Google-first scope with owner.
- [x] Review architecture/security contract before implementation; incorporate
  browser-bound callbacks, request-log redaction, prevalidated redirects and
  configured issuer origin. Owner chose fresh-context reviews and tests only.
- [x] Toolchain: triage audit, pin compatible dependencies, disable install scripts,
  add a runnable test harness and remove automatic remote migration hooks.
  Verify clean install, build, dry-run and a real-runtime baseline test.
- [ ] Identity: add provider-subject mapping and fail-closed Google profile parsing.
  Verify malformed/unverified profiles, repeat/concurrent login and email conflict.
- [ ] Profile API: verify signed subject/audience and load only the current user.
  Verify missing/forged/expired/wrong-issuer/wrong-audience/cross-user requests.
- [ ] Browser session: one-time PKCE/state transaction, exact callback registration,
  secure opaque cookie, expiry and logout. Verify negative/replay paths.
- [ ] Demo: login, profile/API, logout and account-data deletion in the browser.
  Fix or clearly replace unsupported SDK/example paths; no token localStorage.
- [ ] Checkpoint: complete local user flow with real workerd, D1 and KV; inspect
  browser console, cookies, redirect behavior and errors.
- [ ] CI/docs: frozen install and automated checks, reproducible setup, provider
  configuration, security boundaries, retention/deletion and exact evidence.
- [ ] Fresh-context security/quality review; resolve findings and rerun affected tests.
- [ ] Confirm Cloudflare account, isolated bindings and Google OAuth configuration.
- [ ] Deploy isolated demo and verify real Google login for two separate accounts,
  protected data access, expiry/logout and cookie settings.
- [ ] Final audit: all SPEC requirements have direct evidence, commits are atomic,
  sole author/committer is omariomari2, tree is clean, limitations are explicit.

No live-verification checkbox may be satisfied by a local mock or dry-run.
