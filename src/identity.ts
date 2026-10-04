import * as v from "valibot";

const googleProfileSchema = v.object({
  // Google subjects are stable, case-sensitive ASCII identifiers, never emails.
  // https://developers.google.com/identity/openid-connect/openid-connect#an-id-tokens-payload
  sub: v.pipe(v.string(), v.minLength(1), v.maxLength(255), v.regex(/^[\x21-\x7e]+$/)),
  email: v.pipe(v.string(), v.maxLength(254), v.email()),
  email_verified: v.literal(true),
  given_name: v.optional(v.pipe(v.string(), v.maxLength(100), v.regex(/^[^\x00-\x1f\x7f]*$/))),
  family_name: v.optional(v.pipe(v.string(), v.maxLength(100), v.regex(/^[^\x00-\x1f\x7f]*$/))),
});

export type GoogleProfile = v.InferOutput<typeof googleProfileSchema>;

export function parseGoogleProfile(value: unknown): GoogleProfile {
  const result = v.safeParse(googleProfileSchema, value);
  if (!result.success) throw new Error("Unable to verify Google identity");
  return result.output;
}

const MAX_USERINFO_BYTES = 16_384;
const USERINFO_TIMEOUT_MS = 5_000;

export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  if (typeof accessToken !== "string" || accessToken.length > 8192 || !/^[\x21-\x7e]+$/.test(accessToken)) {
    throw new Error("Unable to verify Google identity");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USERINFO_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    // Pinned Google endpoint; never forward the bearer token to a redirect target.
    // https://developers.google.com/identity/openid-connect/openid-connect#obtaininguserprofileinformation
    const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 200 || response.redirected || !response.body ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) {
      throw new Error();
    }
    const contentLength = response.headers.get("Content-Length");
    if (contentLength !== null && (!Number.isSafeInteger(Number(contentLength)) ||
      Number(contentLength) < 0 || Number(contentLength) > MAX_USERINFO_BYTES)) {
      throw new Error();
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    let bytes = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_USERINFO_BYTES) throw new Error();
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return parseGoogleProfile(JSON.parse(text));
  } catch {
    // Provider bodies, tokens, validation issues, and raw errors stay private.
    throw new Error("Unable to verify Google identity");
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export async function getOrCreateGoogleUser(db: D1Database, profile: GoogleProfile): Promise<string> {
  const verified = parseGoogleProfile(profile);
  const candidateId = crypto.randomUUID();
  try {
    // D1 batches are transactions: concurrent logins cannot interleave these writes.
    // https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
    const results = await db.batch<{ id: string }>([
      db.prepare(`
        INSERT INTO user (id, email, first_name, last_name, last_login)
        SELECT ?, ?, ?, ?, CURRENT_TIMESTAMP
        WHERE NOT EXISTS (
          SELECT 1 FROM user_identities WHERE provider = 'google' AND provider_subject = ?
        ) AND NOT EXISTS (SELECT 1 FROM user WHERE email = ? COLLATE NOCASE)
      `).bind(candidateId, verified.email, verified.given_name ?? null, verified.family_name ?? null,
        verified.sub, verified.email),
      // On occupied email the user insert is skipped. This FK then rejects the
      // absent candidate and rolls back; it must never link the email's owner.
      db.prepare(`
        INSERT INTO user_identities (provider, provider_subject, user_id)
        SELECT 'google', ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM user_identities WHERE provider = 'google' AND provider_subject = ?
        )
      `).bind(verified.sub, candidateId, verified.sub),
      db.prepare(`
        UPDATE user SET last_login = CURRENT_TIMESTAMP
        WHERE id = (
          SELECT user_id FROM user_identities WHERE provider = 'google' AND provider_subject = ?
        )
      `).bind(verified.sub),
      db.prepare(`
        SELECT user_id AS id FROM user_identities WHERE provider = 'google' AND provider_subject = ?
      `).bind(verified.sub),
    ]);
    const userId = results[3]?.results[0]?.id;
    if (!userId) throw new Error();
    return userId;
  } catch {
    throw new Error("Unable to complete Google sign-in");
  }
}
