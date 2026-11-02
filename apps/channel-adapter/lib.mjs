import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const eventTypes = new Set(["view", "product_click", "add_to_cart", "order_paid", "refund"]);

export function parseTargets(value) {
  const parsed = JSON.parse(value ?? "[]");
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("CHANNEL_ADAPTER_TARGETS must contain at least one target");
  const byChannel = new Map();
  for (const item of parsed) {
    if (!item || typeof item !== "object") throw new Error("Invalid channel adapter target");
    const { tenantId, channelConnectionId, signingSecret, interactionToken, commerceToken } = item;
    if (![tenantId, channelConnectionId, signingSecret, interactionToken, commerceToken].every((entry) => typeof entry === "string" && entry.length >= 16)) throw new Error("Each channel adapter target requires tenantId, channelConnectionId and distinct secrets");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(channelConnectionId)) throw new Error("Channel adapter target IDs must be UUIDs");
    if (new Set([signingSecret, interactionToken, commerceToken]).size !== 3) throw new Error("Channel adapter signing, interaction, and commerce secrets must differ");
    if (byChannel.has(channelConnectionId)) throw new Error(`Duplicate channelConnectionId: ${channelConnectionId}`);
    byChannel.set(channelConnectionId, { tenantId, channelConnectionId, signingSecret, interactionToken, commerceToken });
  }
  return byChannel;
}

export function payloadSha256(rawBody) { return createHash("sha256").update(rawBody).digest("hex"); }

export function verifyWebhook({ rawBody, timestamp, signature, secret, now = Date.now(), maxAgeMs = 5 * 60_000 }) {
  if (!/^\d{10,16}$/.test(timestamp ?? "")) return false;
  const timestampMs = Number(timestamp) * (timestamp.length <= 10 ? 1000 : 1);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > maxAgeMs) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const supplied = Buffer.from(signature ?? "");
  const expectedBuffer = Buffer.from(expected);
  return supplied.length === expectedBuffer.length && timingSafeEqual(supplied, expectedBuffer);
}

export function parseNormalizedEvent(value) {
  if (!value || typeof value !== "object") throw new Error("Webhook body must be a JSON object");
  const event = value;
  if (typeof event.runId !== "string" || !event.runId || event.runId.length > 200) throw new Error("runId is required");
  if (event.kind === "interaction") {
    if (typeof event.question !== "string" || !event.question.trim() || event.question.length > 1000) throw new Error("interaction question is required");
    return { kind: "interaction", runId: event.runId, question: event.question.trim() };
  }
  if (event.kind === "commerce") {
    if (!eventTypes.has(event.eventType)) throw new Error("Unsupported commerce event type");
    if (event.occurredAt !== undefined && (typeof event.occurredAt !== "string" || Number.isNaN(Date.parse(event.occurredAt)))) throw new Error("Invalid occurredAt");
    if (event.orderReference !== undefined && (typeof event.orderReference !== "string" || event.orderReference.length > 200)) throw new Error("Invalid orderReference");
    const amountCents = event.amountCents ?? 0;
    if (!Number.isSafeInteger(amountCents) || amountCents < 0 || amountCents > 1_000_000_000_000) throw new Error("Invalid amountCents");
    if (["order_paid", "refund"].includes(event.eventType) ? amountCents <= 0 : amountCents !== 0) throw new Error("Amount does not match commerce event type");
    return { kind: "commerce", runId: event.runId, eventType: event.eventType, occurredAt: event.occurredAt, orderReference: event.orderReference, amountCents };
  }
  throw new Error("Unsupported webhook kind");
}
