import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { parseControlPlaneUrl, parseNormalizedEvent, parseOutboundReply, parseTargets, payloadSha256, publicRequestError, verifyWebhook } from "../apps/channel-adapter/lib.mjs";

const secret = "channel-signing-secret-at-least-32-chars";
const now = 1_700_000_000_000;
const raw = JSON.stringify({ kind: "interaction", runId: "run_1", question: "现在有赠品吗？" });
const timestamp = String(now);
const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`;

assert.equal(verifyWebhook({ rawBody: raw, timestamp, signature, secret, now }), true);
assert.equal(verifyWebhook({ rawBody: raw, timestamp, signature: `${signature}x`, secret, now }), false);
assert.equal(verifyWebhook({ rawBody: raw, timestamp: String(now - 300_001), signature, secret, now }), false);
assert.equal(payloadSha256(raw).length, 64);
assert.equal(parseControlPlaneUrl("https://control-plane.internal").origin, "https://control-plane.internal");
assert.throws(() => parseControlPlaneUrl("ftp://control-plane.internal"), /HTTP\(S\)/);
assert.throws(() => parseControlPlaneUrl("https://operator:password@control-plane.internal"), /embedded credentials/);

assert.deepEqual(parseNormalizedEvent(JSON.parse(raw)), { kind: "interaction", runId: "run_1", question: "现在有赠品吗？" });
assert.deepEqual(parseNormalizedEvent({ kind: "commerce", runId: "run_1", eventType: "order_paid", amountCents: 9900, orderReference: "order_1" }), { kind: "commerce", runId: "run_1", eventType: "order_paid", occurredAt: undefined, orderReference: "order_1", amountCents: 9900, quantity: 1 });
assert.deepEqual(parseNormalizedEvent({ kind: "commerce", runId: "run_1", eventType: "order_paid", amountCents: 19800, quantity: 2 }), { kind: "commerce", runId: "run_1", eventType: "order_paid", occurredAt: undefined, orderReference: undefined, amountCents: 19800, quantity: 2 });
assert.throws(() => parseNormalizedEvent({ kind: "commerce", runId: "run_1", eventType: "view", amountCents: 1 }), /Amount does not match/);
assert.throws(() => parseNormalizedEvent({ kind: "commerce", runId: "run_1", eventType: "order_paid", amountCents: 0 }), /Amount does not match/);
assert.throws(() => parseNormalizedEvent({ kind: "commerce", runId: "run_1", eventType: "order_paid", amountCents: 9900, quantity: 0 }), /Paid order quantity/);

const validTarget = { tenantId: "123e4567-e89b-12d3-a456-426614174000", channelConnectionId: "223e4567-e89b-12d3-a456-426614174000", signingSecret: secret, interactionToken: "interaction-token-at-least-32-chars", commerceToken: "commerce-token-at-least-32-chars", providerReplyEndpoint: "https://provider-bridge.internal/v1/replies", providerReplyToken: "provider-reply-token-at-least-32-chars" };
assert.equal(parseTargets(JSON.stringify([validTarget])).size, 1);
assert.throws(() => parseTargets(JSON.stringify([{ ...validTarget, commerceToken: validTarget.interactionToken }])), /must differ/);
assert.throws(() => parseTargets(JSON.stringify([{ ...validTarget, tenantId: "123e4567-e89b-12d3-c456-426614174000" }])), /must be UUIDs/);
const replyBody = "赠品以平台结算页显示为准。";
assert.deepEqual(parseOutboundReply({ tenantId: validTarget.tenantId, replyId: "323e4567-e89b-12d3-a456-426614174000", runId: "run_1", interactionId: "423e4567-e89b-12d3-a456-426614174000", channelConnectionId: validTarget.channelConnectionId, body: replyBody, bodySha256: payloadSha256(replyBody), idempotencyKey: "channel_reply_323e4567-e89b-12d3-a456-426614174000" }), { tenantId: validTarget.tenantId, replyId: "323e4567-e89b-12d3-a456-426614174000", runId: "run_1", interactionId: "423e4567-e89b-12d3-a456-426614174000", channelConnectionId: validTarget.channelConnectionId, body: replyBody, bodySha256: payloadSha256(replyBody), idempotencyKey: "channel_reply_323e4567-e89b-12d3-a456-426614174000" });
assert.throws(() => parseOutboundReply({ tenantId: validTarget.tenantId, replyId: "323e4567-e89b-12d3-a456-426614174000", runId: "run_1", interactionId: "423e4567-e89b-12d3-a456-426614174000", channelConnectionId: validTarget.channelConnectionId, body: replyBody, bodySha256: "0".repeat(64), idempotencyKey: "channel_reply_323e4567-e89b-12d3-a456-426614174000" }), /body/);

assert.deepEqual(publicRequestError(new Error("webhook_body_too_large")), { status: 413, error: "webhook_body_too_large" });
assert.deepEqual(publicRequestError(new Error("event_id_reused_with_different_payload")), { status: 409, error: "event_id_conflict" });
assert.deepEqual(publicRequestError(new SyntaxError("Unexpected token private-webhook-key")), { status: 400, error: "invalid_webhook_payload" });
assert.deepEqual(publicRequestError(new Error("database failed for postgresql://internal/private-token")), { status: 500, error: "webhook_processing_failed" });

console.log("PASS  channel adapter validates HMAC, replay prerequisites, normalized event contracts, and public error boundaries");
