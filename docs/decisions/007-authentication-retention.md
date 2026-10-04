# Authentication retention cleanup

Expiry and physical deletion are separate. Session reads and callback consumption
already reject expired rows, but login-triggered cleanup alone leaves them stored
indefinitely when the demo is idle. An hourly Worker scheduled handler now invokes
the same `cleanupExpiredAuth` helper without requiring a user request or Google
configuration. It uses the current invocation time, not a caller-supplied cutoff.

The two indexed, parameterized DELETE statements remove only expired browser
sessions and anonymous login transactions in one [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
Active rows, account
data, issuer keys and KV are outside that batch. Repeated or overlapping runs are
safe. A failed batch rolls back; the next invocation can try again. No migration
or change to the ten-minute transaction / one-hour session lifetime is needed.

The implementation follows the [scheduled handler API](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
and [Wrangler Cron Trigger configuration](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
The hourly schedule is a retention target, not a guaranteed deletion deadline:
delayed or failed invocations can retain expired rows longer. Those rows still
cannot authenticate. Backups and KV grants have separate retention policies in
the [API contract](../profile-api.md#account-deletion).

Operational questions are whether cleanup ran and whether it failed. The handler
awaits the batch, emits only `authentication_cleanup_failed` with a generated
request ID on error, then throws a generic error so the invocation is not reported
as successful. Never log raw D1 errors, credentials or rows. Platform request logs
remain disabled; there is no new telemetry service or automatic notification.
After isolated deployment, inspect Cron Events for successful scheduled invocations
and investigate failures or missing runs. Live scheduling has not been verified.

Local tests dispatch real workerd scheduled events against isolated D1/KV, cover
expired/active records and repeated runs, force a D1-trigger failure to verify
rollback and recovery, and capture both runtime streams to check error redaction.
The cron configuration is code only until deployment is approved. Do not deploy
the inherited resource bindings in the current configuration.
