import { requestContextFrom, requireRole, type ActorRole } from "@/lib/control-plane/auth-context";
import { readBoundedJson } from "@/lib/bounded-json";
import { updateMembership, type MembershipResourceScope, type MembershipStatus } from "@/lib/memberships";
import type { MembershipAccessScope } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";
const roles = new Set<ActorRole>(["admin", "operator", "reviewer", "analyst"]);
const statuses = new Set<MembershipStatus>(["active", "suspended", "revoked"]);

export async function PUT(request: Request, context: RouteContext<"/api/v1/memberships/[membershipId]">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin"]);
    const { membershipId } = await context.params;
    if (!isUuid(membershipId)) return Response.json({ error: "invalid_membership_id" }, { status: 400 });
    const body = await readBoundedJson(request);
    if (!isUpdateInput(body)) return Response.json({ error: "invalid_membership_input" }, { status: 400 });
    return Response.json({ data: await updateMembership(actor, membershipId, body) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "membership_rejected" }, { status: error.status });
    throw error;
  }
}

function isUpdateInput(value: unknown): value is { role?: ActorRole; status?: MembershipStatus; accessScope?: MembershipAccessScope; resourceScopes?: MembershipResourceScope[] } {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  const hasRole = input.role !== undefined;
  const hasStatus = input.status !== undefined;
  const hasAccessScope = input.accessScope !== undefined;
  const hasResourceScopes = input.resourceScopes !== undefined;
  return (hasRole || hasStatus || hasAccessScope || hasResourceScopes)
    && (!hasRole || typeof input.role === "string" && roles.has(input.role as ActorRole))
    && (!hasStatus || typeof input.status === "string" && statuses.has(input.status as MembershipStatus))
    && (!hasAccessScope || input.accessScope === "tenant" || input.accessScope === "restricted")
    && (!hasResourceScopes || Array.isArray(input.resourceScopes) && input.resourceScopes.length <= 200 && input.resourceScopes.every(isResourceScope))
    && Object.keys(input).every((key) => ["role", "status", "accessScope", "resourceScopes"].includes(key));
}

function isUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

function isResourceScope(value: unknown): value is MembershipResourceScope {
  return Boolean(value) && typeof value === "object"
    && ((value as Record<string, unknown>).resourceType === "channel_connection" || (value as Record<string, unknown>).resourceType === "live_run")
    && typeof (value as Record<string, unknown>).resourceId === "string"
    && isUuid((value as Record<string, string>).resourceId);
}
