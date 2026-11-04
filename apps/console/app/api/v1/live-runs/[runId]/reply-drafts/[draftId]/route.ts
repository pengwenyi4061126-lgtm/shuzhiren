import { updateChannelReplyDraft } from "@/lib/channel-replies";
import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/reply-drafts/[draftId]">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const body = await readBoundedJson(request);
    if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).body !== "string") return Response.json({ error: "invalid_channel_reply_body" }, { status: 400 });
    const { runId, draftId } = await context.params;
    return Response.json({ data: await updateChannelReplyDraft(actor, runId, draftId, (body as { body: string }).body) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "channel_reply_rejected" }, { status: error.status });
    throw error;
  }
}
