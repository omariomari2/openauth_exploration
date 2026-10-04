# API and security behavior

The service has separate browser and bearer APIs. Each request selects an account from verified credentials, not a caller-supplied account ID.
Responses use `Cache-Control: no-store`. The origin policy permits only the configured application origin.

## Read a profile

### Browser access

`GET /api/profile` uses the opaque HttpOnly session cookie from `/login` and `/callback`.
The response contains `user` and the session's `csrfToken`.
The CSRF token does not authenticate a request.

### Bearer access

Send `GET /userinfo` with `Authorization: Bearer <access-token>` and one space between the scheme and token.
The scheme is case-insensitive. The token is case-sensitive.
Cookies cannot replace a missing or invalid token.

The Worker verifies the signature, exact issuer, client audience, expiry and access-user claims against the configured issuer's public keys.
`properties.id` selects the D1 account. The JWT subject, profile claims and role claims do not select it.
The response uses current D1 data.

A missing or deleted account returns `401`, even before the token expires.
A new signup creates a new account ID. Old tokens cannot access that account.
This endpoint does not implement the full OpenID Connect UserInfo specification.

### Profile response

The bearer response has this field list, not literal JSON values:

`200 { "user": { "id", "email", "firstName", "lastName", "role", "createdAt" } }`

It contains no session, CSRF, provider-token, address or device fields.
The browser response adds `csrfToken` beside `user`.

### Bearer errors

| Condition | Response |
| --- | --- |
| Missing or invalid credentials | `401 { "error": "unauthorized" }` and `WWW-Authenticate: Bearer` |
| Query parameters | `400 { "error": "invalid_request" }` |
| Unsupported method | `405` and `Allow: GET` |

## Change a profile

1. Send `PATCH /api/profile` with the browser session cookie.
2. Set `Origin` to the exact application origin.
3. Set `X-CSRF-Token` to the current session's token.
4. Set `Content-Type: application/json`. The optional `charset=utf-8` parameter is permitted.
5. Send a nonempty JSON object with `firstName`, `lastName`, or both.

Do not send an Authorization header or query parameters.
The API rejects changes to ID, email, role and all other fields.
It rejects C0 and C1 control characters before trimming a string.

| Name value | Behavior |
| --- | --- |
| Omitted field | Keep the stored value |
| `null` or a blank string after trimming | Clear the field |
| Nonblank string | Permit Unicode and punctuation |
| More than 100 UTF-16 code units after trimming | Reject the value |

The body limit is 4096 UTF-8 bytes. The read deadline is five seconds.
Success returns the updated `user` and the existing `csrfToken`.

SQL preserves omitted columns and verifies the exact session and CSRF token at the write.
Expiry uses the database clock, not the request's earlier timestamp.

### Input errors

Errors use `{ "error": "code" }`.

| Status and code | Cause |
| --- | --- |
| `400 invalid_profile` | Invalid JSON or profile fields |
| `400 invalid_request` | An account selector or Authorization header |
| `413 payload_too_large` | The body exceeds the size limit |
| `415 unsupported_media_type` | Unsupported Content-Type |
| `408 request_timeout` | The body read exceeds the deadline |

### Access and method errors

| Status and code | Cause |
| --- | --- |
| `401 unauthorized` | No valid session |
| `403 invalid_csrf` | Invalid CSRF token |
| `403 unrecognized_origin` | The origin policy rejects the request |
| `405` with `Allow: GET, PATCH` | Unsupported profile method |

### Concurrent changes and timeouts

Repeated assignments of the same value are idempotent.
For concurrent changes to one field, the last write wins.

A timeout does not prove that the write failed.
A later read does not prove that an earlier write finished.
Do not retry automatically. The browser requires a new login after an unknown write result.

## Sign out

Send `POST /logout` with the browser session, exact application Origin and `X-CSRF-Token`.
This revokes only that browser session.
It does not revoke independent bearer tokens or sign the user out of Google.

## Account deletion

1. Send `DELETE /api/account` with the browser session cookie.
2. Set the exact application Origin and current `X-CSRF-Token`.
3. Send no body, query parameters or Authorization header.

The account comes from the session. Bearer tokens cannot authorize deletion.
The DELETE statement verifies the exact session, CSRF token and database-clock expiry.

Success returns `204` without a body and clears this browser's four login and session cookies.
A single D1 statement deletes the user and their Google identity, browser sessions, and legacy session and address rows.
Other accounts and issuer keys remain unchanged.

Deletion uses `400 invalid_request`, `401 unauthorized`, `403 invalid_csrf` and `403 unrecognized_origin` for the same request and credential errors.
An already-deleted account returns `401`. Unsupported methods return `405` with `Allow: DELETE`.
A database failure returns a generic `500`. It does not report success or clear cookies.

Deletion removes account data. It does not delete the Google account, end the Google session, or ban future signup.
A new Google sign-in can create a new account ID. It cannot restore old credentials.

### Requests that started before deletion

A request that read an authorized account before deletion can finish.
An active token exchange can also issue credentials after deletion.
Those credentials cannot access the deleted profile or renew again.

Later profile reads and authorization-code or refresh exchanges verify the original D1 user ID.
They reject deleted accounts. Deletion does not immediately erase all KV grants.
The expiry limits below also apply to writes that finish after deletion.

## Browser behavior

### Public page and private data

`GET /` returns the same public HTML page for anonymous and signed-in requests.
Use `/api/profile` for profile JSON.

The Worker serves HTML, CSS and JavaScript as bundled Text modules.
Its Content Security Policy permits same-origin resources. It uses no external scripts or asset host.
`npm run build` strictly checks Worker TypeScript and browser JavaScript.

The browser keeps the CSRF token only in memory.
It sends only changed name fields and uses input values or text to display names.
Render names as text or escaped output, never as HTML.

### Session changes

- Deletion requires a second confirmation for the displayed account.
- Sign-out, deletion and invalid sessions clear personal DOM, form values and the confirmation.
- Hiding the page clears private state. Returning to the page triggers a new profile read.
- A visible idle page requests session validation every 60 seconds. Background timers can run late.
- The server remains responsible for session expiry and authorization.

An unsaved draft keeps its original baseline only while the account ID and CSRF token both match.
Refresh discards unsaved edits. An account or session change also discards the old draft.

### Pending writes

The browser permits one write at a time.
It suspends reads during that write and rejects stale read responses.

An unknown write result locks the document and offers `/login`.
This also applies when the page hides before the response arrives.
The browser does not retry the write or resume edits after a GET.

The callback revokes the previous browser session.
Each profile or account write verifies that exact session in SQL.
The service does not serialize all requests or provide an idempotency-key API.

## Expiry and cleanup

| Record | Expiry |
| --- | --- |
| Pending login transaction | Ten minutes |
| Browser session | One hour |
| Authorization code | 60 seconds |
| Refresh record | One hour after its last write, including a write that finishes after deletion |

Pending login transactions contain no linked account ID.
Clearing the login cookie prevents that browser from completing its pending transaction.

KV requires a minimum physical TTL of 60 seconds.
The storage adapter separately enforces the exact logical deadline.

Login and hourly scheduled cleanup remove expired login transactions and browser sessions.
Both use the same atomic D1 batch. Active credentials and accounts remain unchanged.

Physical deletion occurs at the next successful cleanup, not necessarily at expiry.
A failed or delayed run can extend storage time, but cannot extend authentication.
The hourly trigger exists in configuration. Live execution remains unverified.
See the [retention decision](decisions/007-authentication-retention.md).

### Backups

SQL deletion does not remove provider-managed backups.
D1 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) retains history for seven days on Free and thirty days on Paid (checked 2026-10-03).
A restore can reintroduce deleted account data.

Before deployment, document the selected plan and restore procedure.

## Scope and remaining checks

The service has no general-purpose SDK or arbitrary external client registration.
The [integration guide](../examples/README.md) describes the removal of the old SDK, token helpers, middleware and standalone examples.

Real Google login and an isolated live deployment still need verification.
