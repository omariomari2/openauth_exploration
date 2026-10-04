import type { JSONWebKeySet } from "jose";
import type { AuthSettings, DemoEnv } from "./issuer-policy";
import { readProfile } from "./browser-auth";
import { verifyAccessToken } from "./token-verification";

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, {
    status: 401, headers: { "WWW-Authenticate": "Bearer" },
  });
}

export async function handleBearerProfileRequest(
  request: Request, env: DemoEnv, settings: AuthSettings,
  issuerFetch: (request: Request) => Promise<Response>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/userinfo") return null;
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  if (url.search) return Response.json({ error: "invalid_request" }, { status: 400 });
  const authorization = request.headers.get("Authorization") ?? "";
  if (authorization.length > 16_384 + 7) return unauthorized();
  const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization)?.[1];
  if (!token) return unauthorized();

  // Same-process issuer only; caller cookies, bearer headers and URLs are never forwarded.
  const keys = await issuerFetch(new Request(`${settings.origin}/.well-known/jwks.json`));
  if (!keys.ok) throw new Error("Issuer keys unavailable");
  const userId = await verifyAccessToken(token, {
    issuer: settings.origin, audience: settings.clientID, jwks: await keys.json<JSONWebKeySet>(),
  });
  if (!userId) return unauthorized();
  const user = await readProfile(env.AUTH_DB, userId);
  return user ? Response.json({ user }) : unauthorized();
}
