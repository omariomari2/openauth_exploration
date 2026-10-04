# Private profile API

The demo exposes two deliberately separate credential paths. Neither accepts a
caller-selected account ID. Responses are private, same-origin and `no-store`.

## Bearer access

`GET /userinfo` requires `Authorization: Bearer <access-token>` with one space.
The scheme is case-insensitive; token contents are not. Cookies cannot replace a
missing or invalid token, and query parameters are rejected. This is the demo's
profile endpoint, not a claim of full OpenID Connect UserInfo compatibility.

The signature and exact issuer, client audience, expiry and access-user claims
are verified against the configured issuer's public keys in the same Worker.
`properties.id` selects the D1 account; the JWT subject and profile/role claims do
not. A deleted or missing account is unauthorized even if its token has not yet
expired. Signing up again creates a different ID and does not revive old tokens.

Success: `200 { "user": { "id", "email", "firstName", "lastName", "role", "createdAt" } }`.
The field list describes the response shape, not literal JSON values. There are
no session, CSRF, provider-token, address or device fields in this response.
Unauthorized requests return `401 { "error": "unauthorized" }` and
`WWW-Authenticate: Bearer`. Unsupported methods return `405` with `Allow: GET`;
query parameters return `400 { "error": "invalid_request" }`.

## Browser access

`GET /api/profile` uses the opaque HttpOnly session cookie established by `/login`
and `/callback`. It returns the same `user` shape plus that session's `csrfToken`.
The CSRF token is not an authentication credential. `POST /logout` requires the
exact application Origin and `X-CSRF-Token`; it revokes that browser session,
not independently held bearer tokens or the Google login session.

## Profile edits

`PATCH /api/profile` uses the browser session and requires the exact Origin plus
`X-CSRF-Token`. Authorization headers and query parameters are rejected to avoid
ambiguous credentials or account selectors. The only editable fields are
`firstName` and `lastName`; omitted fields stay unchanged, while `null` or a blank
trimmed string clears a field. Nonblank names may contain Unicode and punctuation,
but no C0/C1 control characters, and are limited to 100 UTF-16 code units.

Send a nonempty JSON object using `Content-Type: application/json` (optional
`charset=utf-8`). The actual UTF-8 body is capped at 4096 bytes and a five-second
read deadline. ID, email, role and other fields cannot be set. Success returns the
updated `user` and the existing `csrfToken`. The update preserves omitted columns
inside SQL and rechecks the exact live session and CSRF token at the write itself.
The database clock is used for expiry, not an earlier request timestamp.

Errors use `{ "error": "code" }`: `400 invalid_profile` for invalid JSON/schema,
`400 invalid_request` for a selector or Authorization header, `401 unauthorized`,
`403 invalid_csrf`, `413 payload_too_large`, `415 unsupported_media_type`, or
`408 request_timeout`. Origin-policy rejection may instead be `403 unrecognized_origin`.
Unsupported profile methods return `405` with `Allow: GET, PATCH`.

Repeating the same field assignment is idempotent, but concurrent updates to the
same field are last-write-wins. After an uncertain network result, read the profile
before retrying so an automatic retry does not overwrite a newer edit. Names are
data, not HTML; browser renderers must use text/escaped output.

## Account deletion

`DELETE /api/account` requires the browser session, exact Origin and current
`X-CSRF-Token`. Send no body, query parameters or Authorization header. The account
comes only from that session; bearer tokens cannot authorize deletion. Like PATCH,
the deletion statement rechecks the exact session, CSRF token and database-clock
expiry. Success is `204` with no body and clears this browser's four login/session
cookies. An already-deleted account returns `401`, not another success.

The single D1 statement deletes the user and cascades their Google identity,
all browser sessions, and any legacy session/address rows. Other accounts and
the issuer keys stay intact. A database error returns a generic `500` and does
not report successful deletion or clear the cookies. Other errors are
`400 invalid_request`, `401 unauthorized`, `403 invalid_csrf` (or the origin
policy's `403 unrecognized_origin`), and `405` with `Allow: DELETE`.

Subsequent browser/profile reads and authorization-code/refresh exchanges check
the original D1 user ID and reject deleted accounts. A new Google sign-in may
create a fresh account with a new ID; it cannot revive old credentials. This is
account-data deletion, not a Google logout, Google-account deletion, or a ban.

Requests that already read an authorized account before deletion may finish.
In particular, an in-flight token exchange may issue credentials after deletion,
but those credentials cannot access the deleted profile or renew again. Residual
KV grants are not synchronously erased: authorization codes have a 60-second
logical lifetime and refresh records a one-hour lifetime measured from their last
write, including an in-flight write. KV's minimum physical TTL is 60 seconds;
the adapter enforces the exact logical deadline separately.

Anonymous pending login transactions contain no linked account ID. Clearing the
login cookie prevents this browser from completing its pending transaction;
the row expires after ten minutes and is removed by the next login's cleanup.
SQL deletion does not purge provider-managed backups. D1 currently retains
[Time Travel history](https://developers.cloudflare.com/d1/reference/time-travel/)
for seven days on Free and thirty days on Paid (checked 2026-10-03). The selected
plan and restore procedure must be documented for the isolated deployment before
launch; a pre-deletion restore could reintroduce account data.

The legacy SDK/examples have not yet been replaced and are not supported
integrations. The browser interface and live deployment remain unfinished.
