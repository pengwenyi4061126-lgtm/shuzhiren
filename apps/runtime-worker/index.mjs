import pg from "pg";

const { Pool } = pg;
const databaseUrl = required("DATABASE_URL");
const gatewayUrl = required("RUNTIME_GATEWAY_URL").replace(/\/$/, "");
const gatewayToken = required("RUNTIME_SHARED_TOKEN");
const pollMs = positiveInt(process.env.OUTBOX_POLL_MS, 1000);
const schedulerPollMs = positiveInt(process.env.SCHEDULER_POLL_MS, 1000);
const schedulerBatchSize = positiveInt(process.env.SCHEDULER_BATCH_SIZE, 10);
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

async function scheduleDueRun() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const due = await client.query(`
      select id, tenant_id, trace_id, runtime_session_id
      from live_runs
      where state = 'ARMED' and scheduled_at <= now() and runtime_session_id is not null
      order by scheduled_at
      for update skip locked
      limit 1
    `);
    const run = due.rows[0];
    if (!run) { await client.query("commit"); return null; }
    await client.query("update live_runs set state = 'LIVE', updated_at = now() where id = $1", [run.id]);
    const command = { id: `media_${crypto.randomUUID()}`, runId: run.id, type: "start_program", issuedAt: new Date().toISOString(), traceId: run.trace_id, payload: { controlAction: "SCHEDULED_START" } };
    const event = await client.query(`
      insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload)
      values ($1, 'media.dispatch', 'live_run', $2, $3::jsonb)
      returning id
    `, [run.tenant_id, run.id, JSON.stringify({ sessionId: run.runtime_session_id, command })]);
    await client.query("commit");
    return { runId: run.id, eventId: event.rows[0].id };
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
  const now = Date.now();
  if (now >= nextSchedulerPollAt) {
    let scheduledCount = 0;
    while (scheduledCount < schedulerBatchSize) {
      const scheduled = await scheduleDueRun();
      if (!scheduled) break;
      log("schedule.started", scheduled);
      scheduledCount += 1;
    }
    nextSchedulerPollAt = Date.now() + schedulerPollMs;
  }
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
let nextSchedulerPollAt = 0;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });
log("worker.started", { pollMs, schedulerPollMs, schedulerBatchSize, maxAttempts });
while (!stopping) {
  try { await tick(); } catch (error) { log("worker.error", { error: error instanceof Error ? error.message : "unknown" }); }
  const schedulerWaitMs = Math.max(1, nextSchedulerPollAt - Date.now());
  await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, schedulerWaitMs)));
}
await pool.end();
log("worker.stopped");
