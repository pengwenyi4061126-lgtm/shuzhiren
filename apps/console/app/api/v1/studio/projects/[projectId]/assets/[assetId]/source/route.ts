import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getProjectPhotoSource } from "@/lib/project-photo-source";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; assetId: string }> }) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "reviewer", "analyst"]);
    const { projectId, assetId } = await params;
    return await getProjectPhotoSource(context, projectId, assetId);
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "project_photo_source_rejected" }, { status: error.status, headers: { "cache-control": "no-store" } });
    throw error;
  }
}
