import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { isProjectRecordingInput, listProjectRecordings, registerProjectRecording } from "@/lib/project-recordings";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "reviewer", "analyst"]);
    const { projectId } = await params;
    return Response.json({ data: await listProjectRecordings(context, projectId) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "project_recordings_rejected" }, { status: error.status });
    throw error;
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator"]);
    let body: unknown;
    try { body = await readBoundedJson(request); }
    catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
    if (!isProjectRecordingInput(body)) return Response.json({ error: "invalid_project_recording" }, { status: 400 });
    const { projectId } = await params;
    const recording = await registerProjectRecording(context, projectId, body);
    return Response.json({ data: recording }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "project_recording_registration_failed" }, { status: error.status });
    throw error;
  }
}
