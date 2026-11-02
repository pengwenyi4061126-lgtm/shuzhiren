import { recordAuditEvent } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createLiveRun, listRuns } from "@/lib/control-plane/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
  return Response.json({ data: await listRuns(actor) });
}

export async function POST(request: Request) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator"]);
  const body: unknown = await request.json().catch(() => null);
  if (!isInput(body)) return Response.json({ error: "invalid_live_run" }, { status: 400 });
  try {
    const run = await createLiveRun(actor, body);
    await recordAuditEvent(actor, { type: "live_run.created", resource: "live_run", resourceId: run.id, detail: { scheduledAt: run.scheduledAt ?? null, channelConnectionId: body.channelConnectionId, productVersionId: body.productVersionId } });
    return Response.json({ data: run }, { status: 201 });
  } catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "live_run_conflict" }, { status: error.status }); throw error; }
}

function isInput(value: unknown): value is { showName: string; scheduledAt?: string; channelConnectionId: string; productVersionId: string; runtimeSessionId?: string; aiDisclosureEnabled: boolean } {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.showName === "string" && item.showName.trim().length > 0 && item.showName.length <= 200 && typeof item.channelConnectionId === "string" && typeof item.productVersionId === "string" && typeof item.aiDisclosureEnabled === "boolean" && (item.runtimeSessionId === undefined || typeof item.runtimeSessionId === "string") && (item.scheduledAt === undefined || (typeof item.scheduledAt === "string" && !Number.isNaN(Date.parse(item.scheduledAt))));
}
