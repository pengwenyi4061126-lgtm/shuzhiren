import type { RequestContext } from "@/lib/control-plane/auth-context";

export type AuditEvent = {
  id: string;
  tenantId: string;
  type: string;
  resource: string;
  resourceId: string;
  actorId: string;
  actorName: string;
  occurredAt: string;
  detail: Record<string, string | number | boolean | null>;
};

type AuditStore = { events: AuditEvent[] };
declare global { var shuzhirenAuditStore: AuditStore | undefined; }

function auditStore(): AuditStore {
  globalThis.shuzhirenAuditStore ??= { events: [] };
  return globalThis.shuzhirenAuditStore;
}

export function recordAuditEvent(context: RequestContext, input: Omit<AuditEvent, "id" | "tenantId" | "actorId" | "actorName" | "occurredAt">) {
  const event: AuditEvent = { id: `audit_${crypto.randomUUID()}`, tenantId: context.tenantId, actorId: context.actorId, actorName: context.actorName, occurredAt: new Date().toISOString(), ...input };
  auditStore().events.unshift(event);
  return event;
}

export function listAuditEvents(context: RequestContext) {
  return auditStore().events.filter((event) => event.tenantId === context.tenantId);
}
