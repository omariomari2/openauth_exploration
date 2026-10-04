import * as v from "valibot";

const nameSchema = v.nullable(v.pipe(v.string(), v.regex(/^[^\x00-\x1f\x7f-\x9f]*$/),
  v.trim(), v.maxLength(100), v.transform((value) => value || null)));
const patchSchema = v.pipe(v.strictObject({
  firstName: v.optional(nameSchema), lastName: v.optional(nameSchema),
}), v.check((value) => Object.keys(value).length > 0));
export type ProfilePatch = v.InferOutput<typeof patchSchema>;
const MAX_BODY_BYTES = 4096;
const BODY_TIMEOUT_MS = 5000;

function invalid(error = "invalid_profile", status = 400): Response {
  return Response.json({ error }, { status });
}

export async function readProfilePatch(request: Request): Promise<ProfilePatch | Response> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset=(?:"utf-8"|utf-8))?\s*$/i.test(contentType) ||
    ![null, "identity"].includes(request.headers.get("Content-Encoding"))) return invalid("unsupported_media_type", 415);
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0) return invalid();
    if (length > MAX_BODY_BYTES) return invalid("payload_too_large", 413);
  }
  if (!request.body) return invalid();
  const reader = request.body.getReader();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { timedOut = true; reject(new Error()); }, BODY_TIMEOUT_MS);
  });
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    let bytes = 0;
    let text = "";
    while (true) {
      // Incoming request streams are not cancelled by an unrelated AbortController.
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) return invalid("payload_too_large", 413);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const parsed = v.safeParse(patchSchema, JSON.parse(text));
    return parsed.success ? parsed.output : invalid();
  } catch {
    return timedOut ? invalid("request_timeout", 408) : invalid();
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
