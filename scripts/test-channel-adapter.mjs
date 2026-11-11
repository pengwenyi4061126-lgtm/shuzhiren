import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseControlPlaneUrl, parseNormalizedEvent, parseOutboundReply, parseTargets, payloadSha256, publicRequestError, verifyWebhook } from "../apps/channel-adapter/lib.mjs";
import { channelAdapters, isChannelProvider, supportedChannelProviders } from "../apps/console/lib/channel-adapters.ts";

assert.deepEqual(supportedChannelProviders, ["generic-rtmp", "normalized-webhook-rtmp"], "the provider registry must be explicit and ordered");
assert.equal(isChannelProvider("generic-rtmp"), true);
assert.equal(isChannelProvider("normalized-webhook-rtmp"), true);
assert.equal(isChannelProvider("douyin"), false, "unimplemented platform providers must not enter the production registry");
assert.equal(channelAdapters.get("generic-rtmp")?.capability.supportsOutboundReplies, false);
assert.equal(channelAdapters.get("normalized-webhook-rtmp")?.capability.supportsOutboundReplies, true);
assert.equal(channelAdapters.get("normalized-webhook-rtmp")?.capability.supportsWebhook, true);
assert.deepEqual(channelAdapters.get("normalized-webhook-rtmp")?.validateShow({ resolution: "720p", aiDisclosureEnabled: false }), ["目标渠道要求 AI 标识"]);
assert.equal(channelAdapters.get("normalized-webhook-rtmp")?.supportsOutput("rtmp"), true);
assert.equal(channelAdapters.get("normalized-webhook-rtmp")?.supportsOutput("srt"), false);

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
assert.equal(parseTargets(JSON.stringify([{ ...validTarget, providerReplyEndpoint: "http://127.0.0.1:9090/v1/replies" }])).size, 1);
assert.throws(() => parseTargets(JSON.stringify([{ ...validTarget, providerReplyEndpoint: "http://provider-bridge.internal/v1/replies" }])), /HTTPS URL/);
assert.throws(() => parseTargets(JSON.stringify([{ ...validTarget, providerReplyEndpoint: "https://operator:password@provider-bridge.internal/v1/replies" }])), /embedded credentials/);
const replyBody = "赠品以平台结算页显示为准。";
assert.deepEqual(parseOutboundReply({ tenantId: validTarget.tenantId, replyId: "323e4567-e89b-12d3-a456-426614174000", runId: "run_1", interactionId: "423e4567-e89b-12d3-a456-426614174000", channelConnectionId: validTarget.channelConnectionId, body: replyBody, bodySha256: payloadSha256(replyBody), idempotencyKey: "channel_reply_323e4567-e89b-12d3-a456-426614174000" }), { tenantId: validTarget.tenantId, replyId: "323e4567-e89b-12d3-a456-426614174000", runId: "run_1", interactionId: "423e4567-e89b-12d3-a456-426614174000", channelConnectionId: validTarget.channelConnectionId, body: replyBody, bodySha256: payloadSha256(replyBody), idempotencyKey: "channel_reply_323e4567-e89b-12d3-a456-426614174000" });
assert.throws(() => parseOutboundReply({ tenantId: validTarget.tenantId, replyId: "323e4567-e89b-12d3-a456-426614174000", runId: "run_1", interactionId: "423e4567-e89b-12d3-a456-426614174000", channelConnectionId: validTarget.channelConnectionId, body: replyBody, bodySha256: "0".repeat(64), idempotencyKey: "channel_reply_323e4567-e89b-12d3-a456-426614174000" }), /body/);

assert.deepEqual(publicRequestError(new Error("webhook_body_too_large")), { status: 413, error: "webhook_body_too_large" });
assert.deepEqual(publicRequestError(new Error("event_id_reused_with_different_payload")), { status: 409, error: "event_id_conflict" });
assert.deepEqual(publicRequestError(new SyntaxError("Unexpected token private-webhook-key")), { status: 400, error: "invalid_webhook_payload" });
assert.deepEqual(publicRequestError(new Error("database failed for postgresql://internal/private-token")), { status: 500, error: "webhook_processing_failed" });

console.log("PASS  channel adapter validates HMAC, replay prerequisites, normalized event contracts, and public error boundaries");

// H6 regression, from the process boundary: index.mjs runs with `pg` replaced by the in-memory fixture in
// scripts/fixtures/channel-adapter, and a local HTTP server stands in for the Control_Plane.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adapterEntry = path.join(root, "apps", "channel-adapter", "index.mjs");
const fakePgRegister = pathToFileURL(path.join(root, "scripts", "fixtures", "channel-adapter", "fake-pg-register.mjs")).href;
const controlPlane = await startControlPlane();
const adapterTarget = { ...validTarget, providerReplyEndpoint: "http://127.0.0.1:9/v1/replies" };
const adapter = await startAdapter({ CONTROL_PLANE_URL: controlPlane.url, CHANNEL_ADAPTER_TARGETS: JSON.stringify([adapterTarget]) });
try {
  const paidPayload = (reference) => JSON.stringify({ kind: "commerce", runId: "run_1", eventType: "order_paid", orderReference: reference, amountCents: 9900, quantity: 1 });

  // A non-2xx forward must release the lease so that an immediate platform retry is forwarded again.
  const rejectedPayload = paidPayload("order-rejected-1");
  controlPlane.plan("evt-rejected-1", [respondWith(500), respondWith(202)]);
  const rejected = await postWebhook(adapter.port, "evt-rejected-1", rejectedPayload);
  assert.equal(rejected.status, 502, "a rejected forward must not be acknowledged to the platform");
  assert.deepEqual(rejected.body, { error: "control_plane_rejected", status: 500 });
  const retriedAfterRejection = await postWebhook(adapter.port, "evt-rejected-1", rejectedPayload);
  assert.equal(controlPlane.calls("evt-rejected-1"), 2, "a retry after a rejected forward must be forwarded again within the lease period");
  assert.equal(retriedAfterRejection.status, 202);
  assert.deepEqual(retriedAfterRejection.body, { accepted: true, duplicate: false });
  const delivered = await postWebhook(adapter.port, "evt-rejected-1", rejectedPayload);
  assert.equal(delivered.status, 200, "a delivered event must be acknowledged without forwarding");
  assert.deepEqual(delivered.body, { accepted: true, duplicate: true });
  assert.equal(controlPlane.calls("evt-rejected-1"), 2);

  // A network error must release the lease and be reported as a non-2xx gateway error.
  const networkPayload = paidPayload("order-network-1");
  controlPlane.plan("evt-network-1", [dropConnection, respondWith(202)]);
  const unreachable = await postWebhook(adapter.port, "evt-network-1", networkPayload);
  assert.equal(unreachable.status, 502, "a network error while forwarding must not be acknowledged to the platform");
  assert.deepEqual(unreachable.body, { error: "control_plane_unreachable" });
  const retriedAfterNetworkError = await postWebhook(adapter.port, "evt-network-1", networkPayload);
  assert.equal(controlPlane.calls("evt-network-1"), 2, "a retry after a network error must be forwarded again within the lease period");
  assert.equal(retriedAfterNetworkError.status, 202);

  // While a forward is in flight, other requests for the same event are told to retry later (non-2xx) and
  // are not forwarded; once that forward fails, the next retry claims the lease again.
  const inflightPayload = paidPayload("order-inflight-1");
  const held = deferred();
  controlPlane.plan("evt-inflight-1", [(request, response) => held.resolve(response), respondWith(202)]);
  const firstAttempt = postWebhook(adapter.port, "evt-inflight-1", inflightPayload);
  await controlPlane.waitForCalls("evt-inflight-1", 1);
  const concurrent = await postWebhook(adapter.port, "evt-inflight-1", inflightPayload);
  assert.equal(concurrent.status, 503, "a request during an active lease must not be acknowledged with 2xx");
  assert.equal(concurrent.body.error, "event_processing");
  assert.ok(Number.isInteger(concurrent.body.retryAfterSeconds) && concurrent.body.retryAfterSeconds >= 1 && concurrent.body.retryAfterSeconds <= 60);
  assert.equal(concurrent.headers.get("retry-after"), String(concurrent.body.retryAfterSeconds));
  assert.equal(controlPlane.calls("evt-inflight-1"), 1, "a request during an active lease must not be forwarded");
  respondWith(500)(null, await held.promise);
  assert.equal((await firstAttempt).status, 502);
  const retriedAfterInflightFailure = await postWebhook(adapter.port, "evt-inflight-1", inflightPayload);
  assert.equal(retriedAfterInflightFailure.status, 202, "the retry after the in-flight forward failed must be forwarded");
  assert.equal(controlPlane.calls("evt-inflight-1"), 2);
  assert.equal(adapter.child.exitCode, null, "the adapter must keep running");
} finally {
  adapter.child.kill();
  await new Promise((resolve) => controlPlane.server.close(resolve));
}

const shortLease = spawnSync(process.execPath, ["--import", fakePgRegister, adapterEntry], {
  cwd: root,
  env: { ...adapterEnvironment(), CHANNEL_ADAPTER_PORT: String(await freePort()), CONTROL_PLANE_URL: "http://127.0.0.1:9", CHANNEL_ADAPTER_TARGETS: JSON.stringify([adapterTarget]), CHANNEL_ADAPTER_REPLAY_LEASE_SECONDS: "10", DATABASE_QUERY_TIMEOUT_MS: "5000" },
  encoding: "utf8",
  timeout: 10_000
});
assert.notEqual(shortLease.status, 0, "a replay lease that can expire during one forward must be rejected at startup");
assert.equal(shortLease.signal, null, "the adapter must exit on its own instead of starting with an unsafe lease");
assert.match(shortLease.stderr, /CHANNEL_ADAPTER_REPLAY_LEASE_SECONDS/);
assert.match(shortLease.stderr, /DATABASE_QUERY_TIMEOUT_MS/);
assert.doesNotMatch(shortLease.stderr, new RegExp(validTarget.signingSecret));

console.log("PASS  channel adapter releases its replay lease after failed forwards and answers in-flight duplicates with 503");

// /v1/replies regression: a reply dispatch that fails (a malformed JSON body sent with the correct dispatch
// token, or an unreachable provider) must be answered through the request error boundary, not crash the process.
const replyAdapter = await startAdapter({ CONTROL_PLANE_URL: "http://127.0.0.1:9", CHANNEL_ADAPTER_TARGETS: JSON.stringify([adapterTarget]) });
try {
  const malformedReply = await postReply(replyAdapter.port, "{not-json");
  assert.equal(malformedReply.failure, undefined, `a malformed reply must be answered instead of dropping the connection (${malformedReply.failure})`);
  assert.equal(malformedReply.status, 400);
  assert.deepEqual(malformedReply.body, { error: "invalid_webhook_payload" });
  const unreachableProvider = await postReply(replyAdapter.port, JSON.stringify({ tenantId: adapterTarget.tenantId, replyId: "323e4567-e89b-12d3-a456-426614174000", runId: "run_1", interactionId: "423e4567-e89b-12d3-a456-426614174000", channelConnectionId: adapterTarget.channelConnectionId, body: replyBody, bodySha256: payloadSha256(replyBody), idempotencyKey: "channel_reply_323e4567-e89b-12d3-a456-426614174000" }));
  assert.equal(unreachableProvider.failure, undefined, `a reply to an unreachable provider must be answered instead of dropping the connection (${unreachableProvider.failure})`);
  assert.equal(unreachableProvider.status, 500);
  const health = await fetch(`http://127.0.0.1:${replyAdapter.port}/healthz`, { signal: AbortSignal.timeout(5_000) }).then(async (response) => ({ status: response.status, body: await response.json() }), (error) => ({ failure: error?.cause?.code ?? error?.name ?? "request_failed" }));
  assert.deepEqual(health, { status: 200, body: { ok: true, channels: 1 } }, "/healthz must still answer after failed reply dispatches");
  assert.equal(replyAdapter.child.exitCode, null, "the adapter must keep running after failed reply dispatches");
  assert.doesNotMatch(replyAdapter.stderr(), new RegExp(adapterEnvironment().CHANNEL_ADAPTER_DISPATCH_TOKEN));
} finally {
  replyAdapter.child.kill();
}

console.log("PASS  channel adapter answers failed /v1/replies dispatches with an error status and keeps running");

async function postReply(port, rawBody) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/replies`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adapterEnvironment().CHANNEL_ADAPTER_DISPATCH_TOKEN}` },
      body: rawBody,
      signal: AbortSignal.timeout(15_000)
    });
    return { status: response.status, body: await response.json() };
  } catch (error) {
    return { failure: error?.cause?.code ?? error?.name ?? "request_failed" };
  }
}

function adapterEnvironment() {
  return { ...process.env, DATABASE_URL: "postgres://fake-pg.invalid/channel_adapter", CHANNEL_ADAPTER_DISPATCH_TOKEN: "channel-adapter-dispatch-token-at-least-32-bytes" };
}

async function startAdapter(overrides) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", fakePgRegister, adapterEntry], { cwd: root, env: { ...adapterEnvironment(), CHANNEL_ADAPTER_PORT: String(port), ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.resume();
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && child.exitCode === null) {
      const healthy = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) }).then((response) => response.ok, () => false);
      if (healthy) return { child, port, stderr: () => stderr };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    child.kill();
    lastError = new Error(`channel adapter did not start (attempt ${attempt + 1}): ${stderr.slice(0, 500)}`);
    if (!stderr.includes("EADDRINUSE")) break;
  }
  throw lastError;
}

async function startControlPlane() {
  const plans = new Map();
  const counts = new Map();
  const waiters = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(request.headers.authorization, `Bearer ${validTarget.commerceToken}`);
    assert.equal(request.url, "/api/v1/runtime/channel-commerce");
    counts.set(body.eventId, (counts.get(body.eventId) ?? 0) + 1);
    for (const waiter of waiters.splice(0)) waiter();
    const handler = plans.get(body.eventId)?.shift() ?? respondWith(500);
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    plan: (eventId, handlers) => plans.set(eventId, handlers),
    calls: (eventId) => counts.get(eventId) ?? 0,
    async waitForCalls(eventId, expected) {
      const deadline = Date.now() + 5_000;
      while ((counts.get(eventId) ?? 0) < expected) {
        assert.ok(Date.now() < deadline, `control plane did not receive ${expected} call(s) for ${eventId}`);
        await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, 100); });
      }
    }
  };
}

function respondWith(status) {
  return (_request, response) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(status < 300 ? { accepted: true } : { error: "fixture_rejection" })); };
}
function dropConnection(request) { request.socket.destroy(); }
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

async function postWebhook(port, eventId, rawBody) {
  const timestamp = String(Date.now());
  const response = await fetch(`http://127.0.0.1:${port}/v1/webhooks/${adapterTarget.channelConnectionId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shuzhiren-event-id": eventId, "x-shuzhiren-timestamp": timestamp, "x-shuzhiren-signature": `sha256=${createHmac("sha256", adapterTarget.signingSecret).update(`${timestamp}.${rawBody}`).digest("hex")}` },
    body: rawBody,
    signal: AbortSignal.timeout(15_000)
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

// H6 unit tests for the lease handling modules. They are imported here, after the process-level regression
// above, so that the regression still runs and fails by assertion on a revision without these modules.
const { FORWARD_TIMEOUT_MS, controlPlaneRequest, createWebhookProcessor, forwardToControlPlane } = await import("../apps/channel-adapter/webhook.mjs");
const { createPgReplayStore } = await import("../apps/channel-adapter/replay-store.mjs");
const { Pool: FakePool, createFakeDatabase } = await import("./fixtures/channel-adapter/fake-pg.mjs");

assert.equal(FORWARD_TIMEOUT_MS, 8_000);
assert.deepEqual(controlPlaneRequest({ target: validTarget, eventId: "evt-1", event: { kind: "interaction", runId: "run_1", question: "q" } }), { path: "/api/v1/runtime/channel-interactions", token: validTarget.interactionToken, body: { tenantId: validTarget.tenantId, channelConnectionId: validTarget.channelConnectionId, eventId: "evt-1", runId: "run_1", question: "q" } });
assert.equal(controlPlaneRequest({ target: validTarget, eventId: "evt-2", event: { kind: "commerce", runId: "run_1", eventType: "view", amountCents: 0, quantity: 0 } }).token, validTarget.commerceToken);

const forwardArgs = { url: "http://control-plane.invalid/api", token: "token", body: { eventId: "evt" } };
assert.deepEqual(await forwardToControlPlane({ ...forwardArgs, fetchImpl: async () => new Response("{}", { status: 202 }) }), { ok: true });
assert.deepEqual(await forwardToControlPlane({ ...forwardArgs, fetchImpl: async () => new Response("{}", { status: 409 }) }), { ok: false, kind: "rejected", status: 409 });
assert.deepEqual(await forwardToControlPlane({ ...forwardArgs, fetchImpl: async () => { throw new TypeError("fetch failed"); } }), { ok: false, kind: "network" });
assert.deepEqual(await forwardToControlPlane({ ...forwardArgs, fetchImpl: async () => { throw new DOMException("timed out", "TimeoutError"); } }), { ok: false, kind: "timeout" });
const silentServer = http.createServer(() => undefined);
await new Promise((resolve) => silentServer.listen(0, "127.0.0.1", resolve));
try {
  const startedAt = Date.now();
  assert.deepEqual(await forwardToControlPlane({ ...forwardArgs, url: `http://127.0.0.1:${silentServer.address().port}/api`, timeoutMs: 200 }), { ok: false, kind: "timeout" }, "a Control_Plane that never answers must be reported as a timeout");
  assert.ok(Date.now() - startedAt < 5_000);
} finally {
  silentServer.closeAllConnections();
  await new Promise((resolve) => silentServer.close(resolve));
}

function stubStore(reservation, { releaseFails = false, markFails = false } = {}) {
  const calls = { reserve: [], release: [], markDelivered: [] };
  return {
    calls,
    async reserve(...args) { calls.reserve.push(args); return reservation; },
    async release(...args) { calls.release.push(args); if (releaseFails) throw new Error("release failed for postgresql://internal/secret"); return true; },
    async markDelivered(...args) { calls.markDelivered.push(args); if (markFails) throw new Error("mark failed"); }
  };
}
const webhookInput = { target: validTarget, eventId: "evt-unit-1", payloadSha256: "a".repeat(64), event: { kind: "commerce", runId: "run_1", eventType: "view", amountCents: 0, quantity: 0 } };
const claimed = { kind: "claimed", leaseToken: "4242" };
for (const [label, forwardResult, expected] of [
  ["rejected", { ok: false, kind: "rejected", status: 500 }, { status: 502, body: { error: "control_plane_rejected", status: 500 } }],
  ["network", { ok: false, kind: "network" }, { status: 502, body: { error: "control_plane_unreachable" } }],
  ["timeout", { ok: false, kind: "timeout" }, { status: 504, body: { error: "control_plane_timeout" } }]
]) {
  for (const releaseFails of [false, true]) {
    const store = stubStore(claimed, { releaseFails });
    const logged = [];
    let forwards = 0;
    const handle = createWebhookProcessor({ store, allowRequest: () => true, forward: async () => { forwards += 1; return forwardResult; }, log: (event, fields) => logged.push({ event, fields }) });
    assert.deepEqual(await handle(webhookInput), expected, `a ${label} forward must return a non-2xx response${releaseFails ? " even when the release fails" : ""}`);
    assert.equal(forwards, 1);
    assert.deepEqual(store.calls.release, [[validTarget, "evt-unit-1", "4242"]], `a ${label} forward must release the lease it claimed, with its token`);
    assert.equal(store.calls.markDelivered.length, 0);
    if (releaseFails) {
      assert.deepEqual(logged, [{ event: "channel-adapter.release_failed", fields: { channelConnectionId: validTarget.channelConnectionId, eventId: "evt-unit-1", error: "Error" } }], "a failed release must be logged without request data or secrets");
    } else {
      assert.equal(logged.length, 0);
    }
  }
}
{
  const store = stubStore(claimed);
  const handle = createWebhookProcessor({ store, allowRequest: () => true, forward: async () => { throw new Error("unexpected forward bug"); }, log: () => undefined });
  await assert.rejects(() => handle(webhookInput), /unexpected forward bug/);
  assert.equal(store.calls.release.length, 1, "an unexpected forward exception must still release the lease");
}
{
  const store = stubStore(claimed);
  let forwards = 0;
  const handle = createWebhookProcessor({ store, allowRequest: () => false, forward: async () => { forwards += 1; return { ok: true }; }, log: () => undefined });
  assert.deepEqual(await handle(webhookInput), { status: 429, body: { error: "channel_rate_limited" } });
  assert.equal(forwards, 0);
  assert.deepEqual(store.calls.release, [[validTarget, "evt-unit-1", "4242"]], "rate limiting must release the claimed lease");
}
for (const markFails of [false, true]) {
  const store = stubStore(claimed, { markFails });
  const logged = [];
  const handle = createWebhookProcessor({ store, allowRequest: () => true, forward: async () => ({ ok: true }), log: (event) => logged.push(event) });
  assert.deepEqual(await handle(webhookInput), { status: 202, body: { accepted: true, duplicate: false } }, "a Control_Plane 2xx must be acknowledged even if recording it fails");
  assert.equal(store.calls.markDelivered.length, 1);
  assert.equal(store.calls.release.length, 0, "a delivered event must not be released");
  assert.deepEqual(logged, markFails ? ["channel-adapter.mark_delivered_failed"] : []);
}
{
  let forwards = 0;
  const forward = async () => { forwards += 1; return { ok: true }; };
  assert.deepEqual(await createWebhookProcessor({ store: stubStore({ kind: "delivered" }), allowRequest: () => true, forward })(webhookInput), { status: 200, body: { accepted: true, duplicate: true } });
  assert.deepEqual(await createWebhookProcessor({ store: stubStore({ kind: "processing", retryAfterSeconds: 37 }), allowRequest: () => true, forward })(webhookInput), { status: 503, headers: { "retry-after": "37" }, body: { error: "event_processing", retryAfterSeconds: 37 } });
  assert.equal(forwards, 0, "delivered and in-flight events must not be forwarded");
}

// Replay store against the in-memory database: lease tokens, database-clock expiry and release ownership.
let databaseClock = Date.parse("2026-01-01T00:00:00.000Z");
const database = createFakeDatabase({ now: () => databaseClock });
const store = createPgReplayStore(new FakePool({}, database), { leaseSeconds: 60 });
const hash = "b".repeat(64);
const replayRow = (eventId) => database.row(validTarget.tenantId, validTarget.channelConnectionId, eventId);
const first = await store.reserve(validTarget, "evt-store-1", hash);
assert.equal(first.kind, "claimed");
assert.match(first.leaseToken, /^\d+$/);
databaseClock += 20_500;
assert.deepEqual(await store.reserve(validTarget, "evt-store-1", hash), { kind: "processing", retryAfterSeconds: 40 }, "an active lease must report the remaining seconds rounded up");
assert.equal(replayRow("evt-store-1").xmin, Number(first.leaseToken), "checking an active lease must not change its owner token");
await assert.rejects(() => store.reserve(validTarget, "evt-store-1", "c".repeat(64)), /event_id_reused_with_different_payload/);
assert.equal(await store.release(validTarget, "evt-store-1", first.leaseToken), true, "the holder must be able to release its own lease");
assert.deepEqual({ state: replayRow("evt-store-1").state, leaseExpiresAt: replayRow("evt-store-1").lease_expires_at }, { state: "pending", leaseExpiresAt: null });
assert.equal(await store.release(validTarget, "evt-store-1", first.leaseToken), false, "a released lease cannot be released twice");
const second = await store.reserve(validTarget, "evt-store-1", hash);
assert.equal(second.kind, "claimed", "a released event must be claimable again before the original lease would have expired");
assert.notEqual(second.leaseToken, first.leaseToken);

const holderA = await store.reserve(validTarget, "evt-store-2", hash);
databaseClock += 61_000;
const holderB = await store.reserve(validTarget, "evt-store-2", hash);
assert.equal(holderB.kind, "claimed", "an expired lease must be reclaimed by the next request");
assert.equal(await store.release(validTarget, "evt-store-2", holderA.leaseToken), false, "a stale holder must not release the lease another request reclaimed");
assert.equal(replayRow("evt-store-2").state, "delivering");
assert.equal((await store.reserve(validTarget, "evt-store-2", hash)).kind, "processing", "the reclaimed lease must stay active after the stale release");
assert.equal(await store.release(validTarget, "evt-store-2", "not-a-token"), false);
assert.equal(await store.release(validTarget, "evt-store-2", holderB.leaseToken), true);

const delivering = await store.reserve(validTarget, "evt-store-3", hash);
await store.markDelivered(validTarget, "evt-store-3");
assert.equal(await store.release(validTarget, "evt-store-3", delivering.leaseToken), false, "a delivered event must not return to pending");
assert.deepEqual(await store.reserve(validTarget, "evt-store-3", hash), { kind: "delivered" });
assert.ok(database.statements.every((statement) => !statement.startsWith("select") || !statement.includes("channel_webhook_replays") || statement.includes("tenant_id = $1")), "replay lookups must be scoped by tenant, channel and event id");

console.log("PASS  channel adapter lease handling releases only its own lease and reports forward failures as non-2xx");

// M3: pg-pool emits "error" when an idle connection is terminated; without a listener the adapter exited.
// This scenario runs the real `pg` package against a fake PostgreSQL server instead of the in-memory fake.
const { assertSurvivesIdleConnectionTermination } = await import("./fixtures/pool-error-scenario.mjs");
await assertSurvivesIdleConnectionTermination({
  name: "channel adapter",
  entry: adapterEntry,
  cwd: root,
  portVariable: "CHANNEL_ADAPTER_PORT",
  env: { ...adapterEnvironment(), CONTROL_PLANE_URL: "http://127.0.0.1:9", CHANNEL_ADAPTER_TARGETS: JSON.stringify([adapterTarget]), DATABASE_QUERY_TIMEOUT_MS: "2000" }
});
console.log("PASS  channel adapter survives the termination of idle database connections and logs the pool error (M3)");

// L7: the channel adapter registered no SIGTERM handler, so as a container's PID 1 it ignored `docker stop`
// until Docker killed it after 10 s.
{
  const { installGracefulShutdown } = await import("../apps/channel-adapter/lib.mjs");
  const { assertGracefulShutdownBehaviour, assertProcessExitsOnSigterm } = await import("./fixtures/graceful-shutdown-scenarios.mjs");
  await assertGracefulShutdownBehaviour(installGracefulShutdown, "channel adapter");
  let forwardedSignal = null;
  const aborted = await forwardToControlPlane({ url: "http://127.0.0.1:9/", token: "t", body: {}, signal: AbortSignal.abort(), fetchImpl: async (_url, options) => { forwardedSignal = options.signal; throw options.signal.reason; } });
  assert.equal(forwardedSignal?.aborted, true, "the shutdown signal must reach the Control_Plane forward");
  assert.deepEqual(aborted, { ok: false, kind: "network" }, "an aborted forward must fail like a network error so its lease is released");
  const ran = await assertProcessExitsOnSigterm({
    name: "channel adapter",
    args: ["--import", fakePgRegister, adapterEntry],
    cwd: root,
    portVariable: "CHANNEL_ADAPTER_PORT",
    env: { ...adapterEnvironment(), CONTROL_PLANE_URL: controlPlane.url, CHANNEL_ADAPTER_TARGETS: JSON.stringify([adapterTarget]) }
  });
  console.log(`PASS  channel adapter stops listening on SIGTERM, aborts in-flight forwards after the grace period and exits 0 (process check: ${ran}) (L7)`);
}
