import { issuer } from "@openauthjs/openauth";
import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import { GoogleProvider } from "@openauthjs/openauth/provider/google";
import { createSubjects } from "@openauthjs/openauth/subject";
import { object, string } from "valibot";
import { rejectMalformedIssuerCookies } from "./observability/issuer-cookies";
import { fetchGoogleProfile, getOrCreateGoogleUser } from "./identity";

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

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const cookieError = rejectMalformedIssuerCookies(request);
		if (cookieError) return cookieError;
		// This top section is just for demo purposes. In a real setup another
		// application would redirect the user to this Worker to be authenticated,
		// and after signing in or registering the user would be redirected back to
		// the application they came from. In our demo setup there is no other
		// application, so this Worker needs to do the initial redirect and handle
		// the callback redirect on completion.
		const url = new URL(request.url);
		if (url.pathname === "/") {
			url.searchParams.set("redirect_uri", url.origin + "/callback");
			url.searchParams.set("client_id", "your-client-id");
			url.searchParams.set("response_type", "code");
			url.pathname = "/authorize";
			return Response.redirect(url.toString());
		} else if (url.pathname === "/callback") {
			return Response.json({
				message: "OAuth flow complete!",
				params: Object.fromEntries(url.searchParams.entries()),
			});
		}

		// The real OpenAuth server code starts here:
		return issuer({
			storage: CloudflareStorage({
				namespace: env.AUTH_STORAGE,
			}),
			subjects,
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
		}).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
