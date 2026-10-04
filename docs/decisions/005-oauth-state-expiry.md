# Preserve OAuth expiry independently of KV retention

OpenAuth 0.4.3 gives authorization codes a 60-second lifetime. Its Cloudflare
adapter floors the remaining milliseconds to seconds: even one millisecond of
elapsed time becomes 59 seconds. [KV requires at least 60 seconds](https://developers.cloudflare.com/kv/api/write-key-value-pairs/#expiring-keys),
so a legitimate provider callback can fail while writing its authorization code.

The demo's KV adapter records each value with its original absolute expiry. It
rounds physical retention up, with a minimum of 60 seconds, but checks the original
millisecond deadline after every read and for every scan item. Physical retention
therefore never extends credential validity. Expired reads do not delete a key:
that could delete a newer value written while the read was in flight.

Malformed envelopes and old raw values are not accepted. Use a fresh, dedicated
namespace; this is not an in-place storage-format migration. Writes with an invalid
date fail generically. An already-expired overwrite remains an unusable record,
not a no-op that could leave an older credential usable. KV still has eventual
consistency and does not provide atomic OAuth-code consumption; the browser flow
separately consumes its browser-bound D1 transaction once.

The source import uses an explicit `.ts` extension for Node's native TypeScript
tests. TypeScript's [rewriteRelativeImportExtensions](https://www.typescriptlang.org/tsconfig/rewriteRelativeImportExtensions.html)
option rewrites it to `.js` in build output. No dependency change is required.
