import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createServicePool } from "./db.mjs";
import { installGracefulShutdown, parseControlPlaneUrl, parseNormalizedEvent, parseOutboundReply, parseTargets, payloadSha256, publicRequestError, verifyWebhook } from "./lib.mjs";
import { createPgReplayStore } from "./replay-store.mjs";
import { FORWARD_TIMEOUT_MS, controlPlaneRequest, createWebhookProcessor, forwardToControlPlane } from "./webhook.mjs";

const port = positiveInt(process.env.CHANNEL_ADAPTER_PORT, 8082, "CHANNEL_ADAPTER_PORT");
const controlPlaneUrl = parseControlPlaneUrl(process.env.CONTROL_PLANE_URL);
const targets = parseTargets(process.env.CHANNEL_ADAPTER_TARGETS);
const dispatchToken = requiredSecret("CHANNEL_ADAPTER_DISPATCH_TOKEN");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for durable webhook replay protection");
const replayLeaseSeconds = positiveInt(process.env.CHANNEL_ADAPTER_REPLAY_LEASE_SECONDS, 60, "CHANNEL_ADAPTER_REPLAY_LEASE_SECONDS");
const maxRequestsPerMinute = positiveInt(process.env.CHANNEL_ADAPTER_MAX_REQUESTS_PER_MINUTE, 120, "CHANNEL_ADAPTER_MAX_REQUESTS_PER_MINUTE");
const databaseTimeoutMs = boundedPositiveInt(process.env.DATABASE_QUERY_TIMEOUT_MS, 5_000, "DATABASE_QUERY_TIMEOUT_MS", 100, 60_000);
// A lease must outlive one forward plus the connect-and-query steps around it, otherwise another request can
// reclaim the event while the first forward is still running and both get forwarded.
if (replayLeaseSeconds * 1000 <= FORWARD_TIMEOUT_MS + 2 * databaseTimeoutMs) throw new Error(`CHANNEL_ADAPTER_REPLAY_LEASE_SECONDS (${replayLeaseSeconds} s) must exceed the forward timeout (${FORWARD_TIMEOUT_MS} ms) plus twice DATABASE_QUERY_TIMEOUT_MS (${databaseTimeoutMs} ms)`);
const pool = createServicePool({ service: "channel-adapter", connectionString: databaseUrl, max: 8, timeoutMs: databaseTimeoutMs, log });
const rateWindows = new Map();
const processWebhook = createWebhookProcessor({
  store: createPgReplayStore(pool, { leaseSeconds: replayLeaseSeconds, log }),
  allowRequest,
  forward: ({ target, eventId, event }) => {
    const request = controlPlaneRequest({ target, eventId, event });
    // An aborted forward fails like a network error, so its replay lease is released for the platform's retry.
    return forwardToControlPlane({ url: new URL(request.path, controlPlaneUrl), token: request.token, body: request.body, signal: shutdown.signal });
  }
});

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      await pool.query("select 1");
      return json(response, 200, { ok: true, channels: targets.size });
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    // Await inside the try block so a rejected dispatch reaches the error boundary below instead of becoming an
    // unhandled rejection that terminates the process.
    if (request.method === "POST" && path === "/v1/replies") return await dispatchReply(request, response);
    const match = request.method === "POST" ? path.match(/^\/v1\/webhooks\/([^/]+)$/) : null;
    if (!match) return json(response, 404, { error: "not_found" });
    const target = targets.get(decodeURIComponent(match[1]));
    if (!target) return json(response, 404, { error: "unknown_channel" });
    const rawBody = await readBody(request);
    const eventId = request.headers["x-shuzhiren-event-id"];
    const timestamp = request.headers["x-shuzhiren-timestamp"];
    const signature = request.headers["x-shuzhiren-signature"];
    if (typeof eventId !== "string" || !eventId.trim() || eventId.length > 200) return json(response, 400, { error: "invalid_event_id" });
    if (!verifyWebhook({ rawBody, timestamp: asHeader(timestamp), signature: asHeader(signature), secret: target.signingSecret })) return json(response, 401, { error: "invalid_webhook_signature" });
    const event = parseNormalizedEvent(JSON.parse(rawBody));
    const outcome = await processWebhook({ target, eventId, payloadSha256: payloadSha256(rawBody), event });
    return json(response, outcome.status, outcome.body, outcome.headers);
  } catch (error) {
    if (shutdown.signal.aborted) return json(response, 503, { error: "shutting_down" });
    const result = publicRequestError(error);
    console.error("channel-adapter.request_failed", { error: error instanceof Error ? error.message : "unknown_error", status: result.status, code: result.error });
    return json(response, result.status, { error: result.error });
  }
});

const shutdown = installGracefulShutdown({ server, log, cleanup: () => pool.end() });
server.listen(port, "0.0.0.0", () => console.log(`channel-adapter listening on ${port}`));
async function dispatchReply(request, response) {
  if (!hasBearerToken(request, dispatchToken)) return json(response, 401, { error: "invalid_dispatch_token" });
  const reply = parseOutboundReply(JSON.parse(await readBody(request)));
  const target = targets.get(reply.channelConnectionId);
  if (!target || target.tenantId !== reply.tenantId) return json(response, 404, { error: "unknown_channel" });
  const forwarded = await fetch(target.providerReplyEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${target.providerReplyToken}` },
    body: JSON.stringify({ channelConnectionId: reply.channelConnectionId, replyId: reply.replyId, runId: reply.runId, interactionId: reply.interactionId, body: reply.body, bodySha256: reply.bodySha256, idempotencyKey: reply.idempotencyKey }),
    signal: AbortSignal.any([AbortSignal.timeout(8_000), shutdown.signal])
  });
  if (!forwarded.ok) return json(response, forwarded.status >= 500 || forwarded.status === 429 ? 502 : 422, { error: "provider_reply_rejected", status: forwarded.status });
  const receipt = await forwarded.json().catch(() => null);
  if (!receipt || typeof receipt !== "object" || typeof receipt.providerMessageId !== "string" || !receipt.providerMessageId || receipt.providerMessageId.length > 200) return json(response, 502, { error: "invalid_provider_reply_receipt" });
  return json(response, 200, { providerMessageId: receipt.providerMessageId });
}
function log(event, fields = {}) { process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), service: "channel-adapter", event, ...fields })}\n`); }
function asHeader(value) { return typeof value === "string" ? value : ""; }
function requiredSecret(name) { const value = process.env[name]; if (!value || value.length < 32 || /\s/.test(value)) throw new Error(`${name} must contain at least 32 non-whitespace characters`); return value; }
function hasBearerToken(request, token) { const supplied = Buffer.from(asHeader(request.headers.authorization)); const expected = Buffer.from(`Bearer ${token}`); return supplied.length === expected.length && timingSafeEqual(supplied, expected); }
function positiveInt(value, fallback, name) { const parsed = Number(value ?? fallback); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`); return parsed; }
function boundedPositiveInt(value, fallback, name, minimum, maximum) { const parsed = positiveInt(value, fallback, name); if (parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`); return parsed; }
function json(response, status, value, headers = {}) { response.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); }
async function readBody(request) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 128 * 1024) throw new Error("webhook_body_too_large"); chunks.push(chunk); } return Buffer.concat(chunks).toString("utf8"); }
function allowRequest(channelConnectionId, now = Date.now()) {
  const windowStart = now - 60_000;
  const attempts = (rateWindows.get(channelConnectionId) ?? []).filter((at) => at > windowStart);
  if (attempts.length >= maxRequestsPerMinute) { rateWindows.set(channelConnectionId, attempts); return false; }
  attempts.push(now);
  rateWindows.set(channelConnectionId, attempts);
  return true;
}
