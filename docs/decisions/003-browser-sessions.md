# Browser-bound sessions

The demo and API share one explicitly configured origin and one registered OAuth
client. `/login` uses OpenAuth's authorization-code API with S256 PKCE. D1 stores
a ten-minute transaction bound to a separate random browser cookie; callback
consumption is atomic. The callback exchanges the code inside the Worker, verifies
the signed access token with the local issuer's current public keys and confirms
that its user still exists in D1. OAuth tokens are not returned to the browser.

The in-process fetch override accepts only this issuer's fixed protocol endpoints.
It avoids a network request back to the same Worker and cannot follow a supplied
external URL. See the [OpenAuth client contract](https://openauth.js.org/docs/client/).
The strict verifier is used instead of relying on the pinned client's audience
option; expiry and exact single-client audience are mandatory.

The application session is a random opaque credential, hashed in D1, valid for
one hour. `GET /api/profile` returns only the current user's allowlisted profile
and CSRF token. `POST /logout` requires that token and the exact Origin header,
revokes the current session and clears its cookie. Signing in again revokes the
previous session presented by that browser. Other sessions remain active.

All four HTTPS authentication cookies use `__Host-` names, Secure, HttpOnly,
SameSite=Lax, Path=/ and no Domain. OpenAuth's internal cookie names are translated
at the boundary; raw legacy names cannot shadow them. Loopback HTTP development
uses distinct `local-` names without Secure; HTTPS never accepts those names.
Cookie prefixes protect against sibling-domain injection, not a fully compromised
browser. Real-browser verification remains required.

Responses use no-store and no-referrer, reject framing and MIME sniffing, and do
not inherit wildcard CORS headers. Unexpected failures expose only a generic
error and an application-generated request ID. No profile or credential is logged.
Expired D1 transactions and sessions are cleaned on login and by the subsequently
added [hourly handler](007-authentication-retention.md), tested locally but not yet
deployed. The [account-data deletion route](../profile-api.md#account-deletion)
is also implemented and tested locally.

This is not yet a production or resume-readiness claim. The pinned issuer's
concurrent first-key initialization was subsequently fixed with
[immutable D1 issuer keys](004-issuer-key-storage.md). The local Chromium suite
now checks cookie metadata and the full demo; real Google login and production
HTTPS enforcement still require verification.
No existing Cloudflare resource has been migrated or deployed, and no branch has
been pushed.
