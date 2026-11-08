import { createRemoteJWKSet } from "jose";
import { NextResponse, type NextRequest } from "next/server";
import { devHeaderIdentityEnabled } from "@/lib/control-plane/dev-identity";
import { oidcVerificationConfig, verifyOperatorToken } from "@/lib/control-plane/oidc";
import { apiCsp, generateNonce, mediaUploadOrigins, pageCsp, strictTransportSecurity } from "@/lib/csp";

const remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function proxy(request: NextRequest) {
  const security = securityFor(request);
  const response = await authenticate(request, security.forward);
  if (security.csp) response.headers.set("Content-Security-Policy", security.csp);
  else if (!response.headers.has("x-middleware-next")) response.headers.set("Content-Security-Policy", apiCsp);
  if (process.env.NODE_ENV === "production") response.headers.set("Strict-Transport-Security", strictTransportSecurity);
  return response;
}

async function authenticate(request: NextRequest, forward: () => NextResponse) {
  // Only the explicit development header-identity switch (never NODE_ENV)
  // skips bearer verification; route handlers then enforce its loopback rule.
  if (devHeaderIdentityEnabled() || request.nextUrl.pathname === "/api/v1/runtime/telemetry" || request.nextUrl.pathname === "/api/v1/runtime/program-output-observations" || request.nextUrl.pathname === "/api/v1/runtime/recordings" || request.nextUrl.pathname === "/api/v1/runtime/channel-interactions" || request.nextUrl.pathname === "/api/v1/runtime/channel-commerce" || request.nextUrl.pathname === "/api/v1/runtime/settlement-batches" || request.nextUrl.pathname === "/api/v1/integrations/product-facts") return forward();
  const token = accessTokenFrom(request);
  if (!token) return error("missing_bearer_token", 401);
  if (usesCookieAuth(request) && isUnsafeMethod(request.method) && !hasTrustedOrigin(request)) return error("csrf_origin_rejected", 403);
  const oidc = oidcVerificationConfig();
  if (!oidc.ok) return error(oidc.code, 503);
  const jwksUrl = oidc.jwksUrl;
  try {
    const keys = jwksFor(jwksUrl);
    const payload = await verifyOperatorToken(token, keys, oidc);
    const tenantId = stringClaim(payload, "tenant_id");
    const subject = stringClaim(payload, "sub");
    if (!isUuid(tenantId) || !subject) return error("invalid_tenant_subject", 403);
    // Role checks execute in route/page handlers against the active database
    // membership. JWT role claims are intentionally not authorization input.
    return forward();
  } catch {
    return error("bearer_token_verification_failed", 401);
  }
}

// Pages get a fresh nonce-based CSP per request. The policy is also passed on
// the forwarded request, where Next.js reads the nonce and applies it to its
// framework, bundle and inline scripts. API responses take their CSP from
// next.config.ts; only proxy-generated API errors set it here.
function securityFor(request: NextRequest): { csp?: string; forward: () => NextResponse } {
  if (request.nextUrl.pathname === "/api" || request.nextUrl.pathname.startsWith("/api/")) return { forward: () => NextResponse.next() };
  const nonce = generateNonce();
  const development = process.env.NODE_ENV === "development";
  const csp = pageCsp(nonce, { development, mediaUploadOrigins: mediaUploadOrigins(undefined, development) });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  return { csp, forward: () => NextResponse.next({ request: { headers } }) };
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
