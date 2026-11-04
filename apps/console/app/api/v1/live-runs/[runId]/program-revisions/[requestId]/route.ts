import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { replaceProgramRevisionRequest } from "@/lib/show-program-revisions";
import type { ProgramSegmentInput } from "@/lib/show-program";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/program-revisions/[requestId]">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const body = await readBoundedJson(request);
    if (!isProgramInput(body)) return Response.json({ error: "invalid_show_program" }, { status: 400 });
    const { runId, requestId } = await context.params;
    return Response.json({ data: await replaceProgramRevisionRequest(actor, runId, requestId, body.segments) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "program_revision_rejected" }, { status: error.status });
    throw error;
  }
}

function isProgramInput(value: unknown): value is { segments: ProgramSegmentInput[] } {
  if (!value || typeof value !== "object" || !Array.isArray((value as { segments?: unknown }).segments)) return false;
  return (value as { segments: unknown[] }).segments.every((segment) => Boolean(segment) && typeof segment === "object" && typeof (segment as Record<string, unknown>).kind === "string" && typeof (segment as Record<string, unknown>).title === "string" && typeof (segment as Record<string, unknown>).purpose === "string" && typeof (segment as Record<string, unknown>).durationSeconds === "number");
}
