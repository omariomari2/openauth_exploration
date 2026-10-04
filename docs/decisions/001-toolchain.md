# Pinned local toolchain

Use Node 24 and npm 11 with dependency lifecycle scripts disabled in `.npmrc`.
The baseline had nine high-severity audit findings. Update runtime libraries
separately and the coupled Wrangler/Miniflare toolchain together; commit the
generated lockfile and run the bundled Worker before and after each change.

- Hono 4.13.12 and Valibot 1.5.0 replace vulnerable resolved versions. OpenAuth
  remains 0.4.3; Hono satisfies its version-4 peer contract.
- Wrangler 4.114.0 ships Miniflare 4.20260722.0 and workerd 1.20260722.1.
  Pin that coherent stable set instead of moving to the newer Miniflare 5 alpha.
- Scoped Miniflare overrides select sharp 0.35.5 and undici 7.29.1 to clear
  advisories in the toolchain's original pins. Remove overrides once the selected
  upstream toolchain provides patched versions. Retest on any toolchain update.

`npm ci --ignore-scripts`, the real-runtime suite, TypeScript build and full
`npm audit` pass locally. The audit reports zero known advisories as of
2026-10-03; that is not a guarantee against undiscovered vulnerabilities.
Lockfile review confirmed registry.npmjs.org sources and integrity hashes.

Sources: [Hono release](https://github.com/honojs/hono/releases/tag/v4.13.12),
[Valibot release](https://github.com/open-circle/valibot/releases/tag/v1.5.0),
[Wrangler release](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.114.0),
[Undici release](https://github.com/nodejs/undici/releases/tag/v7.29.1).
