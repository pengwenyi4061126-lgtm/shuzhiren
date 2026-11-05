import { createRemoteJWKSet, jwtVerify } from "jose";
import { assertDevIdentityPermitted, devHeaderIdentityEnabled } from "@/lib/control-plane/dev-identity";
import { withTenantTransaction } from "@/lib/database";

export type ActorRole = "admin" | "operator" | "reviewer" | "analyst";
export type MembershipAccessScope = "tenant" | "restricted";

export type RequestContext = {
  tenantId: string;
  actorId: string;
  actorName: string;
  role: ActorRole;
  membershipId?: string;
  accessScope?: MembershipAccessScope;
};

const roles = new Set<ActorRole>(["admin", "operator", "reviewer", "analyst"]);
const remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export const demoRequestContext: RequestContext = {
  tenantId: "tenant_demo",
  actorId: "user_lin",
  actorName: "林晓",
  role: "operator",
  accessScope: "tenant"
};

// Bearer/OIDC identity is required unless CONTROL_PLANE_DEV_HEADER_IDENTITY is
// exactly "true" (local `npm run dev` only); NODE_ENV alone never enables the
// development request headers.
export async function requestContextFrom(request: Request): Promise<RequestContext> {
  if (!devHeaderIdentityEnabled()) return contextFromBearerToken(request);
  assertDevIdentityPermitted();
  return devHeaderContext(request);
}

function devHeaderContext(request: Request): RequestContext {
  const tenantId = request.headers.get("x-tenant-id");
  const actorId = request.headers.get("x-actor-id");
  const actorName = request.headers.get("x-actor-name");
  const role = request.headers.get("x-actor-role");

  if (!tenantId || !actorId || !actorName || !role) return demoRequestContext;

  if (!roles.has(role as ActorRole)) throw new Response("Invalid actor role", { status: 403 });
  return { tenantId, actorId, actorName, role: role as ActorRole };
}

async function contextFromBearerToken(request: Request): Promise<RequestContext> {
  const token = accessTokenFrom(request);
  if (!token) throw new Response("Missing bearer token", { status: 401 });
  const issuer = process.env.OIDC_ISSUER_URL;
  const audience = process.env.OIDC_AUDIENCE;
  const jwksUrl = process.env.OIDC_JWKS_URL;
  if (!issuer || !audience || !jwksUrl) throw new Error("OIDC_ISSUER_URL, OIDC_AUDIENCE, and OIDC_JWKS_URL are required in production");

  try {
    const keys = jwksFor(jwksUrl);
    const { payload } = await jwtVerify(token, keys, { issuer, audience });
    const tenantId = stringClaim(payload, "tenant_id");
    const actorId = stringClaim(payload, "sub");
    if (!isUuid(tenantId) || !actorId) throw new Response("Token does not contain a valid tenant subject", { status: 403 });
    return resolveActiveMembership(tenantId, actorId);
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Bearer token verification failed", { status: 401 });
  }
}

async function resolveActiveMembership(tenantId: string, actorId: string): Promise<RequestContext> {
  const membership = await withTenantTransaction(tenantId, async (client) => {
    const result = await client.query<{ id: string; role: ActorRole; display_name: string; access_scope: MembershipAccessScope }>(
      `select m.id, m.role, m.access_scope, u.display_name
       from memberships m join users u on u.id = m.user_id
       where m.tenant_id = $1::uuid and u.external_subject = $2 and m.status = 'active'`,
      [tenantId, actorId]
    );
    return result.rows[0] ?? null;
  });
  if (!membership || !roles.has(membership.role)) throw new Response("No active tenant membership", { status: 403 });
  return {
    tenantId,
    actorId,
    actorName: membership.display_name,
    role: membership.role,
    membershipId: membership.id,
    accessScope: membership.access_scope
  };
}

function jwksFor(url: string) {
  let keys = remoteJwks.get(url);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(url), { timeoutDuration: 5_000 });
    remoteJwks.set(url, keys);
  }
  return keys;
}

function accessTokenFrom(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  const cookieName = process.env.OIDC_ACCESS_TOKEN_COOKIE ?? "shuzhiren_access_token";
  const encoded = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!encoded) return undefined;
  try { return decodeURIComponent(encoded); } catch { return undefined; }
}

function stringClaim(payload: Record<string, unknown>, claim: string) {
  const value = payload[claim];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isUuid(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

export function requireRole(context: RequestContext, allowed: ActorRole[]) {
  if (!allowed.includes(context.role)) throw new Response("Insufficient permission", { status: 403 });
}

export function hasTenantWideAccess(context: RequestContext) {
  return context.accessScope !== "restricted";
}

export function requireTenantWideAccess(context: RequestContext) {
  if (!hasTenantWideAccess(context)) throw new Response("Tenant-wide access scope is required", { status: 403 });
}
