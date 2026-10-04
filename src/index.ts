import { issuer } from "@openauthjs/openauth";
import { createIssuerStorage } from "./issuer-storage";
import { GoogleProvider } from "@openauthjs/openauth/provider/google";
import { createSubjects } from "@openauthjs/openauth/subject";
import { object, string } from "valibot";
import { rejectMalformedIssuerCookies } from "./observability/issuer-cookies";
import { fetchGoogleProfile, getOrCreateGoogleUser } from "./identity";
import { prepareIssuerRequest, readAuthSettings, type DemoEnv } from "./issuer-policy";
import { handleBrowserRequest } from "./browser-auth";
import { handleBearerProfileRequest } from "./bearer-profile";
import { translateIssuerCookies, protectIssuerCookies } from "./observability/issuer-cookie-boundary";

// Import local modules to ensure they're included in the bundle
export { AuthClient, useAuth } from "./client-sdk";
export { 
  requireAuth, 
  requireRole, 
  optionalAuth, 
  createProtectedHandler, 
  createRoleProtectedHandler, 
  createOptionalAuthHandler,
  RateLimiter,
  corsHeaders,
  handleCors,
  addCorsHeaders,
  applyRateLimit
} from "./middleware/auth";
export { 
  parseJWT, 
  isTokenExpired, 
  getTokenExpiration, 
  getTimeUntilExpiration, 
  extractUserFromToken, 
  validateTokenFormat, 
  createAuthErrorResponse, 
  createAuthSuccessResponse, 
  generateSecureState, 
  generateCodeVerifier, 
  generateCodeChallenge, 
  sanitizeUserData, 
  hasPermission, 
  getClientIP, 
  createRateLimitKey 
} from "./helpers/token-validation";

// Re-export types with namespace to avoid conflicts
export type { AuthTokens } from "./client-sdk";
export type { User as ClientUser, AuthConfig as ClientAuthConfig } from "./client-sdk";
export type { User as MiddlewareUser, AuthConfig as MiddlewareAuthConfig, AuthResult } from "./middleware/auth";
export type { TokenPayload, ValidationResult } from "./helpers/token-validation";

// This value should be shared between the OpenAuth server Worker and other
// client Workers that you connect to it, so the types and schema validation are
// consistent.
const subjects = createSubjects({
	user: object({
		id: string(),
	}),
});

async function handleRequest(request: Request, env: DemoEnv, ctx: ExecutionContext): Promise<Response> {
	let settings;
	try { settings = readAuthSettings(env.ISSUER_ORIGIN); }
	catch { return Response.json({ error: "issuer_not_configured" }, { status: 503 }); }
	const prepared = prepareIssuerRequest(request, settings);
	if (prepared instanceof Response) return prepared;
	const translated = translateIssuerCookies(prepared);
	if (translated instanceof Response) return translated;
	request = translated;
	const cookieError = rejectMalformedIssuerCookies(request);
	if (cookieError) return cookieError;
	const auth = issuer({
		storage: createIssuerStorage(env.AUTH_DB, env.AUTH_STORAGE),
		subjects,
		allow: async ({ clientID, redirectURI, audience }) => clientID === settings.clientID &&
			redirectURI === settings.callbackURI && audience === undefined,
		ttl: { access: 300, refresh: 3600, reuse: 0 },
		providers: {
			google: GoogleProvider({
				clientID: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET,
				scopes: ["openid", "profile", "email"],
				pkce: true,
			}),
		},
		theme: {
			title: "Go-Shop",
			primary: "#FFF8DC",
			favicon: "https://ik.imagekit.io/dr5fryhth/logo1.png?updatedAt=1760472240746",
			logo: {
				dark: "https://ik.imagekit.io/dr5fryhth/logo1.png?updatedAt=1760472240746",
				light:
					"https://ik.imagekit.io/dr5fryhth/logo1.png?updatedAt=1760472240746",
			},
		},
		success: async (ctx, value) => {
			const profile = await fetchGoogleProfile(value.tokenset.access);
			return ctx.subject("user", {
				id: await getOrCreateGoogleUser(env.AUTH_DB, profile),
			});
		},
	}).onError((_error, context) => {
		// The upstream handler logs raw provider errors and redirects them.
		// Emit only an application-generated ID, never error/query contents.
		const requestId = crypto.randomUUID();
		console.error(JSON.stringify({ event: "authentication_failed", requestId }));
		context.header("Cache-Control", "no-store");
		return context.json({ error: "authentication_failed", requestId }, 400);
	});
	const issuerFetch = async (internal: Request) => auth.fetch(internal, env, ctx);
	return await handleBearerProfileRequest(request, env, settings, issuerFetch) ??
		await handleBrowserRequest(request, env, settings, issuerFetch) ?? issuerFetch(request);
}

export default {
	async fetch(request: Request, env: DemoEnv, ctx: ExecutionContext) {
		let response: Response;
		try { response = await handleRequest(request, env, ctx); }
		catch {
			const requestId = crypto.randomUUID();
			console.error(JSON.stringify({ event: "request_failed", requestId }));
			response = Response.json({ error: "request_failed", requestId }, { status: 500 });
		}
		response = protectIssuerCookies(response, request);
		// This demo is same-origin; do not inherit OpenAuth's wildcard CORS headers.
		for (const name of [...response.headers.keys()]) {
			if (name.startsWith("access-control-")) response.headers.delete(name);
		}
		response.headers.set("Cache-Control", "no-store");
		response.headers.set("Referrer-Policy", "no-referrer");
		response.headers.set("X-Content-Type-Options", "nosniff");
		response.headers.set("X-Frame-Options", "DENY");
		response.headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
		if (new URL(request.url).protocol === "https:") response.headers.set("Strict-Transport-Security", "max-age=31536000");
		return response;
	},
} satisfies ExportedHandler<DemoEnv>;
