import type { RequestContext } from "@/lib/control-plane/auth-context";
import { recordAuditEvent, recordAuditEventInTransaction } from "@/lib/audit";
import { listProducts } from "@/lib/catalog";
import { assertLiveRunAccess } from "@/lib/control-plane/run-access";
import { getRun } from "@/lib/control-plane/store";
import { databasePool, withTenantTransaction } from "@/lib/database";

export const commerceEventTypes = ["view", "product_click", "add_to_cart", "order_paid", "refund"] as const;
export type CommerceEventType = typeof commerceEventTypes[number];
export type CommerceEvent = { id: string; tenantId: string; runId: string; channelConnectionId: string; externalEventId: string; eventType: CommerceEventType; occurredAt: string; orderReference?: string; amountCents: number; quantity: number; currency: "CNY" };
export type CommerceSummary = { runId: string; views: number; productClicks: number; addToCart: number; paidOrders: number; paidUnits: number; refunds: number; grossPaidCents: number; refundedCents: number; netPaidCents: number; unitCostCents: number | null; productCostCents: number | null; contributionMarginCents: number | null; viewToCartRate: number | null; viewToPaidRate: number | null; refundRate: number | null };
export type CreateCommerceEventInput = { runId: string; channelConnectionId: string; externalEventId: string; eventType: CommerceEventType; occurredAt?: string; orderReference?: string; amountCents?: number; quantity?: number };

type PersistentCommerceRow = { id: string; tenant_id: string; live_run_id: string; channel_connection_id: string; external_event_id: string; event_type: CommerceEventType; occurred_at: Date | string; order_reference: string | null; amount_cents: number | string; quantity: number | string; currency: string };
type CommerceStore = { events: Map<string, CommerceEvent> };

declare global { var shuzhirenCommerceStore: CommerceStore | undefined; }

function commerceStore() {
  globalThis.shuzhirenCommerceStore ??= { events: new Map() };
  return globalThis.shuzhirenCommerceStore;
}

export async function createChannelCommerceEvent(context: RequestContext, input: CreateCommerceEventInput): Promise<CommerceEvent & { duplicate?: boolean }> {
  const normalized = normalizeInput(input);
  if (!databasePool()) {
    const key = `${context.tenantId}:${normalized.channelConnectionId}:${normalized.externalEventId}`;
    const existing = commerceStore().events.get(key);
    if (existing) {
      if (!sameCommerceEvent(existing, normalized)) throw new Response("External commerce event id was already used with different content", { status: 409 });
      return { ...existing, duplicate: true };
    }
    const event: CommerceEvent = { id: `commerce_${crypto.randomUUID()}`, tenantId: context.tenantId, ...normalized };
    commerceStore().events.set(key, event);
    if (isFinancialEvent(event.eventType)) await recordCommerceAudit(context, event);
    return event;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentCommerceRow>(
      `insert into commerce_events (tenant_id, live_run_id, channel_connection_id, external_event_id, event_type, occurred_at, order_reference, amount_cents, quantity)
       values ($1, $2, $3, $4, $5::commerce_event_type, $6, $7, $8, $9)
       on conflict (tenant_id, channel_connection_id, external_event_id) do nothing
       returning id, tenant_id, live_run_id, channel_connection_id, external_event_id, event_type, occurred_at, order_reference, amount_cents, quantity, currency`,
      [context.tenantId, normalized.runId, normalized.channelConnectionId, normalized.externalEventId, normalized.eventType, normalized.occurredAt, normalized.orderReference ?? null, normalized.amountCents, normalized.quantity]
    );
    if (result.rows[0]) {
      const event = persistentCommerceEvent(result.rows[0]);
      if (isFinancialEvent(event.eventType)) await recordCommerceAudit(context, event, client);
      return event;
    }
    const existing = await client.query<PersistentCommerceRow>(
      `select id, tenant_id, live_run_id, channel_connection_id, external_event_id, event_type, occurred_at, order_reference, amount_cents, quantity, currency
       from commerce_events where channel_connection_id = $1 and external_event_id = $2`,
      [normalized.channelConnectionId, normalized.externalEventId]
    );
    if (!existing.rows[0]) throw new Error("Commerce event idempotency conflict could not be resolved");
    const event = persistentCommerceEvent(existing.rows[0]);
    if (!sameCommerceEvent(event, normalized)) throw new Response("External commerce event id was already used with different content", { status: 409 });
    return { ...event, duplicate: true };
  });
}

export async function getCommerceSummary(context: RequestContext, runId: string): Promise<CommerceSummary> {
  await assertLiveRunAccess(context, runId);
  if (!databasePool()) return summarizeCommerceEvents(runId, [...commerceStore().events.values()].filter((event) => event.tenantId === context.tenantId && event.runId === runId), await unitCostForDemoRun(context, runId));
  return withTenantTransaction(context.tenantId, async (client) => {
    const [result, cost] = await Promise.all([
      client.query<{ event_type: CommerceEventType; count: string; amount_cents: string; quantity: string }>(
      `select event_type, count(*)::text as count, coalesce(sum(amount_cents), 0)::text as amount_cents, coalesce(sum(quantity), 0)::text as quantity
       from commerce_events where live_run_id = $1 group by event_type`,
      [runId]),
      client.query<{ unit_cost_cents: string | null }>(`select product_versions.facts ->> 'unitCostCent' as unit_cost_cents from live_runs join product_versions on product_versions.id = live_runs.product_version_id where live_runs.id = $1`, [runId])
    ]);
    return summarizeCommerceGroups(runId, result.rows, numericCost(cost.rows[0]?.unit_cost_cents));
  });
}

function normalizeInput(input: CreateCommerceEventInput): Omit<CommerceEvent, "id" | "tenantId"> {
  const amountCents = input.amountCents ?? 0;
  const quantity = input.quantity ?? (input.eventType === "order_paid" ? 1 : 0);
  const occurredAt = input.occurredAt && !Number.isNaN(Date.parse(input.occurredAt)) ? new Date(input.occurredAt).toISOString() : new Date().toISOString();
  return { runId: input.runId, channelConnectionId: input.channelConnectionId, externalEventId: input.externalEventId, eventType: input.eventType, occurredAt, orderReference: input.orderReference?.trim() || undefined, amountCents, quantity, currency: "CNY" };
}

function sameCommerceEvent(event: CommerceEvent, input: Omit<CommerceEvent, "id" | "tenantId">) {
  return event.runId === input.runId && event.channelConnectionId === input.channelConnectionId && event.externalEventId === input.externalEventId && event.eventType === input.eventType && event.orderReference === input.orderReference && event.amountCents === input.amountCents && event.quantity === input.quantity;
}

function isFinancialEvent(eventType: CommerceEventType) { return eventType === "order_paid" || eventType === "refund"; }

async function recordCommerceAudit(context: RequestContext, event: CommerceEvent, client?: import("pg").PoolClient) {
  const record = client ? (input: Parameters<typeof recordAuditEvent>[1]) => recordAuditEventInTransaction(client, context, input) : (input: Parameters<typeof recordAuditEvent>[1]) => recordAuditEvent(context, input);
  await record({ type: `commerce_event.${event.eventType}`, resource: "commerce_event", resourceId: event.id, detail: { runId: event.runId, channelConnectionId: event.channelConnectionId, amountCents: event.amountCents, quantity: event.quantity, currency: event.currency, externalEventId: event.externalEventId } });
}

function persistentCommerceEvent(row: PersistentCommerceRow): CommerceEvent {
  return { id: row.id, tenantId: row.tenant_id, runId: row.live_run_id, channelConnectionId: row.channel_connection_id, externalEventId: row.external_event_id, eventType: row.event_type, occurredAt: new Date(row.occurred_at).toISOString(), orderReference: row.order_reference ?? undefined, amountCents: Number(row.amount_cents), quantity: Number(row.quantity), currency: "CNY" };
}

function summarizeCommerceEvents(runId: string, events: CommerceEvent[], unitCostCents: number | null): CommerceSummary {
  return summarizeCommerceGroups(runId, commerceEventTypes.map((eventType) => ({ event_type: eventType, count: String(events.filter((event) => event.eventType === eventType).length), amount_cents: String(events.filter((event) => event.eventType === eventType).reduce((total, event) => total + event.amountCents, 0)), quantity: String(events.filter((event) => event.eventType === eventType).reduce((total, event) => total + event.quantity, 0)) })), unitCostCents);
}

function summarizeCommerceGroups(runId: string, groups: Array<{ event_type: CommerceEventType; count: string; amount_cents: string; quantity: string }>, unitCostCents: number | null): CommerceSummary {
  const byType = new Map(groups.map((group) => [group.event_type, { count: Number(group.count), amount: Number(group.amount_cents), quantity: Number(group.quantity) }]));
  const count = (type: CommerceEventType) => byType.get(type)?.count ?? 0;
  const amount = (type: CommerceEventType) => byType.get(type)?.amount ?? 0;
  const views = count("view");
  const paidOrders = count("order_paid");
  const grossPaidCents = amount("order_paid");
  const refundedCents = amount("refund");
  const paidUnits = byType.get("order_paid")?.quantity ?? 0;
  const netPaidCents = grossPaidCents - refundedCents;
  const productCostCents = unitCostCents === null ? null : paidUnits * unitCostCents;
  return { runId, views, productClicks: count("product_click"), addToCart: count("add_to_cart"), paidOrders, paidUnits, refunds: count("refund"), grossPaidCents, refundedCents, netPaidCents, unitCostCents, productCostCents, contributionMarginCents: productCostCents === null ? null : netPaidCents - productCostCents, viewToCartRate: views ? count("add_to_cart") / views : null, viewToPaidRate: views ? paidOrders / views : null, refundRate: paidOrders ? count("refund") / paidOrders : null };
}

async function unitCostForDemoRun(context: RequestContext, runId: string) {
  const run = await getRun(context, runId);
  if (!run?.productVersionId) return null;
  const version = (await listProducts(context)).flatMap((product) => product.versions).find((candidate) => candidate.id === run.productVersionId);
  return numericCost(version?.facts.unitCostCent);
}

function numericCost(value: unknown): number | null { const cost = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN; return Number.isSafeInteger(cost) && cost >= 0 ? cost : null; }
