import pg from "pg";

const { Pool } = pg;
const databaseUrl = required("DATABASE_URL");
const gatewayUrl = required("RUNTIME_GATEWAY_URL").replace(/\/$/, "");
const gatewayToken = required("RUNTIME_SHARED_TOKEN");
const pollMs = positiveInt(process.env.OUTBOX_POLL_MS, 1000);
const schedulerPollMs = positiveInt(process.env.SCHEDULER_POLL_MS, 1000);
const schedulerBatchSize = positiveInt(process.env.SCHEDULER_BATCH_SIZE, 10);
const maxAttempts = positiveInt(process.env.OUTBOX_MAX_ATTEMPTS, 6);
const leaseSeconds = positiveInt(process.env.OUTBOX_LEASE_SECONDS, 60);
const retryBaseMs = positiveInt(process.env.OUTBOX_RETRY_BASE_MS, 1000);
const retryMaxMs = Math.max(retryBaseMs, positiveInt(process.env.OUTBOX_RETRY_MAX_MS, 60000));
const pool = new Pool({ connectionString: databaseUrl, max: 4 });

function required(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function positiveInt(value, fallback) { const parsed = Number.parseInt(value ?? "", 10); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function log(event, fields = {}) { process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), service: "runtime-worker", event, ...fields })}\n`); }

async function tenantIds() {
  // tenants deliberately has no RLS policy. The worker reads only IDs here,
  // then scopes every business-table transaction to one tenant below.
  const result = await pool.query("select id from tenants order by id");
  return result.rows.map((row) => row.id);
}

function tenantOrder(ids, cursor) {
  if (!ids.length) return [];
  const start = cursor % ids.length;
  return [...ids.slice(start), ...ids.slice(0, start)];
}

async function inTenantTransaction(tenantId, operation) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}

async function claimEvent() {
  const ids = await tenantIds();
  const ordered = tenantOrder(ids, nextOutboxTenantCursor);
  for (const tenantId of ordered) {
    const event = await inTenantTransaction(tenantId, async (client) => {
      const result = await client.query(`
      with candidate as (
        select id
        from outbox_events
        where ((state in ('pending', 'failed') and available_at <= now()) or (state = 'delivering' and available_at <= now()))
          and attempts < $1
        order by available_at, created_at
        for update skip locked
        limit 1
      )
      update outbox_events event
      set state = 'delivering', attempts = event.attempts + 1, last_error = null, available_at = now() + ($2 * interval '1 second')
      from candidate
      where event.id = candidate.id
      returning event.id, event.tenant_id, event.event_type, event.payload, event.attempts
    `, [maxAttempts, leaseSeconds]);
      return result.rows[0] ?? null;
    });
    if (event) {
      nextOutboxTenantCursor = (ids.indexOf(tenantId) + 1) % ids.length;
      return event;
    }
  }
  if (ids.length) nextOutboxTenantCursor = (nextOutboxTenantCursor + 1) % ids.length;
  return null;
}

async function scheduleDueRun() {
  const ids = await tenantIds();
  const ordered = tenantOrder(ids, nextSchedulerTenantCursor);
  for (const tenantId of ordered) {
    const scheduled = await inTenantTransaction(tenantId, async (client) => {
      const due = await client.query(`
      select id, tenant_id, trace_id, runtime_session_id
      from live_runs
      where state = 'ARMED'
        and scheduled_at <= now()
        and runtime_session_id is not null
        and scheduled_start_event_id is null
      order by scheduled_at
      for update skip locked
      limit 1
    `);
      const run = due.rows[0];
      if (!run) return null;
      const command = { id: `media_${crypto.randomUUID()}`, runId: run.id, type: "start_program", issuedAt: new Date().toISOString(), traceId: run.trace_id, payload: { controlAction: "SCHEDULED_START" } };
      const event = await client.query(`
      insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload)
      values ($1, 'media.dispatch', 'live_run', $2, $3::jsonb)
      returning id
    `, [run.tenant_id, run.id, JSON.stringify({ sessionId: run.runtime_session_id, command })]);
      await client.query("update live_runs set scheduled_start_event_id = $2, updated_at = now() where id = $1", [run.id, event.rows[0].id]);
      return { runId: run.id, eventId: event.rows[0].id };
    });
    if (scheduled) {
      nextSchedulerTenantCursor = (ids.indexOf(tenantId) + 1) % ids.length;
      return scheduled;
    }
  }
  if (ids.length) nextSchedulerTenantCursor = (nextSchedulerTenantCursor + 1) % ids.length;
  return null;
}

function retryDelayMs(attempts) { return Math.min(retryMaxMs, retryBaseMs * (2 ** Math.max(0, attempts - 1))); }

async function markDelivered(event) {
  await inTenantTransaction(event.tenant_id, async (client) => {
    await client.query("update outbox_events set state = 'delivered', delivered_at = now(), last_error = null where id = $1", [event.id]);
    if (event.payload?.command?.payload?.controlAction === "SCHEDULED_START") {
      await client.query(
        "update live_runs set state = 'LIVE', updated_at = now() where id = $1 and tenant_id = $2 and state = 'ARMED' and scheduled_start_event_id = $3",
        [event.payload.command.runId, event.tenant_id, event.id]
      );
    }
  });
}

async function markFailed(event, lastError) {
  const retryAfterMs = retryDelayMs(event.attempts);
  await inTenantTransaction(event.tenant_id, async (client) => {
    await client.query("update outbox_events set state = 'failed', available_at = now() + ($3 * interval '1 millisecond'), last_error = $2 where id = $1", [event.id, lastError, retryAfterMs]);
  });
  return { exhausted: event.attempts >= maxAttempts, retryAfterMs };
}

async function deliver(event) {
  if (event.event_type !== "media.dispatch") throw new Error(`Unsupported event type: ${event.event_type}`);
  const { sessionId, command } = event.payload;
  const response = await fetch(`${gatewayUrl}/v1/media`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${gatewayToken}` }, body: JSON.stringify({ command_id: command.id, session_id: sessionId, action: command.type }) });
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
    await markDelivered(event);
    log("outbox.delivered", { eventId: event.id, attempts: event.attempts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "runtime_dispatch_failed";
    const retry = await markFailed(event, message);
    log(retry.exhausted ? "outbox.exhausted" : "outbox.failed", { eventId: event.id, attempts: event.attempts, retryAfterMs: retry.retryAfterMs, error: message });
  }
}

let stopping = false;
let nextSchedulerPollAt = 0;
let nextOutboxTenantCursor = 0;
let nextSchedulerTenantCursor = 0;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });
log("worker.started", { pollMs, schedulerPollMs, schedulerBatchSize, maxAttempts, leaseSeconds, retryBaseMs, retryMaxMs });
while (!stopping) {
  try { await tick(); } catch (error) { log("worker.error", { error: error instanceof Error ? error.message : "unknown" }); }
  const schedulerWaitMs = Math.max(1, nextSchedulerPollAt - Date.now());
  await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, schedulerWaitMs)));
}
await pool.end();
log("worker.stopped");
