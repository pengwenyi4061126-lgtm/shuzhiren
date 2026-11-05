import http from "node:http";
import { createHash } from "node:crypto";
import { createServicePool, inTenantTransaction as inPoolTenantTransaction } from "./db.mjs";
import { createInteractionRuleEvaluator, interactionRuleConfig } from "./interaction-rules.mjs";

const databaseUrl = required("DATABASE_URL");
const gatewayUrl = required("RUNTIME_GATEWAY_URL").replace(/\/$/, "");
const gatewayToken = requiredSecret("RUNTIME_SHARED_TOKEN");
const gatewayRequestTimeoutMs = boundedPositiveInt("RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS", 100, 60_000, 20_000);
const channelAdapterUrl = optionalHttpUrl("CHANNEL_ADAPTER_URL");
const channelAdapterToken = optionalSecret("CHANNEL_ADAPTER_DISPATCH_TOKEN");
const databaseTimeoutMs = boundedPositiveInt("DATABASE_QUERY_TIMEOUT_MS", 100, 60_000, 5_000);
const pollMs = positiveInt(process.env.OUTBOX_POLL_MS, 1000);
const schedulerPollMs = positiveInt(process.env.SCHEDULER_POLL_MS, 1000);
const schedulerBatchSize = positiveInt(process.env.SCHEDULER_BATCH_SIZE, 10);
const watchdogPollMs = positiveInt(process.env.RUNTIME_WATCHDOG_POLL_MS, 5000);
const watchdogBatchSize = positiveInt(process.env.RUNTIME_WATCHDOG_BATCH_SIZE, 10);
const maxTelemetryAgeSeconds = positiveInt(process.env.RUNTIME_TELEMETRY_MAX_AGE_SECONDS, 60);
const usageMeterPollMs = positiveInt(process.env.USAGE_METER_POLL_MS, 60_000);
const maxAttempts = positiveInt(process.env.OUTBOX_MAX_ATTEMPTS, 6);
const leaseSeconds = positiveInt(process.env.OUTBOX_LEASE_SECONDS, 60);
const retryBaseMs = positiveInt(process.env.OUTBOX_RETRY_BASE_MS, 1000);
const retryMaxMs = Math.max(retryBaseMs, positiveInt(process.env.OUTBOX_RETRY_MAX_MS, 60000));
const healthPort = positiveInt(process.env.RUNTIME_WORKER_PORT, 8080);
// Live interaction rules (apps/runtime-worker/interaction-rules.mjs, migration 084).
const interactionRules = interactionRuleConfig(process.env);
// Metering runs in its own loop at least every 30 s, so every minute a run stays LIVE or DEGRADED gets at least
// one metering pass while that minute lasts; larger configured values are capped.
const usageMeterIntervalMs = Math.min(usageMeterPollMs, 30_000);
// Each claim takes a lease of OUTBOX_LEASE_SECONDS. A delivery request is aborted before the lease can expire,
// so another worker that reclaims the event never overlaps with a request still in flight.
const leaseMs = leaseSeconds * 1000;
const leaseMarginMs = Math.min(2000, Math.floor(leaseMs / 10));
// Gateway receipts are bound to the event, not to the time of this attempt: a retry receives the receipt of the
// first acceptance. It must not predate the event (minus clock skew between Gateway and database).
const RECEIPT_CLOCK_SKEW_MS = 30_000;
const pool = createServicePool({ service: "runtime-worker", connectionString: databaseUrl, max: 4, timeoutMs: databaseTimeoutMs, log });

function required(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function requiredSecret(name) { const value = required(name); if (value.length < 32 || /\s/.test(value)) throw new Error(`${name} must contain at least 32 non-whitespace characters`); return value; }
function optionalSecret(name) { const value = process.env[name]; if (!value) return undefined; if (value.length < 32 || /\s/.test(value)) throw new Error(`${name} must contain at least 32 non-whitespace characters`); return value; }
function optionalHttpUrl(name) { const value = process.env[name]; if (!value) return undefined; let url; try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTP(S) URL`); } if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`${name} must be an HTTP(S) URL without embedded credentials`); return url.toString().replace(/\/$/, ""); }
function positiveInt(value, fallback) { const parsed = Number.parseInt(value ?? "", 10); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function boundedPositiveInt(name, minimum, maximum, fallback) { const value = process.env[name]; if (value === undefined || value === "") return fallback; const parsed = Number.parseInt(value, 10); if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`); return parsed; }
function log(event, fields = {}) { process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), service: "runtime-worker", event, ...fields })}\n`); }
// gatewayCode is the Gateway's machine-readable error code. outcomeUncertain: the Gateway cannot tell whether the
// command took effect (command_outcome_uncertain); the event is failed without retrying and flagged for an operator.
class DeliveryError extends Error { constructor(message, retryable, { gatewayCode, outcomeUncertain = false } = {}) { super(message); this.retryable = retryable; this.gatewayCode = gatewayCode; this.outcomeUncertain = outcomeUncertain; } }
// The downstream accepted the command but its receipt cannot be applied (cursor or delivery state no longer
// matches). Every retry would send the command again and fail the same way, so the event is exhausted at once.
class ReceiptRejectedError extends DeliveryError { constructor(message) { super(message, false); } }
// The event is no longer in the state this worker claimed (its lease expired and it was reclaimed): write nothing.
class LeaseLostError extends Error {}

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

function inTenantTransaction(tenantId, operation) {
  return inPoolTenantTransaction(pool, tenantId, operation, { log });
}

async function claimEvent() {
  const ids = await tenantIds();
  const ordered = tenantOrder(ids, nextOutboxTenantCursor);
  for (const tenantId of ordered) {
    // The database's now() for the lease is not earlier than this moment, so the lease ends no earlier than
    // claimStartedAt + leaseMs on this process's monotonic clock.
    const claimStartedAt = performance.now();
    const event = await inTenantTransaction(tenantId, async (client) => {
      await sweepExhaustedLeases(client, tenantId);
      // The tenant filter repeats row-level security, so a privileged connection also stays in this tenant.
      // A media.dispatch event waits until every earlier media.dispatch event of the same live run is delivered,
      // cancelled or exhausted, so the commands of one run reach the runtime in the order they were issued.
      const result = await client.query(`
      with candidate as (
        select o.id
        from outbox_events o
        where o.tenant_id = $3::uuid and o.state in ('pending', 'failed', 'delivering') and o.available_at <= now()
          and o.attempts < $1
          -- An event the Gateway answered command_outcome_uncertain waits for an operator, whatever its attempts.
          -- A delivering event is still reclaimed: a manual redelivery may have been accepted without being recorded.
          and (o.outcome_uncertain_at is null or o.state = 'delivering')
          and (o.event_type <> 'media.dispatch' or o.aggregate_id is null or not exists (
            select 1 from outbox_events prior
            where prior.tenant_id = o.tenant_id and prior.event_type = 'media.dispatch'
              and prior.aggregate_id = o.aggregate_id
              and (prior.created_at, prior.id) < (o.created_at, o.id)
              and prior.state in ('pending', 'failed', 'delivering')
              and not (prior.state = 'failed' and prior.attempts >= $1)))
        order by o.available_at, o.created_at, o.id
        for update of o skip locked
        limit 1
      )
      update outbox_events event
      set state = 'delivering', attempts = event.attempts + 1, last_error = null, available_at = now() + ($2 * interval '1 second')
      from candidate
      where event.id = candidate.id
      returning event.id, event.tenant_id, event.event_type, event.aggregate_id, event.payload, event.attempts, event.created_at
    `, [maxAttempts, leaseSeconds, tenantId]);
      return result.rows[0] ?? null;
    });
    if (event) {
      nextOutboxTenantCursor = (ids.indexOf(tenantId) + 1) % ids.length;
      return { ...event, claimStartedAt };
    }
  }
  if (ids.length) nextOutboxTenantCursor = (nextOutboxTenantCursor + 1) % ids.length;
  return null;
}

// An event claimed for its final attempt is never claimed again. If that attempt ended without a recorded
// outcome (the process crashed or was killed), fail it once its lease has expired and open the same exhausted
// alert as markFailed, instead of leaving it delivering forever.
async function sweepExhaustedLeases(client, tenantId) {
  const lastError = "delivery lease expired after the final attempt";
  const swept = await client.query(`
    with stale as (
      select id from outbox_events
      where tenant_id = $3::uuid and state = 'delivering' and available_at <= now() and attempts >= $1
      order by available_at
      for update skip locked
      limit 10
    )
    update outbox_events event
    set state = 'failed', last_error = $2
    from stale
    where event.id = stale.id
    returning event.id, event.tenant_id, event.event_type, event.aggregate_id, event.payload, event.attempts
  `, [maxAttempts, lastError, tenantId]);
  for (const event of swept.rows) {
    if (event.event_type === "channel.reply.dispatch") await failChannelReply(client, event, lastError);
    await openDeliveryExhaustedAlert(client, event, lastError);
    log("outbox.exhausted", { eventId: event.id, attempts: event.attempts, error: lastError });
  }
}

async function scheduleDueRun() {
  const ids = await tenantIds();
  const ordered = tenantOrder(ids, nextSchedulerTenantCursor);
  for (const tenantId of ordered) {
    const scheduled = await inTenantTransaction(tenantId, async (client) => {
      const due = await client.query(`
      select id, tenant_id, show_revision_id, trace_id, runtime_session_id
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
      const initialProgram = await client.query("select id, runtime_script from show_revision_segments where tenant_id = $1 and show_revision_id = $2 and kind in ('prepared_product', 'interactive') and runtime_script is not null order by position limit 1", [run.tenant_id, run.show_revision_id]);
      if (!initialProgram.rows[0]) {
        await client.query("update live_runs set scheduled_at = null, updated_at = now() where id = $1 and scheduled_at is not null", [run.id]);
        const opened = await client.query("insert into runtime_alerts (tenant_id, live_run_id, severity, code, message, status) values ($1, $2, 'critical', 'program_script_missing', '场次缺少已批准的冻结主节目脚本，已拒绝定时开播', 'open') on conflict (tenant_id, live_run_id, code) where (status = 'open') do nothing returning id", [run.tenant_id, run.id]);
        if (opened.rows[0]) {
          const actor = await client.query("select runtime_worker_actor($1::uuid, 'runtime-scheduler') as id", [run.tenant_id]);
          await client.query(`insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
            values ($1, $2, 'live_run.start_blocked_by_program_script', 'live_run', $3::uuid, $3, $4::jsonb)`, [run.tenant_id, actor.rows[0].id, run.id, JSON.stringify({ showRevisionId: run.show_revision_id })]);
        }
        return null;
      }
      // The Gateway synthesizes the start script only with the revision's frozen approved voice (CosyVoice).
      // Reads only the columns granted in infra/postgres/service-principals.sql.
      const voiceBinding = await client.query(`select asset.runtime_voice_id, asset.checksum
        from show_revision_media_assets binding join media_assets asset on asset.id = binding.media_asset_id
        where binding.tenant_id = $1 and binding.show_revision_id = $2 and binding.kind = 'voice'
          and asset.approval_status = 'approved' and (asset.expires_at is null or asset.expires_at >= current_date)`, [run.tenant_id, run.show_revision_id]);
      const voice = voiceBinding.rows.length === 1 ? voiceBinding.rows[0] : null;
      if (!voice || !runtimeVoiceIdValid(voice.runtime_voice_id) || !voiceChecksumValid(voice.checksum)) {
        await client.query("update live_runs set scheduled_at = null, updated_at = now() where id = $1 and scheduled_at is not null", [run.id]);
        const opened = await client.query("insert into runtime_alerts (tenant_id, live_run_id, severity, code, message, status) values ($1, $2, 'critical', 'runtime_voice_missing', '场次缺少已批准的冻结声线绑定，已拒绝定时开播', 'open') on conflict (tenant_id, live_run_id, code) where (status = 'open') do nothing returning id", [run.tenant_id, run.id]);
        if (opened.rows[0]) {
          const actor = await client.query("select runtime_worker_actor($1::uuid, 'runtime-scheduler') as id", [run.tenant_id]);
          await client.query(`insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
            values ($1, $2, 'live_run.start_blocked_by_voice_binding', 'live_run', $3::uuid, $3, $4::jsonb)`, [run.tenant_id, actor.rows[0].id, run.id, JSON.stringify({ showRevisionId: run.show_revision_id })]);
        }
        return null;
      }
      const entitlements = await client.query("select code, limit_value from tenant_entitlements where effective_from <= current_date and (effective_until is null or effective_until >= current_date) for update");
      let blockedCode = null;
      for (const entitlement of entitlements.rows) {
        if (entitlement.code === "max_concurrent_live_runs") {
          const active = await client.query("select count(*) from live_runs where (state in ('LIVE', 'DEGRADED') or (state = 'ARMED' and scheduled_start_event_id is not null)) and id <> $1", [run.id]);
          if (Number(active.rows[0].count) >= Number(entitlement.limit_value)) blockedCode = "max_concurrent_live_runs";
        }
        if (entitlement.code === "monthly_live_minutes") {
          const used = await client.query("select coalesce(sum(quantity), 0) as total from usage_records where code = 'monthly_live_minutes' and occurred_at >= date_trunc('month', now())");
          if (Number(used.rows[0].total) >= Number(entitlement.limit_value)) blockedCode = "monthly_live_minutes";
        }
      }
      if (blockedCode) {
        const existing = await client.query("select id from runtime_alerts where live_run_id = $1 and code = 'entitlement_exhausted' and status = 'open' for update", [run.id]);
        if (!existing.rows[0]) {
          const opened = await client.query("insert into runtime_alerts (tenant_id, live_run_id, severity, code, message, status) values ($1, $2, 'warning', 'entitlement_exhausted', $3, 'open') on conflict (tenant_id, live_run_id, code) where (status = 'open') do nothing returning id", [run.tenant_id, run.id, `场次因额度 ${blockedCode} 而未自动开播`]);
          if (opened.rows[0]) {
            const actor = await client.query("select runtime_worker_actor($1::uuid, 'runtime-scheduler') as id", [run.tenant_id]);
            await client.query(`insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
              values ($1, $2, 'live_run.start_blocked_by_entitlement', 'live_run', $3::uuid, $3, $4::jsonb)`, [run.tenant_id, actor.rows[0].id, run.id, JSON.stringify({ entitlement: blockedCode })]);
          }
        }
        return null;
      }
      const resolvedEntitlementAlert = await client.query("update runtime_alerts set status = 'resolved', resolved_at = now() where live_run_id = $1 and code = 'entitlement_exhausted' and status = 'open' returning id", [run.id]);
      if (resolvedEntitlementAlert.rows[0]) {
        const actor = await client.query("select runtime_worker_actor($1::uuid, 'runtime-scheduler') as id", [run.tenant_id]);
        await client.query(`insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
          values ($1, $2, 'runtime_alert.resolved', 'runtime_alert', $3::uuid, $3, $4::jsonb)`, [run.tenant_id, actor.rows[0].id, resolvedEntitlementAlert.rows[0].id, JSON.stringify({ runId: run.id, code: "entitlement_exhausted" })]);
      }
      const segment = initialProgram.rows[0];
      const scriptSha256 = createHash("sha256").update(segment.runtime_script).digest("hex");
      const command = { id: `media_${crypto.randomUUID()}`, runId: run.id, type: "start_program", issuedAt: new Date().toISOString(), traceId: run.trace_id, payload: { controlAction: "SCHEDULED_START", programSegmentId: segment.id, runtimeScript: segment.runtime_script, scriptSha256, runtimeVoiceId: voice.runtime_voice_id, voiceChecksum: voice.checksum } };
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

async function meterLiveUsage() {
  const ids = await tenantIds();
  let recorded = 0;
  for (const tenantId of ids) {
    recorded += await inTenantTransaction(tenantId, async (client) => {
      // occurred_at is the metered minute, the same minute as in the idempotency key, so a record written just
      // after a month boundary still counts towards the month of its minute.
      const result = await client.query(`insert into usage_records (tenant_id, code, live_run_id, quantity, idempotency_key, metadata, occurred_at)
        select $1, 'monthly_live_minutes', id, 1,
          'live-minute:' || id::text || ':' || to_char(date_trunc('minute', now() at time zone 'UTC'), 'YYYYMMDDHH24MI'),
          jsonb_build_object('meter', 'runtime-worker', 'bucket', 'one_minute'),
          date_trunc('minute', now())
        from live_runs
        where state in ('LIVE', 'DEGRADED')
          and exists (select 1 from tenant_entitlements where code = 'monthly_live_minutes' and effective_from <= current_date and (effective_until is null or effective_until >= current_date))
        on conflict (tenant_id, idempotency_key) do nothing`, [tenantId]);
      return result.rowCount ?? 0;
    });
  }
  return recorded;
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
          "insert into runtime_alerts (tenant_id, live_run_id, severity, code, message, status) values ($1, $2, 'critical', 'runtime_telemetry_stale', $3, 'open') on conflict (tenant_id, live_run_id, code) where (status = 'open') do nothing",
          [run.tenant_id, run.id, `运行时遥测超过 ${maxTelemetryAgeSeconds} 秒未更新`]
        );
      }
      const actor = await client.query("select runtime_worker_actor($1::uuid, 'runtime-watchdog') as id", [run.tenant_id]);
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

async function markDelivered(event, receipt = {}) {
  await inTenantTransaction(event.tenant_id, async (client) => {
    // Fenced by the claim: (id, attempts) identifies this worker's lease. If the lease expired and another worker
    // reclaimed the event, nothing is written and the new holder completes it.
    const fenced = await client.query("update outbox_events set state = 'delivered', delivered_at = now(), last_error = null, outcome_uncertain_at = null where id = $1 and state = 'delivering' and attempts = $2", [event.id, event.attempts]);
    if (fenced.rowCount !== 1) throw new LeaseLostError("outbox lease lost before the delivery was recorded");
    if (event.event_type === "channel.reply.dispatch") {
      const providerMessageId = receipt.providerMessageId;
      if (typeof providerMessageId !== "string" || !providerMessageId || providerMessageId.length > 200) throw new ReceiptRejectedError("Channel adapter response omitted providerMessageId");
      const delivered = await client.query("update channel_reply_drafts set status = 'sent', sent_at = now(), provider_message_id = $2, updated_at = now() where id = $1 and outbox_event_id = $3 and status = 'sending' returning id, interaction_id, live_run_id", [event.aggregate_id, providerMessageId, event.id]);
      if (!delivered.rows[0]) throw new ReceiptRejectedError("Channel reply delivery state was not found");
      const actor = await client.query("select runtime_worker_actor($1::uuid, 'runtime-worker') as id", [event.tenant_id]);
      await client.query("update live_interactions set status = 'handled', handled_by = $2, handled_at = now(), resolution_note = '渠道回复已送达' where id = $1 and status = 'queued'", [delivered.rows[0].interaction_id, actor.rows[0].id]);
      await client.query(`insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
        values ($1, $2, 'channel_reply.delivered', 'channel_reply_draft', $3::uuid, $3, $4::jsonb)`, [event.tenant_id, actor.rows[0].id, delivered.rows[0].id, JSON.stringify({ runId: delivered.rows[0].live_run_id, interactionId: delivered.rows[0].interaction_id, outboxEventId: event.id, providerMessageId })]);
    }
    if (["SCHEDULED_START", "START", "RECOVER"].includes(event.payload?.command?.payload?.controlAction)) {
      const promoted = await client.query(
        "update live_runs set state = 'LIVE', scheduled_start_event_id = null, updated_at = now() where id = $1 and tenant_id = $2 and state in ('ARMED', 'DEGRADED') and scheduled_start_event_id = $3",
        [event.payload.command.runId, event.tenant_id, event.id]
      );
      if (promoted.rowCount && event.payload?.command?.payload?.programSegmentId) await applyActivationProgramReceipt(client, event, receipt.mediaReceipt);
    }
    if (event.payload?.command?.payload?.controlAction === "END") {
      await client.query(
        "update live_runs set state = 'ENDED', pending_media_event_id = null, updated_at = now() where id = $1 and tenant_id = $2 and state in ('LIVE', 'DEGRADED') and pending_media_event_id = $3",
        [event.payload.command.runId, event.tenant_id, event.id]
      );
    }
    if (event.event_type === "media.dispatch" && ["INSERT_PROGRAM", "ROLLBACK_PROGRAM"].includes(event.payload?.command?.payload?.controlAction)) {
      await applyProgramTransitionReceipt(client, event, receipt.mediaReceipt);
    }
  });
}

async function applyProgramTransitionReceipt(client, event, receipt) {
  const command = event.payload?.command;
  const payload = command?.payload;
  if (!command || !payload || !receipt) throw new ReceiptRejectedError("Program transition receipt is missing");
  const target = typeof payload.programSegmentId === "string" ? payload.programSegmentId : null;
  const source = typeof payload.sourceProgramSegmentId === "string" ? payload.sourceProgramSegmentId : null;
  const inserted = typeof payload.insertedProgramSegmentId === "string" ? payload.insertedProgramSegmentId : null;
  let updated;
  if (payload.controlAction === "INSERT_PROGRAM") {
    if (!target) throw new ReceiptRejectedError("Program insertion target is missing");
    updated = await client.query("update live_runs set active_program_segment_id = $2::uuid, active_insert_source_segment_id = $3::uuid, active_insert_program_segment_id = $2::uuid, pending_program_transition_event_id = null, updated_at = now() where id = $1 and pending_program_transition_event_id = $4::uuid returning id", [command.runId, target, source, event.id]);
  } else {
    if (!inserted) throw new ReceiptRejectedError("Program rollback insertion reference is missing");
    updated = await client.query("update live_runs set active_program_segment_id = $2::uuid, active_insert_source_segment_id = null, active_insert_program_segment_id = null, pending_program_transition_event_id = null, updated_at = now() where id = $1 and active_insert_program_segment_id = $3::uuid and pending_program_transition_event_id = $4::uuid returning id", [command.runId, target, inserted, event.id]);
  }
  if (!updated.rows[0]) throw new ReceiptRejectedError("Program transition cursor was not pending for this receipt");
  const actor = await client.query("select runtime_worker_actor($1::uuid, 'runtime-worker') as id", [event.tenant_id]);
  await client.query(`insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
    values ($1, $2, 'live_program.transition_accepted', 'live_run', $3::uuid, $3, $4::jsonb)`, [event.tenant_id, actor.rows[0].id, command.runId, JSON.stringify({ outboxEventId: event.id, commandId: command.id, action: payload.controlAction, programSegmentId: target, sourceProgramSegmentId: source, receipt })]);
}

async function applyActivationProgramReceipt(client, event, receipt) {
  const command = event.payload?.command;
  const payload = command?.payload;
  if (!command || !payload || !receipt || typeof payload.programSegmentId !== "string") throw new ReceiptRejectedError("Program activation receipt is missing");
  const updated = await client.query("update live_runs set active_program_segment_id = $2::uuid, updated_at = now() where id = $1 and tenant_id = $3 and state = 'LIVE' returning id", [command.runId, payload.programSegmentId, event.tenant_id]);
  if (!updated.rows[0]) throw new ReceiptRejectedError("Program activation cursor was not available for this receipt");
  const actor = await client.query("select runtime_worker_actor($1::uuid, 'runtime-worker') as id", [event.tenant_id]);
  await client.query(`insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
    values ($1, $2, 'live_program.activation_accepted', 'live_run', $3::uuid, $3, $4::jsonb)`, [event.tenant_id, actor.rows[0].id, command.runId, JSON.stringify({ outboxEventId: event.id, commandId: command.id, action: payload.controlAction, programSegmentId: payload.programSegmentId, receipt })]);
}

// outcomeUncertain sets outcome_uncertain_at (kept if already set); definite (command_failed_definite) clears it.
// Any other failure, for example a network error on a manual redelivery, leaves the flag as it was.
async function markFailed(event, lastError, retryable = true, { outcomeUncertain = false, definite = false } = {}) {
  const retryAfterMs = retryDelayMs(event.attempts);
  const exhausted = !retryable || event.attempts >= maxAttempts;
  await inTenantTransaction(event.tenant_id, async (client) => {
    // Same lease fence as markDelivered: a reclaimed event belongs to its new holder.
    const fenced = await client.query(`update outbox_events set state = 'failed', attempts = case when $4 then $5 else attempts end, available_at = now() + ($3 * interval '1 millisecond'), last_error = $2,
      outcome_uncertain_at = case when $7 then coalesce(outcome_uncertain_at, now()) when $8 then null else outcome_uncertain_at end
      where id = $1 and state = 'delivering' and attempts = $6`, [event.id, lastError, retryAfterMs, exhausted, maxAttempts, event.attempts, outcomeUncertain, definite]);
    if (fenced.rowCount !== 1) throw new LeaseLostError("outbox lease lost before the failure was recorded");
    if (exhausted && event.event_type === "channel.reply.dispatch") await failChannelReply(client, event, lastError);
    if (exhausted) await openDeliveryExhaustedAlert(client, event, lastError, { outcomeUncertain });
  });
  return { exhausted, retryAfterMs };
}

async function openDeliveryExhaustedAlert(client, event, lastError, { outcomeUncertain = false } = {}) {
  if (!event.aggregate_id || !["media.dispatch", "speech.dispatch", "channel.reply.dispatch"].includes(event.event_type)) return;
  const runId = event.event_type === "channel.reply.dispatch" ? event.payload?.runId : event.aggregate_id;
  if (typeof runId !== "string") return;
  const run = await client.query("select id from live_runs where id = $1 for update", [runId]);
  if (!run.rows[0]) return;
  const severity = event.event_type === "media.dispatch" ? "critical" : "warning";
  const code = event.event_type === "channel.reply.dispatch" ? "channel_reply_delivery_exhausted" : "runtime_command_delivery_exhausted";
  const existing = await client.query("select id from runtime_alerts where live_run_id = $1 and code = $2 and status = 'open' for update", [runId, code]);
  if (existing.rows[0]) return;
  const error = String(lastError).replace(/[\r\n\t]+/g, " ").slice(0, 500);
  // An uncertain command may have reached the media session: the operator checks it instead of resending blindly.
  const message = outcomeUncertain
    ? `运行时 ${event.event_type} 指令结果不确定，需人工核对媒体会话后在 Gateway 处置并重新投递：${error}`
    : `运行时 ${event.event_type} 指令在 ${event.attempts} 次尝试后仍未送达：${error}`;
  const opened = await client.query(
    "insert into runtime_alerts (tenant_id, live_run_id, severity, code, message, status) values ($1, $2, $3::alert_severity, $4, $5, 'open') on conflict (tenant_id, live_run_id, code) where (status = 'open') do nothing returning id",
    [event.tenant_id, runId, severity, code, message]
  );
  if (!opened.rows[0]) return;
  const actor = await client.query("select runtime_worker_actor($1::uuid, 'runtime-worker') as id", [event.tenant_id]);
  await client.query(
    `insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
     values ($1, $2, 'runtime_command.delivery_exhausted', 'runtime_alert', $3::uuid, $3, $4::jsonb)`,
    [event.tenant_id, actor.rows[0].id, opened.rows[0].id, JSON.stringify({ runId, outboxEventId: event.id, eventType: event.event_type, attempts: event.attempts, severity, ...(outcomeUncertain ? { outcomeUncertain: true } : {}) })]
  );
}

async function failChannelReply(client, event, lastError) {
  const failureReason = String(lastError).replace(/[\r\n\t]+/g, " ").slice(0, 1000);
  const failed = await client.query("update channel_reply_drafts set status = 'failed', failure_reason = $2, updated_at = now() where id = $1 and outbox_event_id = $3 and status = 'sending' returning id, interaction_id, live_run_id", [event.aggregate_id, failureReason, event.id]);
  if (!failed.rows[0]) return;
  const actor = await client.query("select runtime_worker_actor($1::uuid, 'runtime-worker') as id", [event.tenant_id]);
  await client.query(`insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
    values ($1, $2, 'channel_reply.delivery_failed', 'channel_reply_draft', $3::uuid, $3, $4::jsonb)`, [event.tenant_id, actor.rows[0].id, failed.rows[0].id, JSON.stringify({ runId: failed.rows[0].live_run_id, interactionId: failed.rows[0].interaction_id, outboxEventId: event.id, error: failureReason })]);
}

async function deliver(event) {
  const request = deliveryRequest(event);
  const target = request.target === "channel-adapter" ? channelAdapterUrl : gatewayUrl;
  const token = request.target === "channel-adapter" ? channelAdapterToken : gatewayToken;
  if (!target || !token) throw new DeliveryError("Channel adapter dispatch is not configured", false);
  const timeoutMs = deliveryTimeoutMs(event);
  if (timeoutMs < 100) {
    log("outbox.lease_budget_exhausted", { eventId: event.id, attempts: event.attempts });
    throw new DeliveryError("Outbox lease expired before the delivery request could be sent", true);
  }
  const response = await fetch(`${target}${request.path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(request.body), signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    if (request.target === "gateway") {
      // The Gateway's error body carries a machine-readable code next to its fixed detail text (Requirement 19).
      const errorBody = await response.json().catch(() => null);
      const gatewayCode = typeof errorBody?.code === "string" ? errorBody.code : undefined;
      // Retrying an uncertain command could run it twice; the Gateway also refuses it (409) until an operator resolves it.
      if (gatewayCode === "command_outcome_uncertain") throw new DeliveryError(`Runtime gateway returned ${response.status} command_outcome_uncertain`, false, { gatewayCode, outcomeUncertain: true });
      // Nothing took effect, but the cause (for example a missing session) does not go away by retrying.
      if (gatewayCode === "command_failed_definite") throw new DeliveryError(`Runtime gateway returned ${response.status} command_failed_definite`, false, { gatewayCode });
      throw new DeliveryError(`Runtime gateway returned ${response.status}${gatewayCode ? ` ${gatewayCode}` : ""}`, response.status === 429 || response.status >= 500, { gatewayCode });
    }
    throw new DeliveryError(`Channel adapter returned ${response.status}`, response.status === 429 || response.status >= 500);
  }
  if (request.target === "gateway" && event.event_type === "media.dispatch") {
    const payload = await response.json().catch(() => null);
    return { mediaReceipt: assertMediaGatewayReceipt(payload, event.payload.command, event.payload.sessionId, event.created_at) };
  }
  if (request.target !== "channel-adapter") return {};
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || typeof payload.providerMessageId !== "string") throw new DeliveryError("Channel adapter returned an invalid delivery receipt", false);
  return { providerMessageId: payload.providerMessageId };
}

function deliveryRequest(event) {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) throw new Error("Invalid outbox payload");
  if (event.event_type === "media.dispatch") {
    const { sessionId, command } = event.payload;
    if (!sessionIdValid(sessionId) || !command || typeof command !== "object" || Array.isArray(command)) throw new Error("Invalid media dispatch payload");
    if (!commandIdValid(command.id) || !["start_program", "switch_to_fallback", "switch_to_human", "stop_program", "insert_program", "resume_program"].includes(command.type)) throw new Error("Invalid media command");
    const programSegmentId = command.payload?.programSegmentId;
    const runtimeScript = command.payload?.runtimeScript;
    const scriptSha256 = command.payload?.scriptSha256;
    if (command.type === "insert_program" && (!programSegmentIdValid(programSegmentId) || typeof runtimeScript !== "string" || runtimeScript.length < 1 || runtimeScript.length > 800 || typeof scriptSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(scriptSha256))) throw new Error("Invalid program insertion command");
    if (command.type === "start_program" && ((typeof runtimeScript === "string" && (!programSegmentIdValid(programSegmentId) || typeof scriptSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(scriptSha256))) || (runtimeScript === undefined && (programSegmentId || scriptSha256)))) throw new Error("Invalid program start command");
    if (command.type === "resume_program" && ((typeof runtimeScript === "string" && (!programSegmentIdValid(programSegmentId) || typeof scriptSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(scriptSha256))) || (runtimeScript === undefined && (programSegmentId || scriptSha256)))) throw new Error("Invalid program resume command");
    if (typeof runtimeScript === "string" && createHash("sha256").update(runtimeScript).digest("hex") !== scriptSha256) throw new Error("Program script hash does not match frozen script");
    if (command.type !== "start_program" && command.type !== "insert_program" && command.type !== "resume_program" && (programSegmentId || runtimeScript || scriptSha256)) throw new Error("Invalid media command payload");
    // Gateway synthesizes the script with this frozen approved voice (CosyVoice) and rejects scripts without it.
    const runtimeVoiceId = command.payload?.runtimeVoiceId;
    const voiceChecksum = command.payload?.voiceChecksum;
    if ((runtimeVoiceId !== undefined && !runtimeVoiceIdValid(runtimeVoiceId)) || (voiceChecksum !== undefined && !voiceChecksumValid(voiceChecksum))) throw new Error("Invalid program voice binding");
    if (typeof runtimeScript !== "string" && (runtimeVoiceId !== undefined || voiceChecksum !== undefined)) throw new Error("Invalid media command payload");
    return { target: "gateway", path: "/v1/media", body: { command_id: command.id, session_id: sessionId, action: command.type, ...(programSegmentId ? { program_segment_id: programSegmentId } : {}), ...(runtimeScript ? { program_script: runtimeScript } : {}), ...(scriptSha256 ? { script_sha256: scriptSha256 } : {}), ...(runtimeVoiceId ? { runtime_voice_id: runtimeVoiceId } : {}), ...(voiceChecksum ? { voice_checksum: voiceChecksum } : {}) } };
  }
  if (event.event_type === "speech.dispatch") {
    const { sessionId, command } = event.payload;
    if (!sessionIdValid(sessionId) || !command || typeof command !== "object" || Array.isArray(command)) throw new Error("Invalid speech dispatch payload");
    if (!commandIdValid(command.id) || !sessionIdValid(command.runId) || typeof command.text !== "string" || command.text.length < 1 || command.text.length > 800) throw new Error("Invalid speech command");
    if (typeof command.voice !== "string" || command.voice.length < 1 || command.voice.length > 128 || typeof command.interrupt !== "boolean") throw new Error("Invalid speech options");
    if (!sessionIdValid(command.productVersionId) || !Number.isInteger(command.productRevision) || command.productRevision < 1) throw new Error("Invalid speech evidence");
    if (command.voiceChecksum !== undefined && !voiceChecksumValid(command.voiceChecksum)) throw new Error("Invalid speech voice binding");
    return { target: "gateway", path: "/v1/speak", body: { command_id: command.id, session_id: sessionId, text: command.text, interrupt: command.interrupt, voice: command.voice, ...(command.voiceChecksum ? { voice_checksum: command.voiceChecksum } : {}), provider: "cosyvoice" } };
  }
  if (event.event_type === "channel.reply.dispatch") {
    const { replyId, runId, interactionId, channelConnectionId, body, bodySha256, idempotencyKey } = event.payload;
    if (![replyId, runId, interactionId, channelConnectionId].every(sessionIdValid) || !commandIdValid(idempotencyKey) || typeof body !== "string" || body.length < 1 || body.length > 1000 || typeof bodySha256 !== "string" || !/^[a-f0-9]{64}$/i.test(bodySha256)) throw new Error("Invalid channel reply dispatch payload");
    return { target: "channel-adapter", path: "/v1/replies", body: { tenantId: event.tenant_id, replyId, runId, interactionId, channelConnectionId, body, bodySha256, idempotencyKey } };
  }
  throw new Error(`Unsupported event type: ${event.event_type}`);
}

function commandIdValid(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }
function sessionIdValid(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }
function runtimeVoiceIdValid(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }
function voiceChecksumValid(value) { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/i.test(value); }
function programSegmentIdValid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
// The request may not outlive the claim's lease (minus a safety margin), even when the Gateway timeout is longer.
function deliveryTimeoutMs(event) {
  return Math.min(gatewayRequestTimeoutMs, Math.floor(event.claimStartedAt + leaseMs - leaseMarginMs - performance.now()));
}

// A retried command gets the Gateway's cached receipt of its first acceptance, which can be much older than this
// attempt. It is accepted if it binds the command and was issued after the event was created.
function assertMediaGatewayReceipt(value, command, sessionId, eventCreatedAt) {
  if (!value || typeof value !== "object" || value.accepted !== true || !value.receipt || typeof value.receipt !== "object") throw new DeliveryError("Runtime gateway returned an invalid media receipt", false);
  const receipt = value.receipt;
  const acceptedAt = typeof receipt.accepted_at === "string" ? Date.parse(receipt.accepted_at) : Number.NaN;
  const notBefore = new Date(eventCreatedAt).getTime() - RECEIPT_CLOCK_SKEW_MS;
  if (receipt.command_id !== command.id || receipt.session_id !== sessionId || receipt.action !== command.type || Number.isNaN(acceptedAt) || !(acceptedAt >= notBefore) || acceptedAt > Date.now() + RECEIPT_CLOCK_SKEW_MS) throw new DeliveryError("Runtime gateway receipt does not bind the media command", false);
  if (command.payload?.programSegmentId && receipt.program_segment_id !== command.payload.programSegmentId) throw new DeliveryError("Runtime gateway receipt does not bind the program segment", false);
  return receipt;
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
    const receipt = await deliver(event);
    await markDelivered(event, receipt);
    log("outbox.delivered", { eventId: event.id, attempts: event.attempts });
  } catch (error) {
    if (error instanceof LeaseLostError) return log("outbox.lease_lost", { eventId: event.id, attempts: event.attempts });
    // A transient failure after the downstream accepted the command (for example a database timeout while
    // recording it) is retried with the same command id; the Gateway and the channel adapter answer the retry
    // with the first result. A receipt that cannot be applied is not retried (ReceiptRejectedError).
    const message = error instanceof Error ? error.message : "runtime_dispatch_failed";
    let retry;
    try {
      retry = await markFailed(event, message, error instanceof DeliveryError ? error.retryable : true, { outcomeUncertain: error instanceof DeliveryError && error.outcomeUncertain, definite: error instanceof DeliveryError && error.gatewayCode === "command_failed_definite" });
    } catch (markError) {
      if (markError instanceof LeaseLostError) return log("outbox.lease_lost", { eventId: event.id, attempts: event.attempts });
      throw markError;
    }
    if (error instanceof DeliveryError && error.outcomeUncertain) log("outbox.outcome_uncertain", { eventId: event.id, attempts: event.attempts, error: message });
    log(retry.exhausted ? "outbox.exhausted" : "outbox.failed", { eventId: event.id, attempts: event.attempts, retryAfterMs: retry.retryAfterMs, error: message });
  }
}

// Independent of tick(): a delivery may block tick() for up to RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS, which used to
// push metering past a whole minute. Records are idempotent per run and minute, so overlapping workers and
// restarts do not double-count.
async function usageMeterLoop() {
  while (!stopping) {
    const startedAt = Date.now();
    try {
      const recorded = await meterLiveUsage();
      if (recorded) log("usage.live_minutes_recorded", { records: recorded });
    } catch (error) {
      log("usage.meter_failed", { error: error instanceof Error ? error.message : "unknown" });
    }
    await Promise.race([new Promise((resolve) => setTimeout(resolve, Math.max(1, usageMeterIntervalMs - (Date.now() - startedAt)))), stopped]);
  }
}

// Independent of tick() for the same reason as metering: a slow Gateway delivery must not delay welcomes and timed
// lines. Firings are idempotent per run, rule and trigger, so overlapping workers do not speak twice.
const ruleEvaluator = createInteractionRuleEvaluator({ tenantIds, inTenantTransaction, log, config: interactionRules, maxOutboxAttempts: maxAttempts });
async function interactionRuleLoop() {
  while (!stopping) {
    const startedAt = Date.now();
    try {
      const summary = await ruleEvaluator.runOnce();
      if (summary.recorded) log("interaction_rules.evaluated", summary);
    } catch (error) {
      log("interaction_rules.evaluation_failed", { error: error instanceof Error ? error.message : "unknown" });
    }
    await Promise.race([new Promise((resolve) => setTimeout(resolve, Math.max(1, interactionRules.pollMs - (Date.now() - startedAt)))), stopped]);
  }
}

let stopping = false;
let nextSchedulerPollAt = 0;
let nextOutboxTenantCursor = 0;
let nextSchedulerTenantCursor = 0;
let nextWatchdogPollAt = 0;
let nextWatchdogTenantCursor = 0;
let signalStopped;
const stopped = new Promise((resolve) => { signalStopped = resolve; });
let lastSuccessfulTickAt = null;
let lastTickError = null;
const healthServer = http.createServer(async (request, response) => {
  if (request.method !== "GET" || request.url !== "/healthz") return json(response, 404, { ok: false, error: "not_found" });
  const tickFresh = lastSuccessfulTickAt !== null && Date.now() - lastSuccessfulTickAt <= Math.max(pollMs * 3, 15_000);
  try {
    await pool.query("select 1");
    return json(response, tickFresh && !stopping ? 200 : 503, { ok: tickFresh && !stopping, lastSuccessfulTickAt: lastSuccessfulTickAt === null ? null : new Date(lastSuccessfulTickAt).toISOString(), lastError: lastTickError });
  } catch {
    return json(response, 503, { ok: false, lastSuccessfulTickAt: lastSuccessfulTickAt === null ? null : new Date(lastSuccessfulTickAt).toISOString(), lastError: lastTickError ?? "database_unavailable" });
  }
});
healthServer.listen(healthPort, "0.0.0.0", () => log("worker.health_listening", { port: healthPort }));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; signalStopped(); });
log("worker.started", { gatewayRequestTimeoutMs, databaseTimeoutMs, pollMs, schedulerPollMs, schedulerBatchSize, watchdogPollMs, watchdogBatchSize, usageMeterPollMs: usageMeterIntervalMs, maxTelemetryAgeSeconds, maxAttempts, leaseSeconds, retryBaseMs, retryMaxMs, healthPort, interactionRules });
const metering = usageMeterLoop();
const ruleEvaluation = interactionRules.enabled ? interactionRuleLoop() : Promise.resolve();
while (!stopping) {
  try { await tick(); lastSuccessfulTickAt = Date.now(); lastTickError = null; } catch (error) { lastTickError = error instanceof Error ? error.message : "unknown"; log("worker.error", { error: lastTickError }); }
  const schedulerWaitMs = Math.max(1, nextSchedulerPollAt - Date.now());
  const watchdogWaitMs = Math.max(1, nextWatchdogPollAt - Date.now());
  await Promise.race([new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, schedulerWaitMs, watchdogWaitMs))), stopped]);
}
await metering;
await ruleEvaluation;
await new Promise((resolve) => healthServer.close(resolve));
await pool.end();
log("worker.stopped");

function json(response, status, value) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
