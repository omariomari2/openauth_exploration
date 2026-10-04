# Deterministic issuer keys

OpenAuth 0.4.3 generates a key after an empty storage scan, persists it under a
random ID, and scans again. Concurrent first requests can therefore persist
different keys. Cookie decryption uses only the newest encryption key, making a
previously issued cookie unusable. An isolate-local promise would not coordinate
different Worker isolates.

The isolated demo stores its signing and encryption keys in D1, one immutable row
per purpose. An atomic insert elects the first winner; losing inserts are no-ops.
OpenAuth's post-insert scan then imports that same winner. Direct D1 operations
use the [primary database](https://developers.cloudflare.com/d1/best-practices/read-replication/);
this adapter uses neither Sessions API replicas nor a key cache.

This is deliberately pinned to the installed key format. IDs, algorithms, bounded
PEM fields and timestamps are validated; cryptographic parsing remains OpenAuth's
responsibility. Invalid persisted rows fail rather than appearing absent and
triggering an endless generate/insert/scan cycle. Key expiry and removal through
the adapter are rejected. OAuth codes and refresh state remain in KV.

Use fresh, dedicated resources. Old KV keys, including legacy RS512 keys, are not
imported. This is not an in-place migration for an existing issuer. The private
key rows are sensitive: never expose or log their contents. Automatic rotation is
not implemented; any future rotation needs an explicit compatibility and session
invalidation plan. No existing remote database has been changed.
