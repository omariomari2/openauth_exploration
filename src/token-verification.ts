import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import * as v from "valibot";

const accessTokenSchema = v.object({
  iss: v.pipe(v.string(), v.minLength(1)),
  aud: v.pipe(v.string(), v.minLength(1)),
  exp: v.pipe(v.number(), v.finite()),
  sub: v.pipe(v.string(), v.minLength(1)),
  mode: v.literal("access"),
  type: v.literal("user"),
  properties: v.object({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(255)) }),
});

export async function verifyAccessToken(
  token: string,
  config: { issuer: string; audience: string; jwks: JSONWebKeySet },
): Promise<string | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > 16_384) return null;
  try {
    // JOSE verifies signatures and claims; exp must be explicitly required.
    // https://github.com/panva/jose/blob/v5.9.6/docs/jwt/verify/functions/jwtVerify.md
    // A fresh local resolver uses this call's keys, including after rotation.
    // https://github.com/panva/jose/blob/v5.9.6/docs/jwks/local/functions/createLocalJWKSet.md
    const { payload } = await jwtVerify(token, createLocalJWKSet(config.jwks), {
      algorithms: ["ES256"],
      issuer: config.issuer,
      audience: config.audience,
      requiredClaims: ["iss", "aud", "exp", "sub"],
    });
    const result = v.safeParse(accessTokenSchema, payload);
    // JOSE accepts membership in aud arrays; this application requires one exact client.
    if (!result.success || result.output.iss !== config.issuer || result.output.aud !== config.audience) {
      return null;
    }
    return result.output.properties.id;
  } catch {
    return null;
  }
}
