import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createProjectRecordingDownloadGrant } from "@/lib/project-recordings";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; recordingId: string }> }) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "reviewer", "analyst"]);
    const { projectId, recordingId } = await params;
    const data = await createProjectRecordingDownloadGrant(context, projectId, recordingId);
    return Response.json({ data }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "project_recording_download_rejected" }, { status: error.status });
    throw error;
  }
}
