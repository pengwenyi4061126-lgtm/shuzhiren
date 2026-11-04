import { enqueueChannelReplyDelivery } from "@/lib/channel-replies";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/reply-drafts/[draftId]/send">) {
  try { const actor = await requestContextFrom(request); requireRole(actor, ["admin", "operator"]); const { runId, draftId } = await context.params; const result = await enqueueChannelReplyDelivery(actor, runId, draftId); return Response.json({ data: result.draft, meta: { outboxEventId: result.outboxEventId } }, { status: 202 }); }
  catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "channel_reply_rejected" }, { status: error.status }); throw error; }
}
