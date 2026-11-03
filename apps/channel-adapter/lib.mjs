import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const eventTypes = new Set(["view", "product_click", "add_to_cart", "order_paid", "refund"]);

export function parseControlPlaneUrl(value) {
  if (!value) throw new Error("CONTROL_PLANE_URL is required");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CONTROL_PLANE_URL must be an HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("CONTROL_PLANE_URL must be an HTTP(S) URL");
  if (url.username || url.password) throw new Error("CONTROL_PLANE_URL must not contain embedded credentials");
  return url;
}

export function parseTargets(value) {
  const parsed = JSON.parse(value ?? "[]");
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("CHANNEL_ADAPTER_TARGETS must contain at least one target");
  const byChannel = new Map();
  for (const item of parsed) {
    if (!item || typeof item !== "object") throw new Error("Invalid channel adapter target");
    const { tenantId, channelConnectionId, signingSecret, interactionToken, commerceToken } = item;
    if (![tenantId, channelConnectionId, signingSecret, interactionToken, commerceToken].every((entry) => typeof entry === "string" && entry.length >= 32 && !/\s/.test(entry))) throw new Error("Each channel adapter target requires tenantId, channelConnectionId and distinct 32-character secrets without whitespace");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(channelConnectionId)) throw new Error("Channel adapter target IDs must be UUIDs");
    if (new Set([signingSecret, interactionToken, commerceToken]).size !== 3) throw new Error("Channel adapter signing, interaction, and commerce secrets must differ");
    if (byChannel.has(channelConnectionId)) throw new Error(`Duplicate channelConnectionId: ${channelConnectionId}`);
    byChannel.set(channelConnectionId, { tenantId, channelConnectionId, signingSecret, interactionToken, commerceToken });
  }
  return byChannel;
}

export function payloadSha256(rawBody) { return createHash("sha256").update(rawBody).digest("hex"); }

export function publicRequestError(error) {
  const message = error instanceof Error ? error.message : "";
  if (message === "webhook_body_too_large") return { status: 413, error: "webhook_body_too_large" };
  if (message === "event_id_reused_with_different_payload") return { status: 409, error: "event_id_conflict" };
  if (message === "webhook_replay_conflict_unresolved") return { status: 503, error: "webhook_replay_unavailable" };
  if (error instanceof SyntaxError || message.startsWith("Invalid") || message.includes("required") || message.includes("Unsupported") || message.startsWith("Amount") || message.startsWith("Paid order")) return { status: 400, error: "invalid_webhook_payload" };
  return { status: 500, error: "webhook_processing_failed" };
}

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
    const quantity = event.quantity ?? (event.eventType === "order_paid" ? 1 : 0);
    if (!Number.isSafeInteger(amountCents) || amountCents < 0 || amountCents > 1_000_000_000_000) throw new Error("Invalid amountCents");
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 100000) throw new Error("Invalid quantity");
    if (["order_paid", "refund"].includes(event.eventType) ? amountCents <= 0 : amountCents !== 0) throw new Error("Amount does not match commerce event type");
    if (event.eventType === "order_paid" && quantity === 0) throw new Error("Paid order quantity must be positive");
    return { kind: "commerce", runId: event.runId, eventType: event.eventType, occurredAt: event.occurredAt, orderReference: event.orderReference, amountCents, quantity };
  }
  throw new Error("Unsupported webhook kind");
}
