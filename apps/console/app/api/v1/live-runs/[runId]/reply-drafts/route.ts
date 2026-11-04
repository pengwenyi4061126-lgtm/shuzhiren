import { createChannelReplyDraft, listChannelReplyDrafts } from "@/lib/channel-replies";
import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/reply-drafts">) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
  const { runId } = await context.params;
  return Response.json({ data: await listChannelReplyDrafts(actor, runId) });
}

export async function POST(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/reply-drafts">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const body = await readBoundedJson(request);
    if (!isDraftInput(body)) return Response.json({ error: "invalid_channel_reply_draft" }, { status: 400 });
    const { runId } = await context.params;
    return Response.json({ data: await createChannelReplyDraft(actor, runId, body.interactionId, body) }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "channel_reply_rejected" }, { status: error.status });
    throw error;
  }
}

function isDraftInput(value: unknown): value is { interactionId: string; body: string; channelConnectionId?: string } {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return typeof input.interactionId === "string" && input.interactionId.length > 0
    && typeof input.body === "string" && input.body.trim().length > 0 && input.body.length <= 1000
    && (input.channelConnectionId === undefined || (typeof input.channelConnectionId === "string" && input.channelConnectionId.length > 0))
    && Object.keys(input).every((key) => ["interactionId", "body", "channelConnectionId"].includes(key));
}
