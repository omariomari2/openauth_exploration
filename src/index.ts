import { issuer } from "@openauthjs/openauth";
import { createIssuerStorage } from "./issuer-storage";
import { GoogleProvider } from "@openauthjs/openauth/provider/google";
import { createSubjects } from "@openauthjs/openauth/subject";
import { object, string } from "valibot";
import { rejectMalformedIssuerCookies } from "./observability/issuer-cookies";
import { fetchGoogleProfile, getOrCreateGoogleUser } from "./identity";
import { prepareIssuerRequest, readAuthSettings, type DemoEnv } from "./issuer-policy";
import { handleBrowserRequest } from "./browser-auth";
import { cleanupExpiredAuth } from "./browser-auth-storage";
import { handleBearerProfileRequest } from "./bearer-profile";
import { handleDemoRequest } from "./demo";
import { translateIssuerCookies, protectIssuerCookies } from "./observability/issuer-cookie-boundary";

// This demo issues only the D1 account ID; profile fields come from current D1 data.
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
	const demo = handleDemoRequest(prepared);
	if (demo) return demo;
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
	// https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
	async scheduled(_controller: ScheduledController, env: DemoEnv) {
		try { await cleanupExpiredAuth(env.AUTH_DB); }
		catch {
			const requestId = crypto.randomUUID();
			console.error(JSON.stringify({ event: "authentication_cleanup_failed", requestId }));
			// Fail the invocation without leaking database errors into runtime logs.
			throw new Error("Authentication cleanup failed");
		}
	},
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
		const demoPage = new URL(request.url).pathname === "/" && response.status === 200 &&
			response.headers.get("Content-Type")?.startsWith("text/html");
		response.headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" +
			(demoPage ? "; script-src 'self'; style-src 'self'; connect-src 'self'" : ""));
		if (new URL(request.url).protocol === "https:") response.headers.set("Strict-Transport-Security", "max-age=31536000");
		return response;
	},
} satisfies ExportedHandler<DemoEnv>;
