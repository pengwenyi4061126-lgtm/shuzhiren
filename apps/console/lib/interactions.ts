import type { LiveQuestion } from "@/lib/domain";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { recordAuditEvent, recordAuditEventInTransaction } from "@/lib/audit";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { evaluatePolicy, type PolicyDecision } from "@/lib/policy-engine";

export type LiveInteraction = LiveQuestion & {
  tenantId: string;
  runId: string;
  source: string;
  externalEventId?: string;
  status: "queued" | "handled";
  decision: PolicyDecision["action"];
  reasons: string[];
  requiredEvidence: string[];
  evidenceIds: string[];
  submittedAt: string;
  handledAt?: string;
  handledBy?: string;
  resolutionNote?: string;
};

type InteractionStore = { interactions: Map<string, LiveInteraction>; externalEvents: Map<string, string> };
type PersistentInteractionRow = {
  id: string; tenant_id: string; live_run_id: string; source: string; external_event_id: string | null; question_text: string;
  risk_level: LiveInteraction["risk"]; policy_action: LiveInteraction["decision"]; policy_reasons: unknown;
  required_evidence: unknown; evidence_ids: unknown; status: LiveInteraction["status"]; created_at: Date | string;
  handled_at: Date | string | null; handled_by_name: string | null; resolution_note: string | null;
};

type CreateInteractionInput = { runId: string; question: string; source?: string; externalEventId?: string; evidenceIds: string[] };

declare global { var shuzhirenInteractionStore: InteractionStore | undefined; }

function interactionStore() {
  globalThis.shuzhirenInteractionStore ??= {
    interactions: new Map([
      ["interaction_demo_1", { id: "interaction_demo_1", tenantId: "tenant_demo", runId: "run_20261101_001", source: "viewer", text: "这款敏感肌可以用吗？", detail: "系统已拦截功效/适用人群回答", risk: "high", status: "queued", decision: "handoff", reasons: ["特殊人群适用性", "缺少必要证据"], requiredEvidence: ["safety_approval"], evidenceIds: [], submittedAt: "2026-11-01T11:22:00.000Z" }],
      ["interaction_demo_2", { id: "interaction_demo_2", tenantId: "tenant_demo", runId: "run_20261101_001", source: "viewer", text: "现在拍有赠品吗？", detail: "SKU A-102 · 活动版本 v18", risk: "medium", status: "queued", decision: "answer", reasons: ["需要读取实时商品事实"], requiredEvidence: ["product_version"], evidenceIds: ["product_version"], submittedAt: "2026-11-01T11:23:00.000Z" }],
      ["interaction_demo_3", { id: "interaction_demo_3", tenantId: "tenant_demo", runId: "run_20261101_001", source: "viewer", text: "主播声音是真的吗？", detail: "白名单回复，预计 2.1 秒", risk: "low", status: "queued", decision: "answer", reasons: [], requiredEvidence: ["product_version"], evidenceIds: ["product_version"], submittedAt: "2026-11-01T11:24:00.000Z" }]
    ]),
    externalEvents: new Map()
  };
  return globalThis.shuzhirenInteractionStore;
}

export async function listInteractions(context: RequestContext, runId: string, status?: LiveInteraction["status"]) {
  if (!databasePool()) return [...interactionStore().interactions.values()].filter((item) => item.tenantId === context.tenantId && item.runId === runId && (!status || item.status === status)).sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentInteractionRow>(
       `select i.id, i.tenant_id, i.live_run_id, i.source, i.external_event_id, i.question_text, i.risk_level, i.policy_action,
        i.policy_reasons, i.required_evidence, i.evidence_ids, i.status, i.created_at, i.handled_at,
        u.display_name as handled_by_name, i.resolution_note
       from live_interactions i left join users u on u.id = i.handled_by
       where i.live_run_id = $1 and ($2::interaction_status is null or i.status = $2)
       order by i.created_at desc limit 200`,
      [runId, status ?? null]
    );
    return result.rows.map(persistentInteraction);
  });
}

export async function createInteraction(context: RequestContext, input: CreateInteractionInput): Promise<LiveInteraction & { duplicate?: boolean }> {
  const decision = evaluatePolicy(input.question, input.evidenceIds);
  const detail = interactionDetail(decision);
  if (!databasePool()) {
    const source = input.source ?? "viewer";
    const eventKey = input.externalEventId ? `${context.tenantId}:${input.runId}:${source}:${input.externalEventId}` : undefined;
    const existingId = eventKey ? interactionStore().externalEvents.get(eventKey) : undefined;
    if (existingId) {
      const existing = interactionStore().interactions.get(existingId);
      if (existing) {
        if (existing.text !== input.question) throw new Response("External interaction event id was already used with different content", { status: 409 });
        return { ...existing, duplicate: true };
      }
    }
    const interaction: LiveInteraction = { id: `interaction_${crypto.randomUUID()}`, tenantId: context.tenantId, runId: input.runId, source, externalEventId: input.externalEventId, text: input.question, detail, risk: decision.riskLevel, status: "queued", decision: decision.action, reasons: decision.reasons, requiredEvidence: decision.requiredEvidence, evidenceIds: input.evidenceIds, submittedAt: new Date().toISOString() };
    interactionStore().interactions.set(interaction.id, interaction);
    if (eventKey) interactionStore().externalEvents.set(eventKey, interaction.id);
    return interaction;
  }
  return withTenantTransaction(context.tenantId, (client) => createPersistentInteraction(client, context, input, decision));
}

export async function createChannelInteraction(context: RequestContext, input: CreateInteractionInput & { channelConnectionId: string }): Promise<LiveInteraction & { duplicate?: boolean }> {
  if (!databasePool()) {
    const interaction = await createInteraction(context, input);
    if (!interaction.duplicate) await recordChannelInteractionAudit(context, interaction, input.channelConnectionId);
    return interaction;
  }
  const decision = evaluatePolicy(input.question, input.evidenceIds);
  return withTenantTransaction(context.tenantId, async (client) => {
    const interaction = await createPersistentInteraction(client, context, input, decision);
    if (!interaction.duplicate) await recordChannelInteractionAudit(context, interaction, input.channelConnectionId, client);
    return interaction;
  });
}

async function createPersistentInteraction(client: import("pg").PoolClient, context: RequestContext, input: CreateInteractionInput, decision: PolicyDecision): Promise<LiveInteraction & { duplicate?: boolean }> {
  const result = await client.query<PersistentInteractionRow>(
      `insert into live_interactions (tenant_id, live_run_id, source, external_event_id, question_text, risk_level, policy_action, policy_reasons, required_evidence, evidence_ids)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)
       on conflict (tenant_id, live_run_id, source, external_event_id) where external_event_id is not null do nothing
       returning id, tenant_id, live_run_id, source, external_event_id, question_text, risk_level, policy_action, policy_reasons,
         required_evidence, evidence_ids, status, created_at, handled_at, null::text as handled_by_name, resolution_note`,
      [context.tenantId, input.runId, input.source ?? "viewer", input.externalEventId ?? null, input.question, decision.riskLevel, decision.action, JSON.stringify(decision.reasons), JSON.stringify(decision.requiredEvidence), JSON.stringify(input.evidenceIds)]
    );
  if (result.rows[0]) return persistentInteraction(result.rows[0]);
  const existing = await client.query<PersistentInteractionRow>(
      `select id, tenant_id, live_run_id, source, external_event_id, question_text, risk_level, policy_action, policy_reasons,
        required_evidence, evidence_ids, status, created_at, handled_at, null::text as handled_by_name, resolution_note
       from live_interactions where live_run_id = $1 and source = $2 and external_event_id = $3`,
      [input.runId, input.source ?? "viewer", input.externalEventId]
    );
  if (!existing.rows[0]) throw new Error("Interaction idempotency conflict could not be resolved");
  const interaction = persistentInteraction(existing.rows[0]);
  if (interaction.text !== input.question) throw new Response("External interaction event id was already used with different content", { status: 409 });
  return { ...interaction, duplicate: true };
}

async function recordChannelInteractionAudit(context: RequestContext, interaction: LiveInteraction, channelConnectionId: string, client?: import("pg").PoolClient) {
  const record = client ? (input: Parameters<typeof recordAuditEvent>[1]) => recordAuditEventInTransaction(client, context, input) : (input: Parameters<typeof recordAuditEvent>[1]) => recordAuditEvent(context, input);
  await record({ type: "channel_interaction.received", resource: "live_interaction", resourceId: interaction.id, detail: { runId: interaction.runId, channelConnectionId, risk: interaction.risk, decision: interaction.decision } });
  if (interaction.decision === "handoff") await record({ type: "interaction.handoff_required", resource: "live_interaction", resourceId: interaction.id, detail: { runId: interaction.runId, reasons: interaction.reasons.join(";") } });
}

export async function handleInteraction(context: RequestContext, runId: string, interactionId: string, resolutionNote?: string) {
  if (!databasePool()) {
    const interaction = interactionStore().interactions.get(interactionId);
    if (!interaction || interaction.tenantId !== context.tenantId || interaction.runId !== runId) throw new Response("Interaction not found", { status: 404 });
    if (interaction.status === "handled") return interaction;
    const handled = { ...interaction, status: "handled" as const, handledAt: new Date().toISOString(), handledBy: context.actorName, resolutionNote: resolutionNote?.trim() || undefined };
    interactionStore().interactions.set(interaction.id, handled);
    return handled;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const result = await client.query<PersistentInteractionRow>(
      `update live_interactions set status = 'handled', handled_by = $3, handled_at = now(), resolution_note = $4
       where id = $1 and live_run_id = $2 and status = 'queued'
       returning id, tenant_id, live_run_id, source, external_event_id, question_text, risk_level, policy_action, policy_reasons,
         required_evidence, evidence_ids, status, created_at, handled_at, $5::text as handled_by_name, resolution_note`,
      [interactionId, runId, actor.rows[0].id, resolutionNote?.trim() || null, context.actorName]
    );
    if (!result.rows[0]) {
      const exists = await client.query("select id from live_interactions where id = $1 and live_run_id = $2", [interactionId, runId]);
      if (!exists.rows[0]) throw new Response("Interaction not found", { status: 404 });
      throw new Response("Interaction was already handled", { status: 409 });
    }
    return persistentInteraction(result.rows[0]);
  });
}

function interactionDetail(decision: PolicyDecision) {
  if (decision.action === "handoff") return decision.reasons.length ? decision.reasons.join("；") : "需要人工处理";
  if (decision.action === "refuse") return decision.reasons.join("；") || "策略拒答";
  return decision.reasons.length ? decision.reasons.join("；") : "已通过基础策略检查";
}

function asStringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? JSON.parse(value) as string[] : []; }

function persistentInteraction(row: PersistentInteractionRow): LiveInteraction {
  const decision = { action: row.policy_action, riskLevel: row.risk_level, reasons: asStringArray(row.policy_reasons), requiredEvidence: asStringArray(row.required_evidence) } as PolicyDecision;
  return { id: row.id, tenantId: row.tenant_id, runId: row.live_run_id, source: row.source, externalEventId: row.external_event_id ?? undefined, text: row.question_text, detail: interactionDetail(decision), risk: row.risk_level, status: row.status, decision: row.policy_action, reasons: decision.reasons, requiredEvidence: decision.requiredEvidence, evidenceIds: asStringArray(row.evidence_ids), submittedAt: new Date(row.created_at).toISOString(), handledAt: row.handled_at ? new Date(row.handled_at).toISOString() : undefined, handledBy: row.handled_by_name ?? undefined, resolutionNote: row.resolution_note ?? undefined };
}
