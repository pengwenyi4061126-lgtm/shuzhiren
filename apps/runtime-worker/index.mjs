import pg from "pg";

const { Pool } = pg;
const databaseUrl = required("DATABASE_URL");
const gatewayUrl = required("RUNTIME_GATEWAY_URL").replace(/\/$/, "");
const gatewayToken = required("RUNTIME_SHARED_TOKEN");
const pollMs = positiveInt(process.env.OUTBOX_POLL_MS, 1000);
const schedulerPollMs = positiveInt(process.env.SCHEDULER_POLL_MS, 1000);
const schedulerBatchSize = positiveInt(process.env.SCHEDULER_BATCH_SIZE, 10);
const watchdogPollMs = positiveInt(process.env.RUNTIME_WATCHDOG_POLL_MS, 5000);
const watchdogBatchSize = positiveInt(process.env.RUNTIME_WATCHDOG_BATCH_SIZE, 10);
const maxTelemetryAgeSeconds = positiveInt(process.env.RUNTIME_TELEMETRY_MAX_AGE_SECONDS, 60);
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

async function degradeStaleLiveRun() {
  const ids = await tenantIds();
  const ordered = tenantOrder(ids, nextWatchdogTenantCursor);
  for (const tenantId of ordered) {
    const degraded = await inTenantTransaction(tenantId, async (client) => {
      const stale = await client.query(`
        select run.id, run.tenant_id, run.trace_id, run.runtime_session_id, sample.sampled_at, sample.fallback_ready
        from live_runs run
        left join lateral (
          select sampled_at, fallback_ready
          from runtime_health_samples
          where live_run_id = run.id
          order by sampled_at desc
          limit 1
        ) sample on true
        where run.state = 'LIVE'
          and (sample.sampled_at is null or sample.sampled_at < now() - ($1 * interval '1 second'))
        order by sample.sampled_at nulls first, run.updated_at
        for update of run skip locked
        limit 1
      `, [maxTelemetryAgeSeconds]);
      const run = stale.rows[0];
      if (!run) return null;

      await client.query("update live_runs set state = 'DEGRADED', updated_at = now() where id = $1 and state = 'LIVE'", [run.id]);
      const fallbackReady = run.fallback_ready === true;
      const action = fallbackReady ? "switch_to_fallback" : "switch_to_human";
      let eventId = null;
      if (run.runtime_session_id) {
        const command = {
          id: `media_${crypto.randomUUID()}`,
          runId: run.id,
          type: action,
          issuedAt: new Date().toISOString(),
          traceId: run.trace_id,
          payload: { controlAction: "RUNTIME_TELEMETRY_STALE", reasons: "runtime_telemetry_stale" }
        };
        const event = await client.query(`
          insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload)
          values ($1, 'media.dispatch', 'live_run', $2, $3::jsonb)
          returning id
        `, [run.tenant_id, run.id, JSON.stringify({ sessionId: run.runtime_session_id, command })]);
        eventId = event.rows[0].id;
      }

      const existingAlert = await client.query("select id from runtime_alerts where live_run_id = $1 and code = 'runtime_telemetry_stale' and status = 'open' for update", [run.id]);
      if (!existingAlert.rows[0]) {
        await client.query(
          "insert into runtime_alerts (tenant_id, live_run_id, severity, code, message, status) values ($1, $2, 'critical', 'runtime_telemetry_stale', $3, 'open')",
          [run.tenant_id, run.id, `运行时遥测超过 ${maxTelemetryAgeSeconds} 秒未更新`]
        );
      }
      const actor = await client.query("select sync_control_plane_actor($1::uuid, 'runtime-watchdog', '运行时健康看门狗', 'operator'::membership_role) as id", [run.tenant_id]);
      await client.query(
        `insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
         values ($1, $2, 'runtime_guard.degraded', 'live_run', $3::uuid, $3, $4::jsonb)`,
        [run.tenant_id, actor.rows[0].id, run.id, JSON.stringify({ reason: "runtime_telemetry_stale", lastSampledAt: run.sampled_at ? new Date(run.sampled_at).toISOString() : null, fallbackReady, action, outboxEventId: eventId })]
      );
      return { runId: run.id, eventId, action, lastSampledAt: run.sampled_at ? new Date(run.sampled_at).toISOString() : null };
    });
    if (degraded) {
      nextWatchdogTenantCursor = (ids.indexOf(tenantId) + 1) % ids.length;
      return degraded;
    }
  }
  if (ids.length) nextWatchdogTenantCursor = (nextWatchdogTenantCursor + 1) % ids.length;
  return null;
}

function retryDelayMs(attempts) { return Math.min(retryMaxMs, retryBaseMs * (2 ** Math.max(0, attempts - 1))); }

async function markDelivered(event) {
  await inTenantTransaction(event.tenant_id, async (client) => {
    await client.query("update outbox_events set state = 'delivered', delivered_at = now(), last_error = null where id = $1", [event.id]);
    if (["SCHEDULED_START", "START", "RECOVER"].includes(event.payload?.command?.payload?.controlAction)) {
      await client.query(
        "update live_runs set state = 'LIVE', updated_at = now() where id = $1 and tenant_id = $2 and state in ('ARMED', 'DEGRADED') and scheduled_start_event_id = $3",
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
  const request = deliveryRequest(event);
  const response = await fetch(`${gatewayUrl}${request.path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${gatewayToken}` }, body: JSON.stringify(request.body) });
  if (!response.ok) throw new Error(`Runtime gateway returned ${response.status}: ${await response.text()}`);
}

function deliveryRequest(event) {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) throw new Error("Invalid outbox payload");
  if (event.event_type === "media.dispatch") {
    const { sessionId, command } = event.payload;
    if (!sessionIdValid(sessionId) || !command || typeof command !== "object" || Array.isArray(command)) throw new Error("Invalid media dispatch payload");
    if (!commandIdValid(command.id) || !["start_program", "switch_to_fallback", "switch_to_human", "stop_program"].includes(command.type)) throw new Error("Invalid media command");
    return { path: "/v1/media", body: { command_id: command.id, session_id: sessionId, action: command.type } };
  }
  if (event.event_type === "speech.dispatch") {
    const { sessionId, command } = event.payload;
    if (!sessionIdValid(sessionId) || !command || typeof command !== "object" || Array.isArray(command)) throw new Error("Invalid speech dispatch payload");
    if (!commandIdValid(command.id) || !sessionIdValid(command.runId) || typeof command.text !== "string" || command.text.length < 1 || command.text.length > 800) throw new Error("Invalid speech command");
    if (typeof command.voice !== "string" || command.voice.length < 1 || command.voice.length > 128 || typeof command.interrupt !== "boolean") throw new Error("Invalid speech options");
    if (!sessionIdValid(command.productVersionId) || !Number.isInteger(command.productRevision) || command.productRevision < 1) throw new Error("Invalid speech evidence");
    return { path: "/v1/speak", body: { command_id: command.id, session_id: sessionId, text: command.text, interrupt: command.interrupt, voice: command.voice, provider: "cosyvoice" } };
  }
  throw new Error(`Unsupported event type: ${event.event_type}`);
}

function commandIdValid(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }
function sessionIdValid(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }

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
  if (now >= nextWatchdogPollAt) {
    let degradedCount = 0;
    while (degradedCount < watchdogBatchSize) {
      const degraded = await degradeStaleLiveRun();
      if (!degraded) break;
      log("runtime.watchdog.degraded", degraded);
      degradedCount += 1;
    }
    nextWatchdogPollAt = Date.now() + watchdogPollMs;
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
let nextWatchdogPollAt = 0;
let nextWatchdogTenantCursor = 0;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });
log("worker.started", { pollMs, schedulerPollMs, schedulerBatchSize, watchdogPollMs, watchdogBatchSize, maxTelemetryAgeSeconds, maxAttempts, leaseSeconds, retryBaseMs, retryMaxMs });
while (!stopping) {
  try { await tick(); } catch (error) { log("worker.error", { error: error instanceof Error ? error.message : "unknown" }); }
  const schedulerWaitMs = Math.max(1, nextSchedulerPollAt - Date.now());
  const watchdogWaitMs = Math.max(1, nextWatchdogPollAt - Date.now());
  await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, schedulerWaitMs, watchdogWaitMs)));
}
await pool.end();
log("worker.stopped");
