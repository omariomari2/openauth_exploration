const COOKIE_NAMES = ["provider", "authorization"];
const REPLACED_ATTRIBUTES = ["domain", "path", "secure", "httponly", "samesite"];

function trimCookieWhitespace(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, "");
}

function cookiePrefix(request: Request): string | undefined {
  const url = new URL(request.url);
  if (url.protocol === "https:") return "__Host-openauth-";
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return "local-openauth-";
  }
}

function invalidCookie(): Response {
  return Response.json({ error: "invalid_login_cookie" }, {
    status: 400, headers: { "Cache-Control": "no-store" },
  });
}

// Call only after the request origin has passed the AuthSettings boundary.
export function translateIssuerCookies(request: Request): Request | Response {
  const prefix = cookiePrefix(request);
  if (!prefix) return invalidCookie();
  const translated: string[] = [];
  const seen = new Set<string>();
  for (const pair of (request.headers.get("Cookie") ?? "").split(";")) {
    if (!trimCookieWhitespace(pair)) continue;
    const separator = pair.indexOf("=");
    const name = trimCookieWhitespace(separator < 0 ? pair : pair.slice(0, separator));
    if (COOKIE_NAMES.includes(name)) continue;
    const internalName = COOKIE_NAMES.find((key) => `${prefix}${key}` === name);
    if (internalName && separator >= 0) {
      if (seen.has(internalName)) return invalidCookie();
      seen.add(internalName);
      translated.push(`${internalName}${pair.slice(separator)}`);
    } else translated.push(trimCookieWhitespace(pair));
  }
  const headers = new Headers(request.headers);
  if (translated.length) headers.set("Cookie", translated.join("; "));
  else headers.delete("Cookie");
  return new Request(request, { headers });
}

export function protectIssuerCookies(response: Response, request: Request): Response {
  const prefix = cookiePrefix(request);
  if (!prefix) return invalidCookie();
  const headers = new Headers(response.headers);
  headers.delete("Set-Cookie");
  for (const cookie of response.headers.getSetCookie()) {
    const [pair, ...attributes] = cookie.split(";");
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator).trim();
    if (separator < 0 || !COOKIE_NAMES.includes(name)) {
      headers.append("Set-Cookie", cookie);
      continue;
    }
    const retained = attributes.map((attribute) => attribute.trim()).filter((attribute) =>
      attribute && !REPLACED_ATTRIBUTES.includes(attribute.split("=", 1)[0].trim().toLowerCase()));
    // __Host- requires Secure, Path=/ and no Domain, preventing sibling-host injection.
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#cookie_prefixes
    headers.append("Set-Cookie", [
      `${prefix}${name}${pair.slice(separator)}`, ...retained, "Path=/", "HttpOnly", "SameSite=Lax",
      ...(prefix === "__Host-openauth-" ? ["Secure"] : []),
    ].join("; "));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
