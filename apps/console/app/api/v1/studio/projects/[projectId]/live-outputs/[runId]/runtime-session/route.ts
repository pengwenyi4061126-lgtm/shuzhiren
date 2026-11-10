import { getAvatarBuildJob } from "@/lib/avatar-build-jobs";
import { readBoundedJson } from "@/lib/bounded-json";
import { listCreationProjects } from "@/lib/creation-projects";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { bindRuntimeSession, canBindRuntimeSession, getRun } from "@/lib/control-plane/store";
import { createRuntimeAvatarOffer, observeRuntimeSession } from "@/lib/runtime-gateway";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/studio/projects/[projectId]/live-outputs/[runId]/runtime-session">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    let body: unknown;
    try { body = await readBoundedJson(request, 300_000); }
    catch (error) { if (error instanceof Response) return Response.json({ error: "offer_too_large" }, { status: error.status }); throw error; }
    if (!body || typeof body !== "object" || (body as Record<string, unknown>).type !== "offer" || typeof (body as Record<string, unknown>).sdp !== "string" || !(body as Record<string, string>).sdp || (body as Record<string, string>).sdp.length > 262144) return Response.json({ error: "invalid_runtime_offer" }, { status: 400 });
    const { projectId, runId } = await context.params;
    const project = (await listCreationProjects(actor)).find((item) => item.id === projectId);
    if (!project) return Response.json({ error: "not_found" }, { status: 404 });
    const avatarBuildJobId = project.liveOutputAvatarBuildJobs[runId];
    const outputRevision = project.liveOutputRevisions[runId];
    if (!project.liveRunIds.includes(runId) || !avatarBuildJobId || !outputRevision) return Response.json({ error: "live_output_not_ready" }, { status: 409 });
    const job = await getAvatarBuildJob(actor, projectId, avatarBuildJobId);
    if (!job || job.projectRevision !== outputRevision || job.status !== "preview_ready" || job.reviewStatus !== "approved" || job.publishStatus !== "published" || !job.runtimeAvatarId) return Response.json({ error: "avatar_selection_not_ready" }, { status: 409 });
    const run = await getRun(actor, runId);
    if (!run) return Response.json({ error: "not_found" }, { status: 404 });
    if (!canBindRuntimeSession(run.state)) return Response.json({ error: "runtime_session_locked_after_arming" }, { status: 409 });
    if (run.runtimeSessionId) {
      try {
        const observation = await observeRuntimeSession(run.runtimeSessionId);
        if (observation.session.active) return Response.json({ error: "runtime_session_already_bound" }, { status: 409 });
      } catch {
        return Response.json({ error: "runtime_session_verification_failed" }, { status: 502 });
      }
    }
    const answer = await createRuntimeAvatarOffer((body as { sdp: string }).sdp, job.runtimeAvatarId);
    const boundRun = await bindRuntimeSession(actor, runId, answer.sessionId);
    return Response.json({ data: { ...answer, runId: boundRun.id } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "runtime_session_rejected" }, { status: error.status });
    if (error && typeof error === "object" && "status" in error && "code" in error) {
      const gatewayError = error as { status: number; code: string; message: string };
      return Response.json({ error: gatewayError.status === 409 ? "runtime_preview_capacity_occupied" : gatewayError.code, detail: gatewayError.message }, { status: gatewayError.status });
    }
    throw error;
  }
}
