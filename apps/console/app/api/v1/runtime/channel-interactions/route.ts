import { getChannelConnection } from "@/lib/channels";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";
import { createChannelInteraction } from "@/lib/interactions";
import { isControlledPolicyQuestion } from "@/lib/policy-engine";
import { requireChannelIngestService } from "@/lib/runtime-service-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!isChannelInteraction(body)) return Response.json({ error: "invalid_channel_interaction" }, { status: 400 });
    requireChannelIngestService(request, body.tenantId);

    const context: RequestContext = { tenantId: body.tenantId, actorId: "channel-ingest-service", actorName: "渠道接入服务", role: "operator" };
    const [run, channel] = await Promise.all([getRun(context, body.runId), getChannelConnection(context, body.channelConnectionId)]);
    if (!run || !channel) return Response.json({ error: "channel_or_live_run_not_found" }, { status: 404 });
    if (run.channelConnectionId !== channel.id) return Response.json({ error: "channel_not_bound_to_live_run" }, { status: 409 });
    if (run.state !== "LIVE" && run.state !== "DEGRADED") return Response.json({ error: "live_run_not_accepting_interactions" }, { status: 409 });
    if (channel.status !== "connected" || !channel.capability.supportsWebhook || !channel.capability.supportsComments) return Response.json({ error: "channel_not_enabled_for_interactions" }, { status: 409 });

    const interaction = await createChannelInteraction(context, {
      runId: run.id,
      question: body.question.trim(),
      source: `channel:${channel.provider}:${channel.id}`,
      externalEventId: body.eventId,
      evidenceIds: [],
      channelConnectionId: channel.id
    });
    return Response.json({ data: interaction }, { status: interaction.duplicate ? 200 : 202 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "channel_interaction_rejected" }, { status: error.status });
    throw error;
  }
}

type ChannelInteractionBody = { tenantId: string; runId: string; channelConnectionId: string; eventId: string; question: string };

function isChannelInteraction(value: unknown): value is ChannelInteractionBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return ["tenantId", "runId", "channelConnectionId", "eventId"].every((key) => typeof body[key] === "string" && body[key].length > 0 && body[key].length <= 200)
    && typeof body.question === "string" && isControlledPolicyQuestion(body.question);
}
