// Webhook delivery to the Control_Plane under a replay lease. Independent of environment variables so that the
// lease handling can be tested with an injected store and forwarder.

export const FORWARD_TIMEOUT_MS = 8_000;

/** Builds the downstream path, bearer token and explicit request body for a verified, parsed event. */
export function controlPlaneRequest({ target, eventId, event }) {
  if (event.kind === "interaction") {
    return { path: "/api/v1/runtime/channel-interactions", token: target.interactionToken, body: { tenantId: target.tenantId, channelConnectionId: target.channelConnectionId, eventId, runId: event.runId, question: event.question } };
  }
  return { path: "/api/v1/runtime/channel-commerce", token: target.commerceToken, body: { tenantId: target.tenantId, channelConnectionId: target.channelConnectionId, eventId, runId: event.runId, eventType: event.eventType, occurredAt: event.occurredAt, orderReference: event.orderReference, amountCents: event.amountCents, quantity: event.quantity } };
}

/** @returns {Promise<{ok:true}|{ok:false,kind:"rejected",status:number}|{ok:false,kind:"network"}|{ok:false,kind:"timeout"}>} */
export async function forwardToControlPlane({ url, token, body, timeoutMs = FORWARD_TIMEOUT_MS, fetchImpl = fetch, signal }) {
  let response;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
  } catch (error) {
    return { ok: false, kind: error?.name === "TimeoutError" ? "timeout" : "network" };
  }
  await response.body?.cancel().catch(() => undefined);
  return response.ok ? { ok: true } : { ok: false, kind: "rejected", status: response.status };
}

/**
 * Returns `processWebhook({ target, eventId, payloadSha256, event })`, which resolves to `{ status, headers?, body }`.
 * The platform only receives a 2xx after the Control_Plane accepted the event (202) or after the event was
 * already recorded as delivered (200). Every failed forward releases the lease it claimed so that the
 * platform's retry is forwarded again instead of waiting for the lease to expire.
 */
export function createWebhookProcessor({ store, forward, allowRequest, log = defaultLog }) {
  async function releaseLease(target, eventId, leaseToken) {
    try {
      await store.release(target, eventId, leaseToken);
    } catch (error) {
      log("channel-adapter.release_failed", { channelConnectionId: target.channelConnectionId, eventId, error: errorName(error) });
    }
  }

  return async function processWebhook({ target, eventId, payloadSha256, event }) {
    const replay = await store.reserve(target, eventId, payloadSha256);
    if (replay.kind === "delivered") return { status: 200, body: { accepted: true, duplicate: true } };
    if (replay.kind === "processing") {
      const retryAfterSeconds = Math.max(1, Math.ceil(Number(replay.retryAfterSeconds) || 1));
      return { status: 503, headers: { "retry-after": String(retryAfterSeconds) }, body: { error: "event_processing", retryAfterSeconds } };
    }
    if (replay.kind !== "claimed") throw new Error("webhook_replay_conflict_unresolved");
    if (!allowRequest(target.channelConnectionId)) {
      await releaseLease(target, eventId, replay.leaseToken);
      return { status: 429, body: { error: "channel_rate_limited" } };
    }
    let result;
    try {
      result = await forward({ target, eventId, event });
    } catch (error) {
      await releaseLease(target, eventId, replay.leaseToken);
      throw error;
    }
    if (result?.ok === true) {
      try {
        await store.markDelivered(target, eventId);
      } catch (error) {
        // The Control_Plane already accepted the event; its event-id idempotency absorbs a later re-forward.
        log("channel-adapter.mark_delivered_failed", { channelConnectionId: target.channelConnectionId, eventId, error: errorName(error) });
      }
      return { status: 202, body: { accepted: true, duplicate: false } };
    }
    await releaseLease(target, eventId, replay.leaseToken);
    if (result?.kind === "rejected") return { status: 502, body: { error: "control_plane_rejected", status: result.status } };
    if (result?.kind === "timeout") return { status: 504, body: { error: "control_plane_timeout" } };
    return { status: 502, body: { error: "control_plane_unreachable" } };
  };
}

function errorName(error) { return error instanceof Error ? error.name : "unknown_error"; }
function defaultLog(event, fields) { console.error(event, fields); }
