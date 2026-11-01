import pg from "pg";

const { Pool } = pg;
const databaseUrl = required("DATABASE_URL");
const gatewayUrl = required("RUNTIME_GATEWAY_URL").replace(/\/$/, "");
const gatewayToken = required("RUNTIME_SHARED_TOKEN");
const pollMs = positiveInt(process.env.OUTBOX_POLL_MS, 1000);
const maxAttempts = positiveInt(process.env.OUTBOX_MAX_ATTEMPTS, 6);
const pool = new Pool({ connectionString: databaseUrl, max: 4 });

function required(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function positiveInt(value, fallback) { const parsed = Number.parseInt(value ?? "", 10); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function log(event, fields = {}) { process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), service: "runtime-worker", event, ...fields })}\n`); }

async function claimEvent() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query(`
      with candidate as (
        select id
        from outbox_events
        where state in ('pending', 'failed') and available_at <= now() and attempts < $1
        order by created_at
        for update skip locked
        limit 1
      )
      update outbox_events event
      set state = 'delivering', attempts = event.attempts + 1, last_error = null
      from candidate
      where event.id = candidate.id
      returning event.id, event.tenant_id, event.event_type, event.payload, event.attempts
    `, [maxAttempts]);
    await client.query("commit");
    return result.rows[0] ?? null;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}

async function mark(id, state, lastError = null) {
  await pool.query("update outbox_events set state = $2, delivered_at = case when $2 = 'delivered' then now() else delivered_at end, last_error = $3 where id = $1", [id, state, lastError]);
}

async function deliver(event) {
  if (event.event_type !== "media.dispatch") throw new Error(`Unsupported event type: ${event.event_type}`);
  const { sessionId, command } = event.payload;
  const response = await fetch(`${gatewayUrl}/v1/media`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${gatewayToken}` }, body: JSON.stringify({ session_id: sessionId, action: command.type }) });
  if (!response.ok) throw new Error(`Runtime gateway returned ${response.status}: ${await response.text()}`);
}

async function tick() {
  const event = await claimEvent();
  if (!event) return;
  try {
    await deliver(event);
    await mark(event.id, "delivered");
    log("outbox.delivered", { eventId: event.id, attempts: event.attempts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "runtime_dispatch_failed";
    await mark(event.id, "failed", message);
    log("outbox.failed", { eventId: event.id, attempts: event.attempts, error: message });
  }
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });
log("worker.started", { pollMs, maxAttempts });
while (!stopping) {
  try { await tick(); } catch (error) { log("worker.error", { error: error instanceof Error ? error.message : "unknown" }); }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}
await pool.end();
log("worker.stopped");
