import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { handleInteraction } from "@/lib/interactions";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/interactions/[interactionId]/handle">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    let body: unknown;
    try { body = await readBoundedJson(request); }
    catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
    if (!isHandleInput(body)) return Response.json({ error: "invalid_resolution" }, { status: 400 });
    const { runId, interactionId } = await context.params;
    // handleInteraction writes interaction.handled in the update's transaction.
    const interaction = await handleInteraction(actor, runId, interactionId, body.resolutionNote);
    return Response.json({ data: interaction });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "interaction_rejected" }, { status: error.status });
    throw error;
  }
}

function isHandleInput(value: unknown): value is { resolutionNote?: string } {
  if (!value || typeof value !== "object") return false;
  const note = (value as Record<string, unknown>).resolutionNote;
  return note === undefined || (typeof note === "string" && note.length <= 1000);
}
