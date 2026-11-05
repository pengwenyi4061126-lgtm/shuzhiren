// OIDC stub for integration tests (design part 8, section 1.3 `oidc`): an RS256 key pair from node:crypto,
// the JWKS published on an HttpStub at /jwks, and signOperatorToken() producing compact JWS tokens with the
// claims the console reads (tenant_id, role, name). No dependency beyond node:crypto.
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";

export const OIDC_AUDIENCE = "shuzhiren-integration";
const base64url = (input) => Buffer.from(input).toString("base64url");

/** "5m", "30s", "2h", "1d" or a number of seconds. */
export function durationSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const match = /^(-?\d+)\s*([smhd])$/.exec(String(value));
  if (!match) throw new Error(`unsupported expiresIn ${JSON.stringify(value)}`);
  return Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86_400 }[match[2]];
}

/** Signs a JWT with RS256. `header` overrides the protected header fields. */
export function signJwt(payload, privateKey, header = {}) {
  const protectedHeader = { alg: "RS256", typ: "JWT", ...header };
  const signingInput = `${base64url(JSON.stringify(protectedHeader))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign("sha256", Buffer.from(signingInput), typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

/** Publishes the JWKS on `stub` and returns the harness `oidc` object. */
export function createOidcStub(stub, { audience = OIDC_AUDIENCE, kid = `it-${randomUUID().slice(0, 8)}` } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const issuer = `${stub.baseUrl}/issuer`;
  const jwksUrl = `${stub.baseUrl}/jwks`;
  stub.route("GET", "/jwks", () => ({ status: 200, json: { keys: [jwk] } }));
  stub.route("GET", "/issuer/.well-known/openid-configuration", () => ({ status: 200, json: { issuer, jwks_uri: jwksUrl, id_token_signing_alg_values_supported: ["RS256"] } }));
  return {
    issuer,
    audience,
    jwksUrl,
    kid,
    jwk,
    async signOperatorToken({ tenantId, subject, name = "Integration Operator", role = "operator", expiresIn = "5m", header = {}, claims = {} }) {
      if (!tenantId || !subject) throw new Error("signOperatorToken requires tenantId and subject");
      const now = Math.floor(Date.now() / 1000);
      const payload = { tenant_id: tenantId, role, name, ...claims, sub: subject, iss: issuer, aud: audience, iat: now, exp: now + durationSeconds(expiresIn) };
      return signJwt(payload, privateKey, { kid, ...header });
    }
  };
}
