import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

// Asymmetric JWS algorithms only: HMAC algorithms and "none" can never verify an
// operator token, whatever the identity provider's JWKS contains.
export const supportedOidcAlgorithms = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"] as const;
const supportedAlgorithmSet = new Set<string>(supportedOidcAlgorithms);

export type OidcVerificationSettings = { issuer: string; audience: string; jwksUrl: string; algorithms: string[]; expectedTyp?: string };
export type OidcVerificationConfig = ({ ok: true } & OidcVerificationSettings) | { ok: false; code: "oidc_configuration_missing" | "oidc_algorithms_not_configured" };

export function oidcVerificationConfig(env: NodeJS.ProcessEnv = process.env): OidcVerificationConfig {
  const issuer = env.OIDC_ISSUER_URL;
  const audience = env.OIDC_AUDIENCE;
  const jwksUrl = env.OIDC_JWKS_URL;
  if (!issuer || !audience || !jwksUrl) return { ok: false, code: "oidc_configuration_missing" };
  const algorithms = allowedAlgorithms(env.OIDC_ALLOWED_ALGORITHMS);
  if (!algorithms) return { ok: false, code: "oidc_algorithms_not_configured" };
  const expectedTyp = env.OIDC_EXPECTED_TYP?.trim() || undefined;
  return { ok: true, issuer, audience, jwksUrl, algorithms, ...(expectedTyp ? { expectedTyp } : {}) };
}

// OIDC_ALLOWED_ALGORITHMS is a comma-separated allowlist. When it is not set the
// full asymmetric set applies; a value that is empty or names any other
// algorithm (for example HS256 or none) leaves verification unconfigured.
function allowedAlgorithms(raw: string | undefined) {
  if (raw === undefined) return [...supportedOidcAlgorithms];
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (!values.length || values.some((value) => !supportedAlgorithmSet.has(value))) return null;
  return [...new Set(values)];
}

// Signature, issuer, audience, an allowlisted alg, a numeric unexpired exp (no
// clock tolerance) and, when configured, the typ header must all hold.
export async function verifyOperatorToken(token: string, keys: JWTVerifyGetKey, config: OidcVerificationSettings): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, keys, {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: config.algorithms,
    requiredClaims: ["exp"],
    ...(config.expectedTyp ? { typ: config.expectedTyp } : {})
  });
  return payload;
}
