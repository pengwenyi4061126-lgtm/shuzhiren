import { channelVerificationStatus, getChannelConnection } from "@/lib/channels";
import { readBoundedJson } from "@/lib/bounded-json";
import { commerceEventTypes, createChannelCommerceEvent, type CommerceEventType } from "@/lib/commerce";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";
import { requireChannelCommerceService } from "@/lib/runtime-service-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request);
    if (!isChannelCommerceEvent(body)) return Response.json({ error: "invalid_channel_commerce_event" }, { status: 400 });
    requireChannelCommerceService(request, body.tenantId);
    const context: RequestContext = { tenantId: body.tenantId, actorId: "channel-commerce-service", actorName: "渠道交易接入服务", role: "operator" };
    const [run, channel] = await Promise.all([getRun(context, body.runId), getChannelConnection(context, body.channelConnectionId)]);
    if (!run || !channel) return Response.json({ error: "channel_or_live_run_not_found" }, { status: 404 });
    if (run.channelConnectionId !== channel.id) return Response.json({ error: "channel_not_bound_to_live_run" }, { status: 409 });
    if (!["LIVE", "DEGRADED", "ENDED"].includes(run.state)) return Response.json({ error: "live_run_not_accepting_commerce_events" }, { status: 409 });
    if (!channelVerificationStatus(channel).active || !channel.capability.supportsWebhook) return Response.json({ error: "channel_not_enabled_for_commerce_events" }, { status: 409 });
    const event = await createChannelCommerceEvent(context, { runId: run.id, channelConnectionId: channel.id, externalEventId: body.eventId, eventType: body.eventType, occurredAt: body.occurredAt, orderReference: body.orderReference, amountCents: body.amountCents, quantity: body.quantity });
    return Response.json({ data: event }, { status: event.duplicate ? 200 : 202 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "channel_commerce_rejected" }, { status: error.status });
    throw error;
  }
}

type ChannelCommerceBody = { tenantId: string; runId: string; channelConnectionId: string; eventId: string; eventType: CommerceEventType; occurredAt?: string; orderReference?: string; amountCents?: number; quantity?: number };

function isChannelCommerceEvent(value: unknown): value is ChannelCommerceBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  const requiredStrings = ["tenantId", "runId", "channelConnectionId", "eventId"];
  if (!requiredStrings.every((key) => typeof body[key] === "string" && body[key].trim().length > 0 && body[key].length <= 200)) return false;
  if (!commerceEventTypes.includes(body.eventType as CommerceEventType)) return false;
  if (body.occurredAt !== undefined && (typeof body.occurredAt !== "string" || Number.isNaN(Date.parse(body.occurredAt)))) return false;
  if (body.orderReference !== undefined && (typeof body.orderReference !== "string" || body.orderReference.length > 200)) return false;
  if (body.amountCents !== undefined && (!Number.isSafeInteger(body.amountCents) || (body.amountCents as number) < 0 || (body.amountCents as number) > 1_000_000_000_000)) return false;
  if (body.quantity !== undefined && (!Number.isSafeInteger(body.quantity) || (body.quantity as number) < 0 || (body.quantity as number) > 100000)) return false;
  const amount = (body.amountCents as number | undefined) ?? 0;
  const quantity = (body.quantity as number | undefined) ?? (body.eventType === "order_paid" ? 1 : 0);
  if (["order_paid", "refund"].includes(body.eventType as string)) return amount > 0 && (body.eventType !== "order_paid" || quantity > 0);
  return amount === 0;
}
