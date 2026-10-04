import * as v from "valibot";

const TRANSACTION_LIFETIME = 10 * 60 * 1000;
const SESSION_LIFETIME = 60 * 60 * 1000;
const stateSchema = v.pipe(v.string(), v.length(36), v.uuid());
const tokenSchema = v.pipe(v.string(), v.length(43), v.regex(/^[A-Za-z0-9_-]+$/));
const transactionSchema = v.object({
  state: stateSchema,
  verifier: v.pipe(v.string(), v.minLength(43), v.maxLength(128),
    v.check((value) => !/[^A-Za-z0-9._~-]/.test(value))),
});
const userIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(255),
  v.check((value) => !/[^\x21-\x7e]/.test(value)));

function validTime(now: number): boolean {
  return Number.isSafeInteger(now) && now >= 0 && now <= Number.MAX_SAFE_INTEGER - SESSION_LIFETIME;
}

function randomToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createLoginTransaction(
  db: D1Database, input: { state: string; verifier: string }, now = Date.now(),
): Promise<string> {
  const parsed = v.safeParse(transactionSchema, input);
  if (!parsed.success || !validTime(now)) throw new Error("Unable to create login transaction");
  const browserToken = randomToken();
  try {
    await db.prepare(`
      INSERT INTO login_transactions (state_hash, browser_hash, verifier, expires_at) VALUES (?, ?, ?, ?)
    `).bind(await hash(parsed.output.state), await hash(browserToken), parsed.output.verifier,
      now + TRANSACTION_LIFETIME).run();
    return browserToken;
  } catch {
    throw new Error("Unable to create login transaction");
  }
}

export async function consumeLoginTransaction(
  db: D1Database, state: string, browserToken: string, now = Date.now(),
): Promise<string | null> {
  if (!v.is(stateSchema, state) || !v.is(tokenSchema, browserToken) || !validTime(now)) return null;
  // Matching and deletion are one statement; a wrong browser cannot burn the real transaction.
  return db.prepare(`
    DELETE FROM login_transactions WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
    RETURNING verifier
  `).bind(await hash(state), await hash(browserToken), now).first<string>("verifier");
}

export async function createSession(
  db: D1Database, userId: string, now = Date.now(),
): Promise<{ token: string; csrfToken: string; expiresAt: number }> {
  if (!v.is(userIdSchema, userId) || !validTime(now)) throw new Error("Unable to create session");
  const token = randomToken();
  const csrfToken = randomToken();
  const expiresAt = now + SESSION_LIFETIME;
  try {
    await db.prepare(`
      INSERT INTO browser_sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)
    `).bind(await hash(token), userId, csrfToken, expiresAt).run();
    return { token, csrfToken, expiresAt };
  } catch {
    throw new Error("Unable to create session");
  }
}

export async function readSession(
  db: D1Database, token: string, now = Date.now(),
): Promise<{ userId: string; csrfToken: string; expiresAt: number } | null> {
  if (!v.is(tokenSchema, token) || !validTime(now)) return null;
  return db.prepare(`
    SELECT user_id AS userId, csrf_token AS csrfToken, expires_at AS expiresAt
    FROM browser_sessions WHERE token_hash = ? AND expires_at > ?
  `).bind(await hash(token), now).first();
}

export async function revokeSession(db: D1Database, token: string): Promise<void> {
  if (!v.is(tokenSchema, token)) return;
  await db.prepare("DELETE FROM browser_sessions WHERE token_hash = ?").bind(await hash(token)).run();
}

export async function cleanupExpiredAuth(db: D1Database, now = Date.now()): Promise<void> {
  if (!validTime(now)) throw new Error("Unable to clean up authentication data");
  await db.batch([
    db.prepare("DELETE FROM login_transactions WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM browser_sessions WHERE expires_at <= ?").bind(now),
  ]);
}
