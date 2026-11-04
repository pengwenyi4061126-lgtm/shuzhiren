import { createRemoteJWKSet, jwtVerify } from "jose";
import { NextResponse, type NextRequest } from "next/server";

const remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function proxy(request: NextRequest) {
  if (process.env.NODE_ENV !== "production" || request.nextUrl.pathname === "/api/v1/runtime/telemetry" || request.nextUrl.pathname === "/api/v1/runtime/recordings" || request.nextUrl.pathname === "/api/v1/runtime/channel-interactions" || request.nextUrl.pathname === "/api/v1/runtime/channel-commerce" || request.nextUrl.pathname === "/api/v1/integrations/product-facts") return NextResponse.next();
  const token = accessTokenFrom(request);
  if (!token) return error("missing_bearer_token", 401);
  if (usesCookieAuth(request) && isUnsafeMethod(request.method) && !hasTrustedOrigin(request)) return error("csrf_origin_rejected", 403);
  const issuer = process.env.OIDC_ISSUER_URL;
  const audience = process.env.OIDC_AUDIENCE;
  const jwksUrl = process.env.OIDC_JWKS_URL;
  if (!issuer || !audience || !jwksUrl) return error("oidc_configuration_missing", 503);
  try {
    const keys = jwksFor(jwksUrl);
    const { payload } = await jwtVerify(token, keys, { issuer, audience });
    const tenantId = stringClaim(payload, "tenant_id");
    const subject = stringClaim(payload, "sub");
    if (!isUuid(tenantId) || !subject) return error("invalid_tenant_subject", 403);
    // Role checks execute in route/page handlers against the active database
    // membership. JWT role claims are intentionally not authorization input.
    return NextResponse.next();
  } catch {
    return error("bearer_token_verification_failed", 401);
  }
}

function jwksFor(url: string) {
  let keys = remoteJwks.get(url);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(url), { timeoutDuration: 5_000 });
    remoteJwks.set(url, keys);
  }
  return keys;
}

function accessTokenFrom(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return request.cookies.get(process.env.OIDC_ACCESS_TOKEN_COOKIE ?? "shuzhiren_access_token")?.value;
}

function usesCookieAuth(request: NextRequest) {
  return !request.headers.get("authorization")?.startsWith("Bearer ") && Boolean(request.cookies.get(process.env.OIDC_ACCESS_TOKEN_COOKIE ?? "shuzhiren_access_token")?.value);
}

function isUnsafeMethod(method: string) { return !["GET", "HEAD", "OPTIONS"].includes(method); }

function hasTrustedOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const configured = process.env.OIDC_ALLOWED_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  try {
    if (new URL(origin).host === request.headers.get("host")) return true;
  } catch {
    return false;
  }
  return configured.includes(origin);
}

function stringClaim(payload: Record<string, unknown>, key: string) { const value = payload[key]; return typeof value === "string" && value.length > 0 ? value : undefined; }
function isUuid(value: string | undefined): value is string { return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)); }
function error(error: string, status: number) { return NextResponse.json({ error }, { status }); }

export const config = { matcher: ["/((?!api/health(?:/.*)?|_next/static|_next/image|favicon.ico).*)"] };
