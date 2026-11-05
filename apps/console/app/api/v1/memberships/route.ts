import { requestContextFrom, requireRole, type ActorRole } from "@/lib/control-plane/auth-context";
import { readBoundedJson } from "@/lib/bounded-json";
import { createMembership, listMemberships } from "@/lib/memberships";

export const dynamic = "force-dynamic";
const roles = new Set<ActorRole>(["admin", "operator", "reviewer", "analyst"]);

export async function GET(request: Request) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin"]);
    return Response.json({ data: await listMemberships(actor) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "membership_rejected" }, { status: error.status });
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin"]);
    const body = await readBoundedJson(request);
    if (!isCreateInput(body)) return Response.json({ error: "invalid_membership_input" }, { status: 400 });
    return Response.json({ data: await createMembership(actor, body) }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "membership_rejected" }, { status: error.status });
    throw error;
  }
}

function isCreateInput(value: unknown): value is { externalSubject: string; displayName: string; role: ActorRole } {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return typeof input.externalSubject === "string" && input.externalSubject.trim().length > 0 && input.externalSubject.length <= 500
    && typeof input.displayName === "string" && input.displayName.trim().length > 0 && input.displayName.length <= 200
    && typeof input.role === "string" && roles.has(input.role as ActorRole);
}
