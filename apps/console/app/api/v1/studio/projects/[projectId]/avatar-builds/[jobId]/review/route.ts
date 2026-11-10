import { readBoundedJson } from "@/lib/bounded-json";
import { reviewAvatarBuildJob } from "@/lib/avatar-build-jobs";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string; jobId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "reviewer"]);
    let body: unknown;
    try { body = await readBoundedJson(request, 4 * 1024); }
    catch (error) { if (error instanceof Response) return Response.json({ error: "avatar_review_input_invalid" }, { status: error.status }); throw error; }
    if (!isReviewInput(body)) return Response.json({ error: "avatar_review_input_invalid" }, { status: 400 });
    const { projectId, jobId } = await params;
    const job = await reviewAvatarBuildJob(context, projectId, jobId, body.decision, body.note);
    return Response.json({ data: job }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "avatar_review_rejected" }, { status: error.status, headers: { "cache-control": "no-store" } });
    throw error;
  }
}

function isReviewInput(value: unknown): value is { decision: "approved" | "rejected"; note?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (input.decision === "approved" || input.decision === "rejected")
    && Object.keys(input).every((key) => key === "decision" || key === "note")
    && (input.note === undefined || (typeof input.note === "string" && input.note.trim().length >= 1 && input.note.trim().length <= 1000));
}
