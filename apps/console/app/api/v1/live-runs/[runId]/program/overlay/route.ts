import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getOverlayConfig, replaceOverlayConfig } from "@/lib/overlay-scene";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/program/overlay">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
    const { runId } = await context.params;
    return Response.json({ data: await getOverlayConfig(actor, runId) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "overlay_config_rejected" }, { status: error.status });
    throw error;
  }
}

export async function PUT(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/program/overlay">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const body = await readBoundedJson(request);
    const { runId } = await context.params;
    return Response.json({ data: await replaceOverlayConfig(actor, runId, body) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "overlay_config_rejected" }, { status: error.status });
    throw error;
  }
}
