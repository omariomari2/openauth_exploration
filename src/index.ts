import { issuer } from "@openauthjs/openauth";
import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import { PasswordProvider } from "@openauthjs/openauth/provider/password";
import { PasswordUI } from "@openauthjs/openauth/ui/password";
import { GoogleProvider } from "@openauthjs/openauth/provider/google";
import { createSubjects } from "@openauthjs/openauth/subject";
import { object, string } from "valibot";

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
			providers: {
				password: PasswordProvider(
					PasswordUI({
						// eslint-disable-next-line @typescript-eslint/require-await
						sendCode: async (email, code) => {
							// This is where you would email the verification code to the
							// user, e.g. using Resend:
							// https://resend.com/docs/send-with-cloudflare-workers
							console.log(`Sending code ${code} to ${email}`);
						},
						copy: {
							input_code: "Code (check Worker logs)",
						},
					}),
				),
				google: GoogleProvider({
					clientID: env.GOOGLE_CLIENT_ID,
					clientSecret: env.GOOGLE_CLIENT_SECRET,
					scopes: ["profile", "email"],
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
				const email = value.provider === "password" ? value.email : (value as any).email;
				const profile = value.provider === "google" ? (value as any).profile : undefined;
				return ctx.subject("user", {
					id: await getOrCreateUser(env, email || "", profile),
				});
			},
		}).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

async function getOrCreateUser(env: Env, email: string, profile?: any): Promise<string> {
	const result = await env.AUTH_DB.prepare(
		`
		INSERT INTO user (email, first_name, last_name, avatar_url, last_login)
		VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT (email) DO UPDATE SET 
			first_name = COALESCE(?, first_name),
			last_name = COALESCE(?, last_name),
			avatar_url = COALESCE(?, avatar_url),
			last_login = CURRENT_TIMESTAMP
		RETURNING id;
		`,
	)
		.bind(
			email,
			profile?.given_name || null,
			profile?.family_name || null,
			profile?.picture || null,
			profile?.given_name || null,
			profile?.family_name || null,
			profile?.picture || null
		)
		.first<{ id: string }>();
	if (!result) {
		throw new Error(`Unable to process user: ${email}`);
	}
	console.log(`Found or created user ${result.id} with email ${email}`);
	return result.id;
}
