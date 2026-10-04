# Authentication logging boundary

OpenAuth 0.4.3 installs Hono's URL logger without an opt-out. Wrangler aliases
`hono/logger` to a no-op middleware in the generated Worker; installed dependency
files are unchanged. The Hono error handler is replaced with a generic local
response and a structured `authentication_failed` event containing only a fresh
request ID. No provider response, query, email or original exception is attached.

OpenAuth also logs cookie-decryption errors internally. JOSE can include an
attacker-controlled protected-header field in those errors. A syntax guard uses
the same Hono cookie parser and accepts only the exact compact-JWE header and
component shape that this pinned OpenAuth version emits. This is **not** cookie
authentication: OpenAuth still authenticates/decrypts it. Invalid cookies are
cleared so the next login can recover. With that header, tampered ciphertext yields
a generic JOSE error; internal stack traces can still appear in local console
output, but cookie contents are not included. Recheck this integration on upgrades.

Runtime tests capture both stdout and stderr, prove capture works with an
independent fixture, and exercise query/error/cookie sentinels, actual minted
cookies, duplicate cookies and percent decoding. Both query and malformed-cookie
regressions failed before their respective fixes.

Persisted Workers logs and traces are disabled by default. Disabling invocation
logs alone is not proof that platform metadata associated with custom logs omits
query strings. The Cloudflare API offers `redact_query_string`, but this pinned
Wrangler does not expose it. Do not enable persisted telemetry until redaction is
configured and verified on the isolated deployment. Standard Workers metrics are
still available. Treat live tails/browser network traces as sensitive debugging
data; never save or share OAuth callback URLs.

Questions supported by the remaining safe event: did issuer handling fail, and
which displayed request ID identifies that failure? Detailed operational metrics
and live verification remain deployment work, not proven by this local test.

Sources: [Wrangler module aliasing](https://developers.cloudflare.com/workers/wrangler/configuration/#module-aliasing),
[Hono error handling](https://hono.dev/docs/api/hono#onerror),
[Workers invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs),
[Worker observability settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/get/).
