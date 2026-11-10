import { readBoundedJson } from "@/lib/bounded-json";
import { createAvatarBuildJob, isAvatarBuildJobInput, listAvatarBuildJobs } from "@/lib/avatar-build-jobs";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "reviewer", "analyst"]);
    const { projectId } = await params;
    return Response.json({ data: await listAvatarBuildJobs(context, projectId) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "avatar_build_jobs_rejected" }, { status: error.status });
    throw error;
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator"]);
    let body: unknown;
    try { body = await readBoundedJson(request, 8 * 1024); }
    catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
    if (!isAvatarBuildJobInput(body)) return Response.json({ error: "avatar_build_input_invalid" }, { status: 400 });
    const { projectId } = await params;
    return Response.json({ data: await createAvatarBuildJob(context, projectId, body.sourceAssetId) }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "avatar_build_queue_rejected" }, { status: error.status });
    throw error;
  }
}