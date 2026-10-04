import { parse } from "hono/utils/cookie";

const COOKIE_NAMES = ["authorization", "provider"];
// Exact protected header emitted by pinned OpenAuth 0.4.3. JOSE otherwise puts
// attacker-supplied header fields (e.g. crit) in exceptions OpenAuth logs internally.
const HEADER = btoa('{"alg":"RSA-OAEP-512","enc":"A256GCM"}').replace(/=+$/, "");

export function rejectMalformedIssuerCookies(request: Request): Response | undefined {
	const cookie = request.headers.get("Cookie") ?? "";
	for (const name of COOKIE_NAMES) {
		// Use the same decoding/duplicate-cookie semantics as OpenAuth's Hono helper.
		const value = parse(cookie, name)[name];
		if (value === undefined) continue;
		const parts = value.split(".");
		if (value.length <= 4096 && parts.length === 5 && parts[0] === HEADER &&
			/^[A-Za-z0-9_-]{342}$/.test(parts[1]) && /^[A-Za-z0-9_-]{16}$/.test(parts[2]) &&
			/^[A-Za-z0-9_-]+$/.test(parts[3]) && /^[A-Za-z0-9_-]{22}$/.test(parts[4])) continue;
		const headers = new Headers({ "Cache-Control": "no-store" });
		for (const key of COOKIE_NAMES) {
			headers.append("Set-Cookie", `${key}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${request.url.startsWith("https:") ? "; Secure" : ""}`);
		}
		return Response.json({ error: "invalid_login_cookie" }, { status: 400, headers });
	}
	// This is only a syntax guard, not authentication. OpenAuth still decrypts and
	// authenticates these cookies; altered ciphertext produces a generic JOSE error.
}
