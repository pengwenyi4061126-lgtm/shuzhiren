import { createHash } from "node:crypto";
import { channelVerificationStatus, getChannelConnection } from "@/lib/channels";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";
import { createChannelInteraction } from "@/lib/interactions";
import { isControlledPolicyQuestion } from "@/lib/policy-engine";
import { readBoundedJson } from "@/lib/bounded-json";
import { requireChannelIngestService } from "@/lib/runtime-service-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request);
    if (!isChannelInteraction(body)) return Response.json({ error: "invalid_channel_interaction" }, { status: 400 });
    requireChannelIngestService(request, body.tenantId);

    const context: RequestContext = { tenantId: body.tenantId, actorId: "channel-ingest-service", actorName: "渠道接入服务", role: "operator" };
    const [run, channel] = await Promise.all([getRun(context, body.runId), getChannelConnection(context, body.channelConnectionId)]);
    if (!run || !channel) return Response.json({ error: "channel_or_live_run_not_found" }, { status: 404 });
    if (run.channelConnectionId !== channel.id) return Response.json({ error: "channel_not_bound_to_live_run" }, { status: 409 });
    if (run.state !== "LIVE" && run.state !== "DEGRADED") return Response.json({ error: "live_run_not_accepting_interactions" }, { status: 409 });
    if (!channelVerificationStatus(channel).active || !channel.capability.supportsWebhook || !channel.capability.supportsComments) return Response.json({ error: "channel_not_enabled_for_interactions" }, { status: 409 });

    const interactionKind = body.interactionKind ?? "comment";
    const interaction = await createChannelInteraction(context, {
      runId: run.id,
      question: interactionKind === "comment" ? body.question!.trim() : viewerEventText[interactionKind],
      source: `channel:${channel.provider}:${channel.id}`,
      externalEventId: body.eventId,
      evidenceIds: [],
      channelConnectionId: channel.id,
      interactionKind,
      // The platform viewer id is kept only as a per-channel hash, for the interaction rules' viewer cooldown.
      viewerRef: body.viewerId ? createHash("sha256").update(`${channel.id}:${body.viewerId}`).digest("hex") : undefined,
      viewerNickname: body.viewerNickname,
      giftValueCents: body.giftValueCents
    });
    return Response.json({ data: interaction }, { status: interaction.duplicate ? 200 : 202 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "channel_interaction_rejected" }, { status: error.status });
    throw error;
  }
}

type ViewerEventKind = "viewer_enter" | "follow" | "gift";
type ChannelInteractionBody = { tenantId: string; runId: string; channelConnectionId: string; eventId: string; question?: string; interactionKind?: "comment" | ViewerEventKind; viewerId?: string; viewerNickname?: string; giftValueCents?: number };
// Stored as question_text of a viewer event, which has no viewer text of its own.
const viewerEventText: Record<ViewerEventKind, string> = { viewer_enter: "观众进入直播间", follow: "观众关注了直播间", gift: "观众送出礼物" };

function isChannelInteraction(value: unknown): value is ChannelInteractionBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  const kind = body.interactionKind ?? "comment";
  if (!["comment", "viewer_enter", "follow", "gift"].includes(kind as string)) return false;
  return ["tenantId", "runId", "channelConnectionId", "eventId"].every((key) => typeof body[key] === "string" && body[key].length > 0 && body[key].length <= 200)
    && (kind === "comment" ? typeof body.question === "string" && isControlledPolicyQuestion(body.question) : body.question === undefined)
    && (body.viewerId === undefined || (typeof body.viewerId === "string" && body.viewerId.trim().length > 0 && body.viewerId.length <= 200))
    && (body.viewerNickname === undefined || (typeof body.viewerNickname === "string" && body.viewerNickname.trim().length > 0 && body.viewerNickname.length <= 64))
    && (kind === "gift" ? Number.isSafeInteger(body.giftValueCents) && (body.giftValueCents as number) >= 0 && (body.giftValueCents as number) <= 1_000_000_000_000 : body.giftValueCents === undefined);
}
