import { createMediaCommand, type MediaCommand } from "@/lib/media-protocol";
import { createSpeechCommand, type SpeechCommand } from "@/lib/speech-protocol";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { dispatchMediaCommand, dispatchSpeechCommand } from "@/lib/runtime-gateway";
import { databasePool, withTenantTransaction } from "@/lib/database";
import type { PoolClient } from "pg";

export type OutboxState = "pending" | "delivering" | "delivered" | "failed";
export type MediaOutboxEvent = { id: string; tenantId: string; type: "media.dispatch"; state: OutboxState; attempts: number; sessionId: string; command: MediaCommand; createdAt: string; deliveredAt?: string; lastError?: string };
export type SpeechOutboxEvent = { id: string; tenantId: string; type: "speech.dispatch"; state: OutboxState; attempts: number; sessionId: string; command: SpeechCommand; createdAt: string; deliveredAt?: string; lastError?: string };
export type RuntimeOutboxEvent = MediaOutboxEvent | SpeechOutboxEvent;
export type SpeechEnqueueResult = { event: SpeechOutboxEvent; duplicate: boolean };

type OutboxStore = { events: Map<string, RuntimeOutboxEvent>; speechCommandEvents: Map<string, string> };
type PersistentOutboxRow = { id: string; tenant_id: string; event_type: RuntimeOutboxEvent["type"]; state: OutboxState; attempts: number; payload: unknown; created_at: Date | string; delivered_at: Date | string | null; last_error: string | null };
declare global { var shuzhirenOutboxStore: OutboxStore | undefined; }

const manualDeliveryLeaseSeconds = (() => {
  const configured = Number.parseInt(process.env.OUTBOX_LEASE_SECONDS ?? "60", 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 60;
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
  if (!databasePool()) { const event = outboxStore().events.get(eventId); return event?.tenantId === context.tenantId ? event : null; }
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentOutboxRow>("select id, tenant_id, event_type, state, attempts, payload, created_at, delivered_at, last_error from outbox_events where id = $1", [eventId]);
    return result.rows[0] ? persistentEvent(result.rows[0]) : null;
  });
}

export async function listOutboxEvents(context: RequestContext) {
  if (!databasePool()) return [...outboxStore().events.values()].filter((event) => event.tenantId === context.tenantId).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentOutboxRow>("select id, tenant_id, event_type, state, attempts, payload, created_at, delivered_at, last_error from outbox_events order by created_at desc limit 100");
    return result.rows.map(persistentEvent);
  });
}

export async function deliverOutboxEvent(context: RequestContext, eventId: string) {
  const claimed = await claimOutboxEvent(context, eventId);
  if (claimed.duplicate) return claimed;
  try {
    const result = claimed.event.type === "media.dispatch"
      ? await dispatchMediaCommand(claimed.event.command, claimed.event.sessionId)
      : await dispatchSpeechCommand(claimed.event.command, claimed.event.sessionId);
    const event = await markDelivered(context, claimed.event);
    return { event, duplicate: false as const, result };
  } catch (error) {
    await markFailed(context, claimed.event.id, error instanceof Error ? error.message : "runtime_dispatch_failed");
    throw error;
  }
}

async function claimOutboxEvent(context: RequestContext, eventId: string): Promise<{ event: RuntimeOutboxEvent; duplicate: true } | { event: RuntimeOutboxEvent; duplicate: false }> {
  if (!databasePool()) {
    const event = outboxStore().events.get(eventId);
    if (!event || event.tenantId !== context.tenantId) throw new Response("Outbox event not found", { status: 404 });
    if (event.state === "delivered") return { event, duplicate: true };
    if (event.state === "delivering") throw new Response("Outbox event is already delivering", { status: 409 });
    event.state = "delivering";
    event.attempts += 1;
    return { event, duplicate: false };
  }

  return withTenantTransaction(context.tenantId, async (client) => {
    const selected = await client.query<PersistentOutboxRow>("select id, tenant_id, event_type, state, attempts, payload, created_at, delivered_at, last_error from outbox_events where id = $1 for update", [eventId]);
    if (!selected.rows[0]) throw new Response("Outbox event not found", { status: 404 });
    const current = persistentEvent(selected.rows[0]);
    if (current.state === "delivered") return { event: current, duplicate: true as const };
    if (current.state === "delivering") throw new Response("Outbox event is already delivering", { status: 409 });
    const updated = await client.query<PersistentOutboxRow>("update outbox_events set state = 'delivering', attempts = attempts + 1, last_error = null, available_at = now() + ($2 * interval '1 second') where id = $1 returning id, tenant_id, event_type, state, attempts, payload, created_at, delivered_at, last_error", [eventId, manualDeliveryLeaseSeconds]);
    return { event: persistentEvent(updated.rows[0]), duplicate: false as const };
  });
}

async function markDelivered(context: RequestContext, input: RuntimeOutboxEvent) {
  if (!databasePool()) {
    const event = outboxStore().events.get(input.id);
    if (!event) throw new Error("Outbox event disappeared during delivery");
    event.state = "delivered";
    event.deliveredAt = new Date().toISOString();
    event.lastError = undefined;
    return event;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentOutboxRow>("update outbox_events set state = 'delivered', delivered_at = now(), last_error = null where id = $1 returning id, tenant_id, event_type, state, attempts, payload, created_at, delivered_at, last_error", [input.id]);
    if (!result.rows[0]) throw new Error("Outbox event disappeared during delivery");
    const event = persistentEvent(result.rows[0]);
    if (event.type === "media.dispatch" && ["SCHEDULED_START", "START", "RECOVER"].includes(event.command.payload.controlAction)) {
      await client.query(
        "update live_runs set state = 'LIVE', scheduled_start_event_id = null, updated_at = now() where id = $1 and state in ('ARMED', 'DEGRADED') and scheduled_start_event_id = $2",
        [event.command.runId, event.id]
      );
    }
    if (event.type === "media.dispatch" && event.command.payload.controlAction === "END") {
      await client.query(
        "update live_runs set state = 'ENDED', pending_media_event_id = null, updated_at = now() where id = $1 and state in ('LIVE', 'DEGRADED') and pending_media_event_id = $2",
        [event.command.runId, event.id]
      );
    }
    return event;
  });
}

async function markFailed(context: RequestContext, eventId: string, lastError: string) {
  if (!databasePool()) {
    const event = outboxStore().events.get(eventId);
    if (event) { event.state = "failed"; event.lastError = lastError; }
    return;
  }
  await withTenantTransaction(context.tenantId, async (client) => { await client.query("update outbox_events set state = 'failed', last_error = $2 where id = $1", [eventId, lastError]); });
}

function persistentEvent(row: PersistentOutboxRow): RuntimeOutboxEvent {
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) as { sessionId: string; command: MediaCommand | SpeechCommand } : row.payload as { sessionId: string; command: MediaCommand | SpeechCommand };
  const base = { id: row.id, tenantId: row.tenant_id, state: row.state, attempts: row.attempts, sessionId: payload.sessionId, createdAt: new Date(row.created_at).toISOString(), deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : undefined, lastError: row.last_error ?? undefined };
  if (row.event_type === "media.dispatch") return { ...base, type: row.event_type, command: payload.command as MediaCommand };
  if (row.event_type === "speech.dispatch") return { ...base, type: row.event_type, command: payload.command as SpeechCommand };
  throw new Error(`Unsupported outbox event type: ${row.event_type}`);
}

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
