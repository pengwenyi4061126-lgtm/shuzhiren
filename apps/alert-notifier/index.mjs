import http from "node:http";
import pg from "pg";
import { alertPayload, matchingSeverities, parseTargets, retryDelayMs, signWebhook } from "./lib.mjs";

const port = positiveInt(process.env.ALERT_NOTIFIER_PORT, 8083, "ALERT_NOTIFIER_PORT");
const databaseUrl = required(process.env.DATABASE_URL, "DATABASE_URL");
const targets = parseTargets(process.env.ALERT_NOTIFIER_TARGETS, { allowInsecureHttp: process.env.ALERT_NOTIFIER_ALLOW_INSECURE_HTTP === "true" });
const pollMs = positiveInt(process.env.ALERT_NOTIFIER_POLL_MS, 5_000, "ALERT_NOTIFIER_POLL_MS");
const leaseSeconds = positiveInt(process.env.ALERT_NOTIFIER_LEASE_SECONDS, 60, "ALERT_NOTIFIER_LEASE_SECONDS");
const maxAttempts = positiveInt(process.env.ALERT_NOTIFIER_MAX_ATTEMPTS, 6, "ALERT_NOTIFIER_MAX_ATTEMPTS");
const retryBaseMs = positiveInt(process.env.ALERT_NOTIFIER_RETRY_BASE_MS, 1_000, "ALERT_NOTIFIER_RETRY_BASE_MS");
const retryMaxMs = Math.max(retryBaseMs, positiveInt(process.env.ALERT_NOTIFIER_RETRY_MAX_MS, 60_000, "ALERT_NOTIFIER_RETRY_MAX_MS"));
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
let stopping = false;
let lastSuccessfulTickAt = null;
let lastTickError = null;

const server = http.createServer(async (request, response) => {
  if (request.method !== "GET" || request.url !== "/healthz") return json(response, 404, { error: "not_found" });
  try {
    await pool.query("select 1");
    const tickFresh = lastSuccessfulTickAt !== null && Date.now() - lastSuccessfulTickAt <= Math.max(pollMs * 3, 15_000);
    const ok = tickFresh && !stopping;
    return json(response, ok ? 200 : 503, { ok, targets: targets.length, lastSuccessfulTickAt: lastSuccessfulTickAt === null ? null : new Date(lastSuccessfulTickAt).toISOString(), lastError: lastTickError });
  } catch {
    return json(response, 503, { ok: false, targets: targets.length, lastSuccessfulTickAt: lastSuccessfulTickAt === null ? null : new Date(lastSuccessfulTickAt).toISOString(), lastError: lastTickError ?? "database_unavailable" });
  }
});

server.listen(port, "0.0.0.0", () => console.log(`alert-notifier listening on ${port}`));
let running = false;
const timer = setInterval(() => void tick(), pollMs);
void tick();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  stopping = true;
  clearInterval(timer);
  server.close(() => pool.end().finally(() => process.exit(0)));
});

async function tick() {
  if (running) return;
  running = true;
  try {
    for (const target of targets) {
      await enqueueNewAlerts(target);
      const delivery = await claimDelivery(target);
      if (delivery) await deliver(target, delivery);
    }
    lastSuccessfulTickAt = Date.now();
    lastTickError = null;
  } catch (error) {
    lastTickError = error instanceof Error ? error.message : "alert_notifier_tick_failed";
    console.error("alert-notifier.tick_failed", lastTickError);
  } finally {
    running = false;
  }
}

async function enqueueNewAlerts(target) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [target.tenantId]);
    await client.query(`insert into alert_notification_deliveries (tenant_id, runtime_alert_id, target_id)
      select a.tenant_id, a.id, $2
      from runtime_alerts a
      where a.status = 'open' and a.severity = any($3::alert_severity[])
      on conflict (tenant_id, runtime_alert_id, target_id) do nothing`, [target.tenantId, target.id, matchingSeverities(target.minimumSeverity)]);
    await client.query("commit");
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; } finally { client.release(); }
}

async function claimDelivery(target) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [target.tenantId]);
    const selected = await client.query(`select d.id, d.runtime_alert_id as alert_id, a.live_run_id, a.severity, a.code, a.message, a.opened_at, d.attempts
      from alert_notification_deliveries d
      join runtime_alerts a on a.id = d.runtime_alert_id
      where d.target_id = $1
        and d.attempts < $2
        and (d.state = 'pending' or (d.state = 'delivering' and d.lease_expires_at <= now()))
        and d.available_at <= now()
      order by d.created_at
      for update of d skip locked
      limit 1`, [target.id, maxAttempts]);
    const delivery = selected.rows[0];
    if (!delivery) { await client.query("commit"); return null; }
    await client.query("update alert_notification_deliveries set state = 'delivering', attempts = attempts + 1, lease_expires_at = now() + ($2 * interval '1 second'), updated_at = now(), last_error = null where id = $1", [delivery.id, leaseSeconds]);
    await client.query("commit");
    return { ...delivery, attempts: Number(delivery.attempts) + 1 };
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; } finally { client.release(); }
}

async function deliver(target, delivery) {
  const rawBody = JSON.stringify(alertPayload(delivery));
  const signed = signWebhook(rawBody, target.signingSecret);
  try {
    const response = await fetch(target.webhookUrl, { method: "POST", headers: { "content-type": "application/json", "x-shuzhiren-event-id": delivery.id, "x-shuzhiren-timestamp": signed.timestamp, "x-shuzhiren-signature": signed.signature }, body: rawBody, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`webhook_status_${response.status}`);
    await complete(target.tenantId, delivery.id);
    console.log("alert-notifier.delivered", { deliveryId: delivery.id, target: target.id, attempts: delivery.attempts });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "webhook_delivery_failed";
    await retry(target.tenantId, delivery, message);
    console.error("alert-notifier.failed", { deliveryId: delivery.id, target: target.id, attempts: delivery.attempts, error: message });
  }
}

async function complete(tenantId, deliveryId) { await withTenant(tenantId, async (client) => { await client.query("update alert_notification_deliveries set state = 'delivered', delivered_at = now(), lease_expires_at = null, last_error = null, updated_at = now() where id = $1", [deliveryId]); }); }
async function retry(tenantId, delivery, message) {
  const exhausted = delivery.attempts >= maxAttempts;
  const delay = retryDelayMs(delivery.attempts, retryBaseMs, retryMaxMs);
  await withTenant(tenantId, async (client) => { await client.query("update alert_notification_deliveries set state = $2, lease_expires_at = null, available_at = now() + ($3 * interval '1 millisecond'), last_error = $4, updated_at = now() where id = $1", [delivery.id, exhausted ? "failed" : "pending", delay, message]); });
}
async function withTenant(tenantId, operation) {
  const client = await pool.connect();
  try { await client.query("begin"); await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]); await operation(client); await client.query("commit"); } catch (error) { await client.query("rollback").catch(() => undefined); throw error; } finally { client.release(); }
}
function positiveInt(value, fallback, name) { const parsed = Number(value ?? fallback); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`); return parsed; }
function required(value, name) { if (!value) throw new Error(`${name} is required`); return value; }
function json(response, status, value) { response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); }
