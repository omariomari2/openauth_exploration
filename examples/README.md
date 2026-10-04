# Integration guide

The Worker serves Google sign-in, private profiles, and the browser interface from one origin.

1. Complete the [project setup](../README.md).
2. Use the [browser guide](frontend-integration/README.md) to connect sign-in, profile changes, sign-out, and account deletion.
3. Use the [API guide](api-protection/README.md) for routes, credentials, and responses.

## Integration rules

Browser requests use same-origin session cookies. The server selects the account from verified credentials.
The `/userinfo` endpoint uses a signed access token instead of a browser session.

Read the [API and security behavior](../docs/profile-api.md) before changing the client.
See [test results and known limits](../docs/verification.md) for verification status.
