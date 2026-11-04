import { retryChannelReplyDraft } from "@/lib/channel-replies";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/reply-drafts/[draftId]/retry">) {
  try { const actor = await requestContextFrom(request); requireRole(actor, ["admin", "operator"]); const { runId, draftId } = await context.params; return Response.json({ data: await retryChannelReplyDraft(actor, runId, draftId) }); }
  catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "channel_reply_rejected" }, { status: error.status }); throw error; }
}
