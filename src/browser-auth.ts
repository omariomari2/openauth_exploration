import { createClient } from "@openauthjs/openauth/client";
import type { JSONWebKeySet } from "jose";
import type { AuthSettings, DemoEnv } from "./issuer-policy";
import { cleanupExpiredAuth, consumeLoginTransaction, createLoginTransaction,
  createSession, readSession, revokeSession } from "./browser-auth-storage";
import { verifyAccessToken } from "./token-verification";
import { readProfilePatch } from "./profile-input";

export interface Profile {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string | null;
  createdAt: string;
}

export function readProfile(db: D1Database, userId: string): Promise<Profile | null> {
  return db.prepare(`SELECT id, email, first_name AS firstName, last_name AS lastName,
    role, created_at AS createdAt FROM user WHERE id = ?`).bind(userId).first<Profile>();
}

function cookieName(origin: string, kind: "login" | "session"): string {
  return `${origin.startsWith("https:") ? "__Host" : "local"}-openauth-${kind}`;
}

function readCookie(request: Request, name: string): string {
  const matches = (request.headers.get("Cookie") ?? "").split(";")
    .map((part) => part.replace(/^[ \t]+|[ \t]+$/g, "")).filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : "";
}

function cookie(origin: string, kind: "login" | "session", value: string, maxAge: number): string {
  return `${cookieName(origin, kind)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
    (origin.startsWith("https:") ? "; Secure" : "");
}

function error(code: string, status: number): Response {
  return Response.json({ error: code }, { status });
}

async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The client talks to the same issuer in-process, never through a user-supplied
// URL or a network fetch back to this Worker. OpenAuth documents the fetch override:
// https://openauth.js.org/docs/client/#clientinputfetch
export async function handleBrowserRequest(
  request: Request, env: DemoEnv, settings: AuthSettings,
  issuerFetch: (request: Request) => Promise<Response>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const methods: Record<string, string> = {
    "/login": "GET", "/callback": "GET", "/api/profile": "GET, PATCH",
    "/api/account": "DELETE", "/logout": "POST",
  };
  if (!(url.pathname in methods)) return null;
  if (!methods[url.pathname].split(", ").includes(request.method)) {
    return new Response(null, { status: 405, headers: { Allow: methods[url.pathname] } });
  }
  const localFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const internal = new Request(input, init);
    const target = new URL(internal.url);
    if (target.origin !== settings.origin || target.search || target.hash ||
      !["/token", "/.well-known/jwks.json", "/.well-known/oauth-authorization-server"].includes(target.pathname)) {
      throw new Error("Invalid internal issuer request");
    }
    return issuerFetch(internal);
  };
  const client = createClient({ clientID: settings.clientID, issuer: settings.origin, fetch: localFetch });
  const sessionToken = readCookie(request, cookieName(settings.origin, "session"));

  if (url.pathname === "/login") {
    await cleanupExpiredAuth(env.AUTH_DB);
    const { challenge, url: location } = await client.authorize(settings.callbackURI, "code", { pkce: true, provider: "google" });
    if (!challenge.verifier) throw new Error("PKCE unavailable");
    const browserToken = await createLoginTransaction(env.AUTH_DB, { state: challenge.state, verifier: challenge.verifier });
    return new Response(null, { status: 302, headers: {
      Location: location, "Set-Cookie": cookie(settings.origin, "login", browserToken, 600),
    } });
  }

  if (url.pathname === "/callback") {
    const params = url.searchParams;
    const code = params.get("code") ?? "";
    const state = params.get("state") ?? "";
    if ([...params.keys()].some((key) => !["code", "state"].includes(key) || params.getAll(key).length !== 1) ||
      !code || code.length > 256 || /[^A-Za-z0-9_-]/.test(code)) return error("invalid_callback", 400);
    const browserToken = readCookie(request, cookieName(settings.origin, "login"));
    const verifier = await consumeLoginTransaction(env.AUTH_DB, state, browserToken);
    if (!verifier) return error("invalid_callback", 400);
    const exchanged = await client.exchange(code, settings.callbackURI, verifier);
    if (exchanged.err) return error("invalid_callback", 400);
    const keys = await localFetch(`${settings.origin}/.well-known/jwks.json`);
    if (!keys.ok) throw new Error("Issuer keys unavailable");
    const userId = await verifyAccessToken(exchanged.tokens.access, {
      issuer: settings.origin, audience: settings.clientID, jwks: await keys.json<JSONWebKeySet>(),
    });
    if (!userId || !await readProfile(env.AUTH_DB, userId)) return error("invalid_callback", 400);
    await revokeSession(env.AUTH_DB, sessionToken);
    const session = await createSession(env.AUTH_DB, userId);
    const headers = new Headers({ Location: "/" });
    headers.append("Set-Cookie", cookie(settings.origin, "login", "", 0));
    headers.append("Set-Cookie", cookie(settings.origin, "session", session.token, 3600));
    return new Response(null, { status: 303, headers });
  }

  const session = await readSession(env.AUTH_DB, sessionToken);
  const user = session ? await readProfile(env.AUTH_DB, session.userId) : null;
  if (!session || !user) return error("unauthorized", 401);
  if (["/api/profile", "/api/account"].includes(url.pathname) && (url.search || request.headers.has("Authorization"))) {
    return error("invalid_request", 400);
  }
  if (request.method !== "GET") {
    if (request.headers.get("Origin") !== settings.origin || request.headers.get("X-CSRF-Token") !== session.csrfToken) {
      return error("invalid_csrf", 403);
    }
  }
  if (url.pathname === "/api/profile" && request.method === "PATCH") {
    const patch = await readProfilePatch(request);
    if (patch instanceof Response) return patch;
    const tokenHash = await hashSessionToken(sessionToken);
    // Preserve omitted fields inside the update, and authorize at the write itself.
    // SQLite's subsecond clock avoids authorizing with a pre-body timestamp.
    const updated = await env.AUTH_DB.prepare(`UPDATE user SET
      first_name = CASE WHEN ? THEN ? ELSE first_name END,
      last_name = CASE WHEN ? THEN ? ELSE last_name END
      WHERE id = ? AND EXISTS (SELECT 1 FROM browser_sessions
        WHERE token_hash = ? AND user_id = user.id AND csrf_token = ?
          AND expires_at > unixepoch('subsec') * 1000)
      RETURNING id, email, first_name AS firstName, last_name AS lastName, role, created_at AS createdAt`)
      .bind(Number(patch.firstName !== undefined), patch.firstName ?? null,
        Number(patch.lastName !== undefined), patch.lastName ?? null,
        session.userId, tokenHash, session.csrfToken).first<Profile>();
    return updated ? Response.json({ user: updated, csrfToken: session.csrfToken }) : error("unauthorized", 401);
  }
  if (url.pathname === "/api/account") {
    if (request.body !== null) return error("invalid_request", 400);
    const removed = await env.AUTH_DB.prepare(`DELETE FROM user WHERE id = ? AND EXISTS (
      SELECT 1 FROM browser_sessions WHERE token_hash = ? AND user_id = user.id
        AND csrf_token = ? AND expires_at > unixepoch('subsec') * 1000
      ) RETURNING id`)
      .bind(session.userId, await hashSessionToken(sessionToken), session.csrfToken).first<{ id: string }>();
    if (!removed) return error("unauthorized", 401);
    const headers = new Headers();
    headers.append("Set-Cookie", cookie(settings.origin, "login", "", 0));
    headers.append("Set-Cookie", cookie(settings.origin, "session", "", 0));
    // The outer issuer-cookie boundary applies the correct HTTPS/local names.
    for (const name of ["provider", "authorization"]) {
      headers.append("Set-Cookie", `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    }
    return new Response(null, { status: 204, headers });
  }
  if (url.pathname === "/logout") {
    await revokeSession(env.AUTH_DB, sessionToken);
    return new Response(null, { status: 204, headers: { "Set-Cookie": cookie(settings.origin, "session", "", 0) } });
  }
  return Response.json({ user, csrfToken: session.csrfToken });
}
