import { createMediaCommand, type MediaCommand } from "@/lib/media-protocol";
import { createSpeechCommand, type SpeechCommand } from "@/lib/speech-protocol";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { assertLiveRunAccess, hasRestrictedMembership } from "@/lib/control-plane/run-access";
import { dispatchMediaCommand, dispatchSpeechCommand } from "@/lib/runtime-gateway";
import { databasePool, withTenantTransaction } from "@/lib/database";
import type { PoolClient } from "pg";

export type OutboxState = "pending" | "delivering" | "delivered" | "failed" | "cancelled";
export type MediaOutboxEvent = { id: string; tenantId: string; type: "media.dispatch"; state: OutboxState; attempts: number; sessionId: string; command: MediaCommand; createdAt: string; deliveredAt?: string; lastError?: string };
export type SpeechOutboxEvent = { id: string; tenantId: string; type: "speech.dispatch"; state: OutboxState; attempts: number; sessionId: string; command: SpeechCommand; createdAt: string; deliveredAt?: string; lastError?: string };
export type ChannelReplyOutboxEvent = { id: string; tenantId: string; type: "channel.reply.dispatch"; state: OutboxState; attempts: number; replyId: string; runId: string; interactionId: string; channelConnectionId: string; bodySha256: string; createdAt: string; deliveredAt?: string; lastError?: string };
export type RuntimeOutboxEvent = MediaOutboxEvent | SpeechOutboxEvent | ChannelReplyOutboxEvent;
export type SpeechEnqueueResult = { event: SpeechOutboxEvent; duplicate: boolean };

type OutboxStore = { events: Map<string, RuntimeOutboxEvent>; speechCommandEvents: Map<string, string> };
type PersistentOutboxRow = { id: string; tenant_id: string; event_type: RuntimeOutboxEvent["type"]; state: OutboxState; attempts: number; payload: unknown; created_at: Date | string; delivered_at: Date | string | null; last_error: string | null };
declare global { var shuzhirenOutboxStore: OutboxStore | undefined; }

const manualDeliveryLeaseSeconds = (() => {
  const configured = Number.parseInt(process.env.OUTBOX_LEASE_SECONDS ?? "60", 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 60;
})();
const outboxMaxAttempts = (() => {
  const configured = Number.parseInt(process.env.OUTBOX_MAX_ATTEMPTS ?? "6", 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 6;
})();

function outboxStore(): OutboxStore { globalThis.shuzhirenOutboxStore ??= { events: new Map(), speechCommandEvents: new Map() }; return globalThis.shuzhirenOutboxStore; }

export async function enqueueMediaCommand(context: RequestContext, input: Omit<MediaCommand, "id" | "issuedAt"> & { sessionId: string }): Promise<MediaOutboxEvent> {
  const command = createMediaCommand(input);
  if (!databasePool()) {
    const event: MediaOutboxEvent = { id: `outbox_${crypto.randomUUID()}`, tenantId: context.tenantId, type: "media.dispatch", state: "pending", attempts: 0, sessionId: input.sessionId, command, createdAt: new Date().toISOString() };
    outboxStore().events.set(event.id, event);
    return event;
  }

  return withTenantTransaction(context.tenantId, async (client) => enqueueMediaCommandInTransaction(client, context, command, input.sessionId));
}

export async function enqueueMediaCommandInTransaction(client: PoolClient, context: RequestContext, command: MediaCommand, sessionId: string): Promise<MediaOutboxEvent> {
  const result = await client.query<PersistentOutboxRow>(
    "insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload) values ($1, $2, $3, $4::uuid, $5::jsonb) returning id, tenant_id, event_type, state, attempts, payload, created_at, delivered_at, last_error",
    [context.tenantId, "media.dispatch", "live_run", command.runId, JSON.stringify({ sessionId, command })]
  );
  return persistentEvent(result.rows[0]) as MediaOutboxEvent;
}

export async function enqueueSpeechCommand(context: RequestContext, input: Omit<SpeechCommand, "id" | "issuedAt" | "interrupt"> & { sessionId: string; idempotencyKey: string }): Promise<SpeechEnqueueResult> {
  const { sessionId, ...commandInput } = input;
  const command = createSpeechCommand(commandInput);
  if (!databasePool()) {
    const activeStore = outboxStore();
    const existingId = activeStore.speechCommandEvents.get(`${context.tenantId}:${command.id}`);
    if (existingId) {
      const existing = activeStore.events.get(existingId);
      if (existing?.type === "speech.dispatch") {
        if (!sameSpeechCommand(existing.command, existing.sessionId, command, sessionId)) throw new Response("Speech idempotency key was already used with a different payload", { status: 409 });
        return { event: existing, duplicate: true };
      }
    }
    const event: SpeechOutboxEvent = { id: `outbox_${crypto.randomUUID()}`, tenantId: context.tenantId, type: "speech.dispatch", state: "pending", attempts: 0, sessionId, command, createdAt: new Date().toISOString() };
    activeStore.events.set(event.id, event);
    activeStore.speechCommandEvents.set(`${context.tenantId}:${command.id}`, event.id);
    return { event, duplicate: false };
  }
  return withTenantTransaction(context.tenantId, async (client) => enqueueSpeechCommandInTransaction(client, context, command, sessionId));
}

export async function enqueueSpeechCommandInTransaction(client: PoolClient, context: RequestContext, command: SpeechCommand, sessionId: string): Promise<SpeechEnqueueResult> {
  const result = await client.query<PersistentOutboxRow>(
    "insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload) values ($1, $2, $3, $4::uuid, $5::jsonb) on conflict do nothing returning id, tenant_id, event_type, state, attempts, payload, created_at, delivered_at, last_error",
    [context.tenantId, "speech.dispatch", "live_run", command.runId, JSON.stringify({ sessionId, command })]
  );
  if (result.rows[0]) return { event: persistentEvent(result.rows[0]) as SpeechOutboxEvent, duplicate: false };
  const existing = await client.query<PersistentOutboxRow>(
    "select id, tenant_id, event_type, state, attempts, payload, created_at, delivered_at, last_error from outbox_events where event_type = 'speech.dispatch' and payload #>> '{command,id}' = $1 order by created_at asc limit 1",
    [command.id]
  );
  const event = existing.rows[0] ? persistentEvent(existing.rows[0]) : null;
  if (!event || event.type !== "speech.dispatch") throw new Error("Speech outbox idempotency conflict could not be resolved");
  if (!sameSpeechCommand(event.command, event.sessionId, command, sessionId)) throw new Response("Speech idempotency key was already used with a different payload", { status: 409 });
  return { event, duplicate: true };
}

export async function getOutboxEvent(context: RequestContext, eventId: string) {
  if (!databasePool()) {
    const event = outboxStore().events.get(eventId);
    if (!event || event.tenantId !== context.tenantId) return null;
    await assertOutboxEventAccess(context, event);
    return event;
  }
  if (!isUuid(eventId)) return null;
  const event = await withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentOutboxRow>("select id, tenant_id, event_type, state, attempts, payload, created_at, delivered_at, last_error from outbox_events where id = $1", [eventId]);
    return result.rows[0] ? persistentEvent(result.rows[0]) : null;
  });
  if (event) await assertOutboxEventAccess(context, event);
  return event;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function listOutboxEvents(context: RequestContext) {
  if (!databasePool()) return [...outboxStore().events.values()].filter((event) => event.tenantId === context.tenantId).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentOutboxRow>("select event.id, event.tenant_id, event.event_type, event.state, event.attempts, event.payload, event.created_at, event.delivered_at, event.last_error from outbox_events event where not $1::boolean or exists (select 1 from live_runs r where ((event.aggregate_type = 'live_run' and event.aggregate_id = r.id) or (event.event_type = 'channel.reply.dispatch' and event.payload ->> 'runId' = r.id::text)) and exists (select 1 from membership_resource_scopes scope where scope.membership_id = $2::uuid and ((scope.resource_type = 'live_run' and scope.resource_id = r.id) or (scope.resource_type = 'channel_connection' and scope.resource_id = r.channel_connection_id)))) order by event.created_at desc limit 100", [hasRestrictedMembership(context), context.membershipId ?? null]);
    return result.rows.map(persistentEvent);
  });
}

export async function deliverOutboxEvent(context: RequestContext, eventId: string) {
  const existing = await getOutboxEvent(context, eventId);
  if (!existing) throw new Response("Outbox event not found", { status: 404 });
  if (existing.type === "channel.reply.dispatch") throw new Response("Channel replies are delivered only by the runtime worker", { status: 409 });
  const claimed = await claimOutboxEvent(context, eventId);
  if (claimed.duplicate) {
    if (claimed.event.type === "channel.reply.dispatch") throw new Response("Channel replies are delivered only by the runtime worker", { status: 409 });
    return claimed;
  }
  if (claimed.event.type === "channel.reply.dispatch") throw new Response("Channel replies are delivered only by the runtime worker", { status: 409 });
  // The claim set state = 'delivering', attempts + 1 and available_at = now() + lease. (id, attempts) identifies
  // this claim: the request is cut off before the lease ends, so the worker can only reclaim the event after this
  // request is over, and both writes below only apply while the event is still held by this claim.
  const timeoutMs = Math.floor(claimed.claimStartedAt + manualDeliveryLeaseMs - manualDeliveryLeaseMarginMs - performance.now());
  let result;
  try {
    if (timeoutMs < 100) throw new Error("outbox delivery lease budget exhausted before dispatch");
    const options = { timeoutMs, notBefore: claimed.event.createdAt };
    result = claimed.event.type === "media.dispatch"
      ? await dispatchMediaCommand(claimed.event.command, claimed.event.sessionId, options)
      : await dispatchSpeechCommand(claimed.event.command, claimed.event.sessionId, options);
  } catch (error) {
    await markFailed(context, claimed.event, error instanceof Error ? error.message : "runtime_dispatch_failed");
    throw error;
  }
  // The Gateway accepted the command. If recording that fails, the event must not become 'failed': that would
  // let the next manual or worker attempt send the accepted command again before the lease ends. It stays
  // 'delivering' with the claim's available_at; after the lease the worker resends the same command id and
  // records the Gateway's receipt of the first acceptance.
  try {
    const event = await markDelivered(context, claimed.event, result);
    return { event, duplicate: false as const, result };
  } catch (error) {
    throw new OutboxDeliveryStateUnconfirmedError(claimed.event.id, error);
  }
}
export class OutboxDeliveryStateUnconfirmedError extends Error {
  readonly code = "delivery_accepted_state_unconfirmed";
  constructor(readonly eventId: string, cause: unknown) { super("Runtime gateway accepted the command but the delivery state was not recorded", { cause }); }
}
class OutboxLeaseLostError extends Error {}
const manualDeliveryLeaseMs = manualDeliveryLeaseSeconds * 1000;
const manualDeliveryLeaseMarginMs = Math.min(2000, Math.floor(manualDeliveryLeaseMs / 10));

async function claimOutboxEvent(context: RequestContext, eventId: string): Promise<{ event: RuntimeOutboxEvent; duplicate: true } | { event: RuntimeOutboxEvent; duplicate: false; claimStartedAt: number }> {
  // The database's now() that sets the lease is not earlier than this monotonic reading.
  const claimStartedAt = performance.now();
  if (!databasePool()) {
    const event = outboxStore().events.get(eventId);
    if (!event || event.tenantId !== context.tenantId) throw new Response("Outbox event not found", { status: 404 });
    await assertOutboxEventAccess(context, event);
    if (event.state === "delivered") return { event, duplicate: true };
    if (event.state === "delivering") throw new Response("Outbox event is already delivering", { status: 409 });
    event.state = "delivering";
    event.attempts += 1;
    return { event, duplicate: false, claimStartedAt };
  }
  if (!isUuid(eventId)) throw new Response("Outbox event not found", { status: 404 });

  return withTenantTransaction(context.tenantId, async (client) => {
    const selected = await client.query<PersistentOutboxRow>("select event.id, event.tenant_id, event.event_type, event.state, event.attempts, event.payload, event.created_at, event.delivered_at, event.last_error from outbox_events event where event.id = $1 and (not $2::boolean or exists (select 1 from live_runs r where ((event.aggregate_type = 'live_run' and event.aggregate_id = r.id) or (event.event_type = 'channel.reply.dispatch' and event.payload ->> 'runId' = r.id::text)) and exists (select 1 from membership_resource_scopes scope where scope.membership_id = $3::uuid and ((scope.resource_type = 'live_run' and scope.resource_id = r.id) or (scope.resource_type = 'channel_connection' and scope.resource_id = r.channel_connection_id))))) for update of event", [eventId, hasRestrictedMembership(context), context.membershipId ?? null]);
    if (!selected.rows[0]) throw new Response("Outbox event not found", { status: 404 });
    const current = persistentEvent(selected.rows[0]);
    if (current.state === "delivered") return { event: current, duplicate: true as const };
    if (current.state === "cancelled") throw new Response("Outbox event was cancelled", { status: 409 });
    if (current.state === "delivering") throw new Response("Outbox event is already delivering", { status: 409 });
    const updated = await client.query<PersistentOutboxRow>("update outbox_events set state = 'delivering', attempts = attempts + 1, last_error = null, available_at = now() + ($2 * interval '1 second') where id = $1 returning id, tenant_id, event_type, state, attempts, payload, created_at, delivered_at, last_error", [eventId, manualDeliveryLeaseSeconds]);
    return { event: persistentEvent(updated.rows[0]), duplicate: false as const, claimStartedAt };
  });
}

async function assertOutboxEventAccess(context: RequestContext, event: RuntimeOutboxEvent) {
  await assertLiveRunAccess(context, event.type === "channel.reply.dispatch" ? event.runId : event.command.runId);
}

async function markDelivered(context: RequestContext, input: RuntimeOutboxEvent, dispatchResult?: { provider?: unknown }) {
  if (!databasePool()) {
    const event = outboxStore().events.get(input.id);
    if (!event) throw new Error("Outbox event disappeared during delivery");
    event.state = "delivered";
    event.deliveredAt = new Date().toISOString();
    event.lastError = undefined;
    return event;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentOutboxRow>("update outbox_events set state = 'delivered', delivered_at = now(), last_error = null where id = $1 and state = 'delivering' and attempts = $2 returning id, tenant_id, event_type, state, attempts, payload, created_at, delivered_at, last_error", [input.id, input.attempts]);
    if (!result.rows[0]) throw new OutboxLeaseLostError("outbox lease lost before the delivery was recorded");
    const event = persistentEvent(result.rows[0]);
    if (event.type === "media.dispatch" && ["SCHEDULED_START", "START", "RECOVER"].includes(event.command.payload.controlAction)) {
      const promoted = await client.query(
        "update live_runs set state = 'LIVE', scheduled_start_event_id = null, updated_at = now() where id = $1 and state in ('ARMED', 'DEGRADED') and scheduled_start_event_id = $2",
        [event.command.runId, event.id]
      );
      if (promoted.rowCount && event.command.payload.programSegmentId) await applyActivationProgramReceipt(client, context, event, dispatchResult?.provider);
    }
    if (event.type === "media.dispatch" && event.command.payload.controlAction === "END") {
      await client.query(
        "update live_runs set state = 'ENDED', pending_media_event_id = null, updated_at = now() where id = $1 and state in ('LIVE', 'DEGRADED') and pending_media_event_id = $2",
        [event.command.runId, event.id]
      );
    }
    if (event.type === "media.dispatch" && (event.command.payload.controlAction === "INSERT_PROGRAM" || event.command.payload.controlAction === "ROLLBACK_PROGRAM")) {
      await applyProgramTransitionReceipt(client, context, event, dispatchResult?.provider);
    }
    return event;
  });
}

async function applyProgramTransitionReceipt(client: PoolClient, context: RequestContext, event: MediaOutboxEvent, provider: unknown) {
  const receipt = provider && typeof provider === "object" ? (provider as { receipt?: unknown }).receipt : undefined;
  if (!receipt || typeof receipt !== "object") throw new Error("Program transition receipt is missing");
  const payload = event.command.payload;
  const target = typeof payload.programSegmentId === "string" ? payload.programSegmentId : null;
  const source = typeof payload.sourceProgramSegmentId === "string" ? payload.sourceProgramSegmentId : null;
  const inserted = typeof payload.insertedProgramSegmentId === "string" ? payload.insertedProgramSegmentId : null;
  let updated;
  if (payload.controlAction === "INSERT_PROGRAM") {
    if (!target) throw new Error("Program insertion target is missing");
    updated = await client.query("update live_runs set active_program_segment_id = $2::uuid, active_insert_source_segment_id = $3::uuid, active_insert_program_segment_id = $2::uuid, pending_program_transition_event_id = null, updated_at = now() where id = $1 and pending_program_transition_event_id = $4::uuid returning id", [event.command.runId, target, source, event.id]);
  } else {
    if (!inserted) throw new Error("Program rollback insertion reference is missing");
    updated = await client.query("update live_runs set active_program_segment_id = $2::uuid, active_insert_source_segment_id = null, active_insert_program_segment_id = null, pending_program_transition_event_id = null, updated_at = now() where id = $1 and active_insert_program_segment_id = $3::uuid and pending_program_transition_event_id = $4::uuid returning id", [event.command.runId, target, inserted, event.id]);
  }
  if (!updated.rows[0]) throw new Error("Program transition cursor was not pending for this receipt");
  const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
  await client.query(`insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
    values ($1, $2, 'live_program.transition_accepted', 'live_run', $3::uuid, $3, $4::jsonb)`, [context.tenantId, actor.rows[0].id, event.command.runId, JSON.stringify({ outboxEventId: event.id, commandId: event.command.id, action: payload.controlAction, programSegmentId: target, sourceProgramSegmentId: source, receipt })]);
}

async function applyActivationProgramReceipt(client: PoolClient, context: RequestContext, event: MediaOutboxEvent, provider: unknown) {
  const receipt = provider && typeof provider === "object" ? (provider as { receipt?: unknown }).receipt : undefined;
  const segmentId = event.command.payload.programSegmentId;
  if (!receipt || typeof receipt !== "object" || typeof segmentId !== "string") throw new Error("Program activation receipt is missing");
  const updated = await client.query("update live_runs set active_program_segment_id = $2::uuid, updated_at = now() where id = $1 and state = 'LIVE' returning id", [event.command.runId, segmentId]);
  if (!updated.rows[0]) throw new Error("Program activation cursor was not available for this receipt");
  const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
  await client.query(`insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
    values ($1, $2, 'live_program.activation_accepted', 'live_run', $3::uuid, $3, $4::jsonb)`, [context.tenantId, actor.rows[0].id, event.command.runId, JSON.stringify({ outboxEventId: event.id, commandId: event.command.id, action: event.command.payload.controlAction, programSegmentId: segmentId, receipt })]);
}

async function markFailed(context: RequestContext, input: RuntimeOutboxEvent, lastError: string) {
  if (!databasePool()) {
    const event = outboxStore().events.get(input.id);
    if (event) { event.state = "failed"; event.lastError = lastError; }
    return;
  }
  await withTenantTransaction(context.tenantId, async (client) => {
    // Fenced like markDelivered: once the lease was taken over, the new holder owns the event's state.
    const fenced = await client.query("update outbox_events set state = 'failed', last_error = $2 where id = $1 and state = 'delivering' and attempts = $3", [input.id, lastError, input.attempts]);
    if (fenced.rowCount !== 1) return;
    if (input.attempts >= outboxMaxAttempts) await openDeliveryExhaustedAlert(client, context, input, lastError);
  });
}

async function openDeliveryExhaustedAlert(client: PoolClient, context: RequestContext, event: RuntimeOutboxEvent, lastError: string) {
  if (event.type === "channel.reply.dispatch") return;
  const severity = event.type === "media.dispatch" ? "critical" : "warning";
  const code = "runtime_command_delivery_exhausted";
  const existing = await client.query<{ id: string }>("select id from runtime_alerts where live_run_id = $1 and code = $2 and status = 'open' for update", [event.command.runId, code]);
  if (existing.rows[0]) return;
  const error = String(lastError).replace(/[\r\n\t]+/g, " ").slice(0, 500);
  const opened = await client.query<{ id: string }>(
    "insert into runtime_alerts (tenant_id, live_run_id, severity, code, message, status) values ($1, $2, $3::alert_severity, $4, $5, 'open') on conflict (tenant_id, live_run_id, code) where (status = 'open') do nothing returning id",
    [context.tenantId, event.command.runId, severity, code, `运行时 ${event.type} 指令在 ${event.attempts} 次尝试后仍未送达：${error}`]
  );
  if (!opened.rows[0]) return;
  const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
  await client.query(
    `insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
     values ($1, $2, 'runtime_command.delivery_exhausted', 'runtime_alert', $3::uuid, $3, $4::jsonb)`,
    [context.tenantId, actor.rows[0].id, opened.rows[0].id, JSON.stringify({ runId: event.command.runId, outboxEventId: event.id, eventType: event.type, attempts: event.attempts, severity, deliveryMode: "manual" })]
  );
}

function persistentEvent(row: PersistentOutboxRow): RuntimeOutboxEvent {
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) as Record<string, unknown> : row.payload as Record<string, unknown>;
  const base = { id: row.id, tenantId: row.tenant_id, state: row.state, attempts: row.attempts, createdAt: new Date(row.created_at).toISOString(), deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : undefined, lastError: row.last_error ?? undefined };
  if (row.event_type === "media.dispatch") return { ...base, type: row.event_type, sessionId: payload.sessionId as string, command: payload.command as MediaCommand };
  if (row.event_type === "speech.dispatch") return { ...base, type: row.event_type, sessionId: payload.sessionId as string, command: payload.command as SpeechCommand };
  if (row.event_type === "channel.reply.dispatch") {
    const replyId = requiredPayloadString(payload.replyId); const runId = requiredPayloadString(payload.runId); const interactionId = requiredPayloadString(payload.interactionId); const channelConnectionId = requiredPayloadString(payload.channelConnectionId); const bodySha256 = requiredPayloadString(payload.bodySha256);
    return { ...base, type: row.event_type, replyId, runId, interactionId, channelConnectionId, bodySha256 };
  }
  throw new Error(`Unsupported outbox event type: ${row.event_type}`);
}

function requiredPayloadString(value: unknown) { if (typeof value !== "string") throw new Error("Invalid channel reply outbox payload"); return value; }

function sameSpeechCommand(existing: SpeechCommand, existingSessionId: string, requested: SpeechCommand, requestedSessionId: string) {
  return existing.id === requested.id
    && existing.runId === requested.runId
    && existing.traceId === requested.traceId
    && existing.text === requested.text
    && existing.voice === requested.voice
    && existing.interrupt === requested.interrupt
    && existing.productVersionId === requested.productVersionId
    && existing.productRevision === requested.productRevision
    && existingSessionId === requestedSessionId;
}
