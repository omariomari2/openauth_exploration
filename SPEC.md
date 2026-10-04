# Verified authentication demo

## Objective and approved scope

Make this OpenAuth exploration a demonstrably working Cloudflare project, not
just a template with unverified claims. The owner approved Google-first login
on 2026-10-03: a real D1-backed private profile/API, secure browser sessions,
account-isolation tests, CI, and an isolated Workers deployment. Password login
stays disabled until real email delivery is configured; never log codes.

This is one end-to-end authentication capability. A full ecommerce backend,
payments, additional login providers, and automatic resume edits are out of scope.

## Stack and structure

- TypeScript 5.8.3, OpenAuth 0.4.3, Valibot; Workers, KV, and D1.
- `src/`: issuer, shared identity/schema, profile verification, demo/session routes.
- `test/`: Node tests and Miniflare integration tests using real local D1/KV.
- `migrations/`: additive D1 migrations; never alter an applied migration.
- `examples/`: supported integration examples, not claims of a complete store.
- `docs/`: security decisions, deployment and verification evidence.
- `tasks/plan.md` and `tasks/todo.md`: implementation order and evidence gates.

## Commands

Baseline: `npm ci --ignore-scripts`, `npm run build`, and
`node node_modules/wrangler/bin/wrangler.js deploy --dry-run`.
Remote migrations are explicit (`npm run migrate:remote`), never deploy hooks.
Do not deploy or migrate until dedicated resource bindings are configured.

Target commands, to be implemented and verified:

- `npm ci --ignore-scripts`: reproducible, script-disabled dependency install.
- `npm run build`: strict typecheck/build.
- `npm run check`: build and local dry-run bundle, no remote writes.
- `npm test`: unit and real-runtime integration tests, no cloud credentials.
- `npm run dev`: local demo; Google credentials are separately configured.
- Explicit migration/deployment commands: documented after isolated bindings exist.

## Contracts and threat boundaries

1. Google identity comes from validated server-side UserInfo, never fabricated
   email/profile properties or an unverified decoded ID token. Map Google's stable
   `sub` to a D1 user. Reject occupied-email conflicts rather than auto-linking
   identities. Preserve existing data; never assign the legacy empty-email row.
2. `/userinfo` and the protected profile API verify identity before D1 access.
   Bearer verification checks signature, issuer, expiry, access mode, schema and
   exact client audience. Resolve the database ID from `subject.properties.id`,
   not JWT `sub`. Roles/profile fields come from current D1 data.
3. The browser demo uses authorization code + S256 PKCE, a cryptographically
   random state, exact registered callbacks and one-time short-lived transactions.
   Bind each transaction to a separate unpredictable HttpOnly browser cookie;
   a state-to-verifier lookup alone does not prevent callback transplantation.
   Missing/mismatched/replayed state, transplanted callbacks and missing/wrong
   verifier fail closed. Prevalidate `/authorize` before invoking OpenAuth so its
   error redirects cannot send a rejected request to an attacker-controlled URL.
4. Browser credentials stay out of localStorage, page markup and logs. Use opaque
   HttpOnly/Secure/SameSite session cookies and server-side expiry/revocation.
   Logout revokes this demo session; it does not claim to sign out of Google or
   revoke every previously issued bearer token.
5. Cookies authenticate same-origin demo requests. State-changing routes require
   CSRF protection. Reject unsupported clients/origins; never use wildcard
   credentialed CORS. Errors must not expose tokens, profile data or stack traces.
   Pin the issuer origin in configuration and strip forwarded host/protocol/port
   headers before OpenAuth handles requests. Disable or redact its built-in
   query-string logger through a reproducible build adaptation, never a global
   console monkey-patch. Verify captured logs contain no callback codes/tokens.
6. Use D1 ownership checks for real private profile data. Two accounts must remain
   separate across sign-in, requests and concurrent identity creation.
7. Minimize retained data, give sessions/transactions explicit expiry and cleanup,
   and document a working account-data deletion path. No tracking or added PII.

Style: match the existing TypeScript naming and double quotes; use typed boundary
schemas, parameterized SQL and small functions. Example:

```ts
const user = await env.AUTH_DB.prepare("SELECT id FROM user WHERE id = ?")
  .bind(verified.subject.properties.id)
  .first<{ id: string }>();
```

## Verification and completion criteria

- Reproduce each repaired authentication defect before its fix.
- Use the actual bundled Worker and isolated Miniflare D1/KV for integration
  tests; mock only Google's external responses. Never include a test-login bypass
  in the deployable Worker.
- Exercise login, callback, profile, protected API, logout and expired sessions.
- Reject forged/expired/wrong-issuer/wrong-audience tokens, invalid provider data,
  wrong state/PKCE, cross-user access, unsafe redirects and unauthorized origins.
- Verify browser behavior and cookie properties in a real browser.
- Clean install, build, tests, dry-run, dependency audit and CI must pass.
- Fresh-context review must resolve actionable authentication/security findings.
- A dedicated Workers deployment must pass real Google login and protected API
  smoke tests. Local mocks, a build, or a reachable landing page do not prove this.
- Record exact commands/results and limitations; no invented users or performance.
- Each logical change gets an atomic commit authored and committed solely by
  `omariomari2 <188401332+omariomari2@users.noreply.github.com>`, without coauthors.

## Boundaries and external prerequisites

Always preserve unrelated work and inspect staged diffs; never commit secrets,
disable failing tests or run destructive remote migrations. No global Git changes.
Ask before publishing a branch/PR, adding paid services, touching existing live
data, or configuring a new third-party identity/email integration.

Cloudflare CLI was unauthenticated at baseline. Real Google/Cloudflare credentials,
approved account/resource selection and a Google callback registration are needed
for live verification. Missing credentials do not lower the completion bar.
