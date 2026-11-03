import { createRemoteJWKSet, jwtVerify } from "jose";

export type ActorRole = "admin" | "operator" | "reviewer" | "analyst";

export type RequestContext = {
  tenantId: string;
  actorId: string;
  actorName: string;
  role: ActorRole;
};

const roles = new Set<ActorRole>(["admin", "operator", "reviewer", "analyst"]);
const remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export const demoRequestContext: RequestContext = {
  tenantId: "tenant_demo",
  actorId: "user_lin",
  actorName: "林晓",
  role: "operator"
};

export async function requestContextFrom(request: Request): Promise<RequestContext> {
  if (process.env.NODE_ENV === "production") return contextFromBearerToken(request);

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
    const role = stringClaim(payload, "role");
    const actorId = stringClaim(payload, "sub");
    if (!tenantId || !actorId || !role || !roles.has(role as ActorRole)) throw new Response("Token does not contain a valid tenant role", { status: 403 });
    const actorName = stringClaim(payload, "name") ?? stringClaim(payload, "preferred_username") ?? actorId;
    return { tenantId, actorId, actorName, role: role as ActorRole };
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Bearer token verification failed", { status: 401 });
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

export function requireRole(context: RequestContext, allowed: ActorRole[]) {
  if (!allowed.includes(context.role)) throw new Response("Insufficient permission", { status: 403 });
}
