import { createMediaCommand, type MediaCommand } from "@/lib/media-protocol";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { dispatchMediaCommand } from "@/lib/runtime-gateway";
import { databasePool, withTenantTransaction } from "@/lib/database";
import type { PoolClient } from "pg";

export type OutboxState = "pending" | "delivering" | "delivered" | "failed";
export type MediaOutboxEvent = { id: string; tenantId: string; type: "media.dispatch"; state: OutboxState; attempts: number; sessionId: string; command: MediaCommand; createdAt: string; deliveredAt?: string; lastError?: string };

type OutboxStore = { events: Map<string, MediaOutboxEvent> };
type PersistentOutboxRow = { id: string; tenant_id: string; event_type: "media.dispatch"; state: OutboxState; attempts: number; payload: unknown; created_at: Date | string; delivered_at: Date | string | null; last_error: string | null };
declare global { var shuzhirenOutboxStore: OutboxStore | undefined; }

function outboxStore(): OutboxStore { globalThis.shuzhirenOutboxStore ??= { events: new Map() }; return globalThis.shuzhirenOutboxStore; }

export async function enqueueMediaCommand(context: RequestContext, input: Omit<MediaCommand, "id" | "issuedAt"> & { sessionId: string }) {
  const command = createMediaCommand(input);
  if (!databasePool()) {
    const event: MediaOutboxEvent = { id: `outbox_${crypto.randomUUID()}`, tenantId: context.tenantId, type: "media.dispatch", state: "pending", attempts: 0, sessionId: input.sessionId, command, createdAt: new Date().toISOString() };
    outboxStore().events.set(event.id, event);
    return event;
  }

  return withTenantTransaction(context.tenantId, async (client) => enqueueMediaCommandInTransaction(client, context, command, input.sessionId));
}

export async function enqueueMediaCommandInTransaction(client: PoolClient, context: RequestContext, command: MediaCommand, sessionId: string) {
  const result = await client.query<PersistentOutboxRow>(
    "insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload) values ($1, $2, $3, $4::uuid, $5::jsonb) returning id, tenant_id, event_type, state, attempts, payload, created_at, delivered_at, last_error",
    [context.tenantId, "media.dispatch", "live_run", command.runId, JSON.stringify({ sessionId, command })]
  );
  return persistentEvent(result.rows[0]);
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
    const result = await dispatchMediaCommand(claimed.event.command, claimed.event.sessionId);
    const event = await markDelivered(context, claimed.event.id);
    return { event, duplicate: false as const, result };
  } catch (error) {
    await markFailed(context, claimed.event.id, error instanceof Error ? error.message : "runtime_dispatch_failed");
    throw error;
  }
}

async function claimOutboxEvent(context: RequestContext, eventId: string): Promise<{ event: MediaOutboxEvent; duplicate: true } | { event: MediaOutboxEvent; duplicate: false }> {
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
    const updated = await client.query<PersistentOutboxRow>("update outbox_events set state = 'delivering', attempts = attempts + 1, last_error = null where id = $1 returning id, tenant_id, event_type, state, attempts, payload, created_at, delivered_at, last_error", [eventId]);
    return { event: persistentEvent(updated.rows[0]), duplicate: false as const };
  });
}

async function markDelivered(context: RequestContext, eventId: string) {
  if (!databasePool()) {
    const event = outboxStore().events.get(eventId);
    if (!event) throw new Error("Outbox event disappeared during delivery");
    event.state = "delivered";
    event.deliveredAt = new Date().toISOString();
    event.lastError = undefined;
    return event;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentOutboxRow>("update outbox_events set state = 'delivered', delivered_at = now(), last_error = null where id = $1 returning id, tenant_id, event_type, state, attempts, payload, created_at, delivered_at, last_error", [eventId]);
    if (!result.rows[0]) throw new Error("Outbox event disappeared during delivery");
    return persistentEvent(result.rows[0]);
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

function persistentEvent(row: PersistentOutboxRow): MediaOutboxEvent {
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) as { sessionId: string; command: MediaCommand } : row.payload as { sessionId: string; command: MediaCommand };
  return { id: row.id, tenantId: row.tenant_id, type: row.event_type, state: row.state, attempts: row.attempts, sessionId: payload.sessionId, command: payload.command, createdAt: new Date(row.created_at).toISOString(), deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : undefined, lastError: row.last_error ?? undefined };
}
