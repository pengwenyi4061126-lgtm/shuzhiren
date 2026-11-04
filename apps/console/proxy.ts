import { createRemoteJWKSet, jwtVerify } from "jose";
import { NextResponse, type NextRequest } from "next/server";

const roles = new Set(["admin", "operator", "reviewer", "analyst"]);
type Role = "admin" | "operator" | "reviewer" | "analyst";
const operatorRoles: Role[] = ["admin", "operator"];
const reviewerRoles: Role[] = ["admin", "reviewer"];
const observerRoles: Role[] = ["admin", "operator", "analyst"];
const reviewObserverRoles: Role[] = ["admin", "reviewer", "analyst"];
const allRoles: Role[] = ["admin", "operator", "reviewer", "analyst"];
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
    const role = stringClaim(payload, "role");
    if (!tenantId || !role || !roles.has(role)) return error("invalid_tenant_role", 403);
    const allowed = await requiredRoles(request);
    if (allowed && !allowed.includes(role as Role)) return error("insufficient_permission", 403);
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

async function requiredRoles(request: NextRequest): Promise<Role[] | undefined> {
  const path = request.nextUrl.pathname;
  const method = request.method;

  if (method === "GET") {
    if (path === "/api/v1/alerts" || path === "/api/v1/incidents" || path === "/api/v1/entitlements" || path === "/api/v1/recordings" || path === "/api/v1/policy/profiles" || /^\/api\/v1\/live-runs\/[^/]+\/(telemetry|slo)$/.test(path) || path === "/api/v1/runtime/outbox") return observerRoles;
    if (path === "/api/v1/audit-events/export") return reviewerRoles;
    if (path === "/api/v1/audit-events" || path === "/api/v1/audit-events/verification") return reviewObserverRoles;
    if (path === "/api/v1/channels/connections" || path === "/api/v1/channels/capabilities") return observerRoles;
    if (/^\/api\/v1\/live-runs\/[^/]+\/(events|interactions|reply-drafts)$/.test(path) || path === "/api/v1/live-runs") return allRoles;
    if (path === "/api/v1/runtime/health") return operatorRoles;
    return undefined;
  }

  if (method === "POST") {
    if (path === "/api/v1/assets" || path === "/api/v1/channels/connections" || path === "/api/v1/live-runs" || path === "/api/v1/releases" || path === "/api/v1/products" || /^\/api\/v1\/products\/[^/]+\/versions$/.test(path)) return operatorRoles;
    if (/^\/api\/v1\/assets\/[^/]+\/(approve|revoke)$/.test(path) || /^\/api\/v1\/releases\/[^/]+\/(approve|revoke)$/.test(path) || /^\/api\/v1\/products\/[^/]+\/versions\/[^/]+\/approve$/.test(path) || /^\/api\/v1\/live-runs\/[^/]+\/reply-drafts\/[^/]+\/(approve|reject)$/.test(path)) return reviewerRoles;
    if (/^\/api\/v1\/live-runs\/[^/]+\/reply-drafts(?:\/[^/]+\/(submit|send|retry))?$/.test(path)) return operatorRoles;
    if (/^\/api\/v1\/channels\/connections\/[^/]+\/verify$/.test(path) || /^\/api\/v1\/live-runs\/[^/]+\/(commands|interactions|response-drafts|speech-dispatches)$/.test(path) || /^\/api\/v1\/live-runs\/[^/]+\/interactions\/[^/]+\/handle$/.test(path) || /^\/api\/v1\/alerts\/[^/]+\/acknowledge$/.test(path) || path === "/api/v1/incidents" || /^\/api\/v1\/incidents\/[^/]+\/resolve$/.test(path) || path === "/api/v1/runtime/media" || /^\/api\/v1\/runtime\/outbox\/[^/]+\/deliver$/.test(path)) return operatorRoles;
    if (path === "/api/v1/policy/evaluate") return ["admin", "operator", "reviewer"];
    if (path === "/api/v1/policy/profiles") return operatorRoles;
    if (/^\/api\/v1\/policy\/profiles\/[^/]+\/approve$/.test(path)) return reviewerRoles;
    if (/^\/api\/v1\/policy\/profiles\/[^/]+\/revoke$/.test(path)) return reviewerRoles;
    // The route applies action-specific roles after bounded JSON parsing. Keep
    // middleware body-free so an oversized lifecycle request cannot bypass the
    // shared request-size boundary merely to select a role.
    if (/^\/api\/v1\/live-runs\/[^/]+\/lifecycle$/.test(path)) return allRoles;
  }

  if (method === "PUT" && /^\/api\/v1\/entitlements\/[^/]+$/.test(path)) return ["admin"];
  if (method === "PUT" && /^\/api\/v1\/live-runs\/[^/]+\/reply-drafts\/[^/]+$/.test(path)) return operatorRoles;
  if (method === "PUT" && /^\/api\/v1\/live-runs\/[^/]+\/runtime-session$/.test(path)) return operatorRoles;
  return undefined;
}

function stringClaim(payload: Record<string, unknown>, key: string) { const value = payload[key]; return typeof value === "string" && value.length > 0 ? value : undefined; }
function error(error: string, status: number) { return NextResponse.json({ error }, { status }); }

export const config = { matcher: ["/((?!api/health(?:/.*)?|_next/static|_next/image|favicon.ico).*)"] };
