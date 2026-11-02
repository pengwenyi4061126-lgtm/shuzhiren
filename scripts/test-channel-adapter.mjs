import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { parseNormalizedEvent, parseTargets, payloadSha256, verifyWebhook } from "../apps/channel-adapter/lib.mjs";

const secret = "signing-secret-123";
const now = 1_700_000_000_000;
const raw = JSON.stringify({ kind: "interaction", runId: "run_1", question: "现在有赠品吗？" });
const timestamp = String(now);
const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`;

assert.equal(verifyWebhook({ rawBody: raw, timestamp, signature, secret, now }), true);
assert.equal(verifyWebhook({ rawBody: raw, timestamp, signature: `${signature}x`, secret, now }), false);
assert.equal(verifyWebhook({ rawBody: raw, timestamp: String(now - 300_001), signature, secret, now }), false);
assert.equal(payloadSha256(raw).length, 64);

assert.deepEqual(parseNormalizedEvent(JSON.parse(raw)), { kind: "interaction", runId: "run_1", question: "现在有赠品吗？" });
assert.deepEqual(parseNormalizedEvent({ kind: "commerce", runId: "run_1", eventType: "order_paid", amountCents: 9900, orderReference: "order_1" }), { kind: "commerce", runId: "run_1", eventType: "order_paid", occurredAt: undefined, orderReference: "order_1", amountCents: 9900 });
assert.throws(() => parseNormalizedEvent({ kind: "commerce", runId: "run_1", eventType: "view", amountCents: 1 }), /Amount does not match/);
assert.throws(() => parseNormalizedEvent({ kind: "commerce", runId: "run_1", eventType: "order_paid", amountCents: 0 }), /Amount does not match/);

const validTarget = { tenantId: "123e4567-e89b-12d3-a456-426614174000", channelConnectionId: "223e4567-e89b-12d3-a456-426614174000", signingSecret: secret, interactionToken: "interaction-token-123", commerceToken: "commerce-token-1234" };
assert.equal(parseTargets(JSON.stringify([validTarget])).size, 1);
assert.throws(() => parseTargets(JSON.stringify([{ ...validTarget, commerceToken: validTarget.interactionToken }])), /must differ/);
assert.throws(() => parseTargets(JSON.stringify([{ ...validTarget, tenantId: "123e4567-e89b-12d3-c456-426614174000" }])), /must be UUIDs/);

console.log("PASS  channel adapter validates HMAC, replay prerequisites, and normalized event contracts");
