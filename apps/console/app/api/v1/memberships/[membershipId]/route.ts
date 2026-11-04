import { requestContextFrom, requireRole, type ActorRole } from "@/lib/control-plane/auth-context";
import { readBoundedJson } from "@/lib/bounded-json";
import { updateMembership, type MembershipStatus } from "@/lib/memberships";

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

function isUpdateInput(value: unknown): value is { role?: ActorRole; status?: MembershipStatus } {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  const hasRole = input.role !== undefined;
  const hasStatus = input.status !== undefined;
  return (hasRole || hasStatus)
    && (!hasRole || typeof input.role === "string" && roles.has(input.role as ActorRole))
    && (!hasStatus || typeof input.status === "string" && statuses.has(input.status as MembershipStatus));
}

function isUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
