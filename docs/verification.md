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
  issuer integration and deployed Google verification remain pending.
