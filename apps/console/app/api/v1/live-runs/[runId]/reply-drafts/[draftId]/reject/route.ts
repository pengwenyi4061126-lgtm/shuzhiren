import { rejectChannelReplyDraft } from "@/lib/channel-replies";
import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/reply-drafts/[draftId]/reject">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "reviewer"]);
    const body = await readBoundedJson(request);
    if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).reason !== "string") return Response.json({ error: "invalid_rejection_reason" }, { status: 400 });
    const { runId, draftId } = await context.params;
    return Response.json({ data: await rejectChannelReplyDraft(actor, runId, draftId, (body as { reason: string }).reason) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "channel_reply_rejected" }, { status: error.status });
    throw error;
  }
}
