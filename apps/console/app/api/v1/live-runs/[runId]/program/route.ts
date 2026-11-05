import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getShowProgram, replaceShowProgram, type ProgramSegmentInput } from "@/lib/show-program";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/program">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
    const { runId } = await context.params;
    const program = await getShowProgram(actor, runId);
    return program ? Response.json({ data: program }) : Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "show_program_rejected" }, { status: error.status });
    throw error;
  }
}

export async function PUT(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/program">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    let body: unknown;
    try { body = await readBoundedJson(request); }
    catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
    if (!isProgramInput(body)) return Response.json({ error: "invalid_show_program" }, { status: 400 });
    const { runId } = await context.params;
    const program = await replaceShowProgram(actor, runId, body.segments);
    return program ? Response.json({ data: program }) : Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "show_program_conflict" }, { status: error.status });
    throw error;
  }
}

function isProgramInput(value: unknown): value is { segments: ProgramSegmentInput[] } {
  if (!value || typeof value !== "object" || !Array.isArray((value as { segments?: unknown }).segments)) return false;
  return (value as { segments: unknown[] }).segments.every((segment) => Boolean(segment) && typeof segment === "object" && typeof (segment as Record<string, unknown>).kind === "string" && typeof (segment as Record<string, unknown>).title === "string" && typeof (segment as Record<string, unknown>).purpose === "string" && typeof (segment as Record<string, unknown>).durationSeconds === "number");
}
