import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createProjectRecordingPreviewGrant } from "@/lib/project-recordings";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; recordingId: string }> }) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "reviewer", "analyst"]);
    const { projectId, recordingId } = await params;
    return Response.json({ data: await createProjectRecordingPreviewGrant(context, projectId, recordingId) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "project_recording_preview_rejected" }, { status: error.status, headers: { "cache-control": "no-store" } });
    throw error;
  }
}
