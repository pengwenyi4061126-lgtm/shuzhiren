import { createRemoteJWKSet, jwtVerify } from "jose";
import { NextResponse, type NextRequest } from "next/server";

const roles = new Set(["admin", "operator", "reviewer", "analyst"]);

export async function proxy(request: NextRequest) {
  if (process.env.NODE_ENV !== "production" || request.nextUrl.pathname === "/api/v1/runtime/telemetry") return NextResponse.next();
  const token = accessTokenFrom(request);
  if (!token) return error("missing_bearer_token", 401);
  const issuer = process.env.OIDC_ISSUER_URL;
  const audience = process.env.OIDC_AUDIENCE;
  const jwksUrl = process.env.OIDC_JWKS_URL;
  if (!issuer || !audience || !jwksUrl) return error("oidc_configuration_missing", 503);
  try {
    const keys = createRemoteJWKSet(new URL(jwksUrl));
    const { payload } = await jwtVerify(token, keys, { issuer, audience });
    const tenantId = stringClaim(payload, "tenant_id");
    const role = stringClaim(payload, "role");
    if (!tenantId || !role || !roles.has(role)) return error("invalid_tenant_role", 403);
    return NextResponse.next();
  } catch {
    return error("bearer_token_verification_failed", 401);
  }
}

function accessTokenFrom(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return request.cookies.get(process.env.OIDC_ACCESS_TOKEN_COOKIE ?? "shuzhiren_access_token")?.value;
}

function stringClaim(payload: Record<string, unknown>, key: string) { const value = payload[key]; return typeof value === "string" && value.length > 0 ? value : undefined; }
function error(error: string, status: number) { return NextResponse.json({ error }, { status }); }

export const config = { matcher: "/api/v1/:path*" };
