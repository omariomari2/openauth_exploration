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

Profile edits and account deletion are a following implementation slice. The
legacy SDK/examples have not yet been replaced and are not supported integrations.
