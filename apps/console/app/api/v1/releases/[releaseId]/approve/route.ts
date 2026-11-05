import { recordAuditEvent } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { approveModelRelease } from "@/lib/releases";

export const dynamic = "force-dynamic";
export async function POST(request: Request, context: RouteContext<"/api/v1/releases/[releaseId]/approve">) {
  try {
    const actor = await requestContextFrom(request); requireRole(actor, ["admin", "reviewer"]); const { releaseId } = await context.params;
    const release = await approveModelRelease(actor, releaseId); await recordAuditEvent(actor, { type: "model_release.approved", resource: "model_release", resourceId: release.id, detail: { component: release.component, version: release.version } }); return Response.json({ data: release });
  } catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText }, { status: error.status }); throw error; }
}
