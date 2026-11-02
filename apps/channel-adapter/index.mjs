import http from "node:http";
import pg from "pg";
import { parseNormalizedEvent, parseTargets, payloadSha256, verifyWebhook } from "./lib.mjs";

const port = positiveInt(process.env.CHANNEL_ADAPTER_PORT, 8082);
const controlPlaneUrl = requiredUrl("CONTROL_PLANE_URL");
const targets = parseTargets(process.env.CHANNEL_ADAPTER_TARGETS);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for durable webhook replay protection");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/healthz") return json(response, 200, { ok: true, channels: targets.size });
    const match = request.method === "POST" ? new URL(request.url ?? "/", "http://localhost").pathname.match(/^\/v1\/webhooks\/([^/]+)$/) : null;
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
    const replay = await reserveReplay(target, eventId, payloadSha256(rawBody));
    if (replay.state === "delivered") return json(response, 200, { accepted: true, duplicate: true });
    const downstream = event.kind === "interaction" ? "/api/v1/runtime/channel-interactions" : "/api/v1/runtime/channel-commerce";
    const token = event.kind === "interaction" ? target.interactionToken : target.commerceToken;
    const body = event.kind === "interaction"
      ? { tenantId: target.tenantId, channelConnectionId: target.channelConnectionId, eventId, runId: event.runId, question: event.question }
      : { tenantId: target.tenantId, channelConnectionId: target.channelConnectionId, eventId, runId: event.runId, eventType: event.eventType, occurredAt: event.occurredAt, orderReference: event.orderReference, amountCents: event.amountCents };
    const forwarded = await fetch(new URL(downstream, controlPlaneUrl), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(8_000) });
    if (!forwarded.ok) return json(response, 502, { error: "control_plane_rejected", status: forwarded.status });
    await markDelivered(target, eventId);
    return json(response, 202, { accepted: true, duplicate: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "webhook_processing_failed";
    return json(response, message.startsWith("Invalid") || message.includes("required") || message.includes("Unsupported") ? 400 : 500, { error: message });
  }
});

server.listen(port, "0.0.0.0", () => console.log(`channel-adapter listening on ${port}`));
async function reserveReplay(target, eventId, hash) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [target.tenantId]);
    const inserted = await client.query("insert into channel_webhook_replays (tenant_id, channel_connection_id, external_event_id, payload_sha256) values ($1, $2, $3, $4) on conflict (tenant_id, channel_connection_id, external_event_id) do nothing returning state", [target.tenantId, target.channelConnectionId, eventId, hash]);
    if (inserted.rows[0]) { await client.query("commit"); return inserted.rows[0]; }
    const existing = await client.query("select state, payload_sha256 from channel_webhook_replays where channel_connection_id = $1 and external_event_id = $2 for update", [target.channelConnectionId, eventId]);
    if (!existing.rows[0]) throw new Error("webhook_replay_conflict_unresolved");
    if (existing.rows[0].payload_sha256 !== hash) throw new Error("event_id_reused_with_different_payload");
    await client.query("commit"); return existing.rows[0];
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; } finally { client.release(); }
}
async function markDelivered(target, eventId) { const client = await pool.connect(); try { await client.query("begin"); await client.query("select set_config('app.tenant_id', $1, true)", [target.tenantId]); await client.query("update channel_webhook_replays set state = 'delivered', delivered_at = now() where channel_connection_id = $1 and external_event_id = $2", [target.channelConnectionId, eventId]); await client.query("commit"); } catch (error) { await client.query("rollback").catch(() => undefined); throw error; } finally { client.release(); } }
function asHeader(value) { return typeof value === "string" ? value : ""; }
function requiredUrl(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return new URL(value); }
function positiveInt(value, fallback) { const parsed = Number(value ?? fallback); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("CHANNEL_ADAPTER_PORT must be a positive integer"); return parsed; }
function json(response, status, value) { response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); }
async function readBody(request) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 128 * 1024) throw new Error("webhook_body_too_large"); chunks.push(chunk); } return Buffer.concat(chunks).toString("utf8"); }
