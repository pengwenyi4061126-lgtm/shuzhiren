import { getAvatarBuildPreview } from "@/lib/avatar-build-jobs";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string; jobId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "reviewer", "analyst"]);
    const { projectId, jobId } = await params;
    const preview = await getAvatarBuildPreview(context, projectId, jobId);
    if (!preview) return Response.json({ error: "avatar_preview_not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(new Uint8Array(preview), { headers: { "content-type": "image/jpeg", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "avatar_preview_rejected" }, { status: error.status, headers: { "cache-control": "no-store" } });
    throw error;
  }
}
