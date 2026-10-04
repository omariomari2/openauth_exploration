import type { MiddlewareHandler } from "hono";

// OpenAuth 0.4.3 installs a query-string logger unconditionally. Wrangler aliases
// hono/logger here so codes never enter logs; dependency files remain untouched.
export function logger(): MiddlewareHandler {
	return async (_context, next) => { await next(); };
}
