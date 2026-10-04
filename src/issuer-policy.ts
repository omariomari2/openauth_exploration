export interface AuthSettings {
	origin: string;
	clientID: string;
	callbackURI: string;
}

export interface DemoEnv extends Env { ISSUER_ORIGIN: string }

export function readAuthSettings(origin: string): AuthSettings {
	const url = new URL(origin);
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.origin !== origin || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
		throw new Error("Invalid issuer configuration");
	}
	return { origin, clientID: "openauth-demo", callbackURI: `${origin}/callback` };
}

function reject(error: string, status: number): Response {
	return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export function prepareIssuerRequest(request: Request, settings: AuthSettings): Request | Response {
	const url = new URL(request.url);
	if (url.origin !== settings.origin) return reject("unrecognized_origin", 421);
	// This demo has only fixed ASCII routes. Hono decodes path escapes before
	// matching routes, so reject aliases before any route-specific security check.
	if (url.pathname.includes("%")) return reject("invalid_path", 400);
	const origin = request.headers.get("Origin");
	if (origin !== null && origin !== settings.origin) return reject("unrecognized_origin", 403);
	if (url.pathname === "/authorize") {
		if (request.method !== "GET") return reject("method_not_allowed", 405);
		const params = url.searchParams;
		const challenge = params.get("code_challenge") ?? "";
		const state = params.get("state") ?? "";
		const allowed = ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method", "provider"];
		if ([...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1) ||
			params.get("client_id") !== settings.clientID || params.get("redirect_uri") !== settings.callbackURI ||
			params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256" ||
			challenge.length !== 43 || /[^A-Za-z0-9_-]/.test(challenge) ||
			state.length < 32 || state.length > 128 || /[^A-Za-z0-9_-]/.test(state) ||
			(params.has("provider") && params.get("provider") !== "google")) {
			return reject("invalid_authorization_request", 400);
		}
	}
	// OpenAuth's getRelativeUrl trusts these headers. Pin it to the configured URL.
	const headers = new Headers(request.headers);
	for (const name of ["x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "forwarded"]) headers.delete(name);
	return new Request(request, { headers });
}
