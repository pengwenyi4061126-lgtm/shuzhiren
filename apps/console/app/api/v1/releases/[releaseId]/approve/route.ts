import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { approveModelRelease } from "@/lib/releases";

export const dynamic = "force-dynamic";
export async function POST(request: Request, context: RouteContext<"/api/v1/releases/[releaseId]/approve">) {
  try {
    const actor = await requestContextFrom(request); requireRole(actor, ["admin", "reviewer"]); const { releaseId } = await context.params;
    // approveModelRelease writes model_release.approved in the approval's transaction.
    const release = await approveModelRelease(actor, releaseId); return Response.json({ data: release });
  } catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "model_release_rejected" }, { status: error.status }); throw error; }
}
