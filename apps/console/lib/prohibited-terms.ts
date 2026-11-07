import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { recordAuditEvent, recordAuditEventInTransaction } from "@/lib/audit";
import { requireTenantWideAccess, type RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { normalizePolicyText, parsePolicyRules, type PolicyRule } from "@/lib/shared/policy-engine.mjs";
import { guardBroadcastText } from "@/lib/shared/broadcast-guard.mjs";
import { BUILTIN_LEXICON, BUILTIN_LEXICON_VERSION } from "@/lib/shared/prohibited-terms-builtin.mjs";
import { compileLexicon, effectiveLexicon, lexiconSha256, runtimeLexicon, scanProhibitedTerms, termProblem, type Finding, type LexiconTerm, type RawLexiconTerm, type TenantTermRow } from "@/lib/shared/prohibited-terms.mjs";

// Prohibited-term lexicon access for the console (design.md module E, E.2). The lexicon in force for a tenant is the
// built-in sample list adjusted by the tenant's approved rows (effectiveLexicon). Approving a show revision freezes
// that lexicon into show_revision_prohibited_term_snapshots (migration 088; the database refuses the approval without
// the snapshot), and the lexicon a run is checked against is the union of its revision's snapshot and the lexicon in
// force now (runtimeLexicon), so a term added after approval takes effect at once and a term retired after approval
// still blocks the runs of revisions approved while it was in force.

/** What a revision's frozen lexicon looks like to the caller; the audit event `show_revision.prohibited_terms_frozen` carries it. */
export type FrozenLexiconInfo = { revisionId: string; lexiconSha256: string; builtinVersion: string; termCount: number };
/** One refused version of one segment script. `variantIndex` 0 is the primary runtime script. */
export type ProgramScriptFailure = { position: number; variantIndex: number; text: string; decision: "answer" | "handoff" | "refuse"; reasons: string[]; findings: Finding[] };
/** The part of a program segment the script check reads. */
export type ProgramScriptSegment = { position: number; kind: string; runtimeScript?: string; runtimeScriptVariants?: string[] };
export type ProgramScriptGuard = { policyRules: PolicyRule[]; lexicon: readonly LexiconTerm[] };

/** The longest script the program editor accepts; the guard uses the same limit as the runtime dispatch (script-plays.ts). */
const scriptMaxLength = 800;
const lexiconColumns = "kind, builtin_term_id, term, normalized_term, category, approved_revision, severity, suggestions, disabled, active";
const termColumns = `id, tenant_id, kind, builtin_term_id, term, normalized_term, category, approved_revision, severity, suggestions, disabled, active, approved_at, created_by::text as created_by, created_at`;
const revisionColumns = `id, tenant_id, term_id, revision, severity, suggestions, disabled, active, loosening, reason, status, requested_by::text as requested_by, decided_by::text as decided_by, decided_at, created_at`;

export type ProhibitedTermMutation = { term?: string; category?: string; severity?: string; suggestions?: unknown; active?: boolean; disabled?: boolean; reason?: string };
type ProhibitedTermRow = TenantTermRow & { id: string; tenant_id: string; normalized_term: string | null; approved_at: Date | string | null; created_by: string; created_at: Date | string };
type ProhibitedTermRevisionRow = { id: string; tenant_id: string; term_id: string; revision: number; severity: string; suggestions: unknown; disabled: boolean; active: boolean; loosening: boolean; reason: string | null; status: string; requested_by: string; decided_by: string | null; decided_at: Date | string | null; created_at: Date | string };
type DemoTermRevision = { id: string; termId: string; revision: number; severity: string; suggestions: string[]; disabled: boolean; active: boolean; loosening: boolean; reason: string | null; status: "pending" | "approved" | "rejected"; requestedBy: string; decidedBy?: string; decidedAt?: string; createdAt: string };
type DemoTermRow = TenantTermRow & { id: string; tenantId: string; normalized_term?: string | null; approved_at?: string | null; created_by: string; created_at: string };

const isCategory = (value: unknown): value is LexiconTerm["category"] => ["extreme", "medical", "false_claim", "offsite_trade", "custom"].includes(String(value));
const isSeverity = (value: unknown): value is LexiconTerm["severity"] => value === "block" || value === "warn";
export function parseProhibitedTermInput(value: unknown): ProhibitedTermMutation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["term", "category", "severity", "suggestions", "active", "disabled", "reason"].includes(key))) return null;
  if (input.term !== undefined && typeof input.term !== "string" || input.category !== undefined && typeof input.category !== "string" || input.severity !== undefined && typeof input.severity !== "string" || input.active !== undefined && typeof input.active !== "boolean" || input.disabled !== undefined && typeof input.disabled !== "boolean" || input.reason !== undefined && typeof input.reason !== "string") return null;
  return input as ProhibitedTermMutation;
}
const cleanSuggestionsInput = (value: unknown): string[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5 || value.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > 120)) return null;
  const result = value.map((item) => (item as string).trim());
  return new Set(result).size === result.length ? result : null;
};
function inputError(input: ProhibitedTermMutation, { requireTerm = false, allowActive = false, allowDisabled = false } = {}) {
  if (requireTerm || input.term !== undefined) {
    const problem = termProblem(input.term);
    if (problem) return problem;
  }
  if (input.category !== undefined && !isCategory(input.category)) return "违禁词类别无效";
  if (input.severity !== undefined && !isSeverity(input.severity)) return "违禁词级别无效";
  if (input.suggestions !== undefined && cleanSuggestionsInput(input.suggestions) === null) return "替换建议必须是最多 5 条互不重复的非空文本";
  if (input.active !== undefined && (!allowActive || typeof input.active !== "boolean")) return "启用状态无效";
  if (input.disabled !== undefined && (!allowDisabled || typeof input.disabled !== "boolean")) return "停用状态无效";
  if (input.reason !== undefined && typeof input.reason !== "string") return "变更原因无效";
  return null;
}

/** Tenant-wide lexicon view used by the management page. */
export async function listProhibitedTerms(context: RequestContext) {
  requireTenantWideAccess(context);
  if (!databasePool()) {
    const terms = demoStore().rows.get(context.tenantId) ?? [];
    const revisions = demoStore().revisions.get(context.tenantId) ?? [];
    return { builtinVersion: BUILTIN_LEXICON_VERSION, builtinTerms: BUILTIN_LEXICON, tenantTerms: terms.map((row) => demoTermView(row, revisions)), effectiveLexicon: currentDemoLexicon(context.tenantId), lexiconSha256: lexiconSha256(currentDemoLexicon(context.tenantId)) };
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const [terms, revisions] = await Promise.all([
      client.query<ProhibitedTermRow>(`select ${termColumns} from tenant_prohibited_terms order by created_at, id`),
      client.query<ProhibitedTermRevisionRow>(`select ${revisionColumns} from tenant_prohibited_term_revisions order by created_at, id`)
    ]);
    const lexicon = await currentLexiconInTransaction(client);
    return { builtinVersion: BUILTIN_LEXICON_VERSION, builtinTerms: BUILTIN_LEXICON, tenantTerms: terms.rows.map((row) => persistentTermView(row, revisions.rows)), effectiveLexicon: lexicon, lexiconSha256: lexiconSha256(lexicon) };
  }, { readOnly: true });
}

/** High-frequency editor scan: no audit write and no tenant-wide scope requirement. */
export async function scanProhibitedTermText(context: RequestContext, text: string) {
  if (!databasePool()) {
    const lexicon = currentDemoLexicon(context.tenantId);
    return { findings: scanProhibitedTerms(text, lexicon), lexiconSha256: lexiconSha256(lexicon), builtinVersion: BUILTIN_LEXICON_VERSION };
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const lexicon = await currentLexiconInTransaction(client);
    return { findings: scanProhibitedTerms(text, lexicon), lexiconSha256: lexiconSha256(lexicon), builtinVersion: BUILTIN_LEXICON_VERSION };
  }, { readOnly: true });
}

/** Creates a pending custom term and its first pending revision; it has no effect until a reviewer approves it. */
export async function createProhibitedTerm(context: RequestContext, input: ProhibitedTermMutation) {
  requireTenantWideAccess(context);
  const problem = inputError(input, { requireTerm: true });
  const suggestions = cleanSuggestionsInput(input.suggestions);
  if (problem || !suggestions || (input.category !== undefined && input.category !== "custom")) throw new Response(problem ?? "自定义词类别必须为 custom", { status: 422, statusText: "invalid_prohibited_term" });
  const severity = input.severity ?? "block";
  if (!isSeverity(severity)) throw new Response("违禁词级别无效", { status: 422, statusText: "invalid_prohibited_term" });
  if (!databasePool()) {
    const lexicon = currentDemoLexicon(context.tenantId);
    assertSafeSuggestions(suggestions, [...lexicon, ...proposedTerm(input.term!, severity)]);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const row: DemoTermRow = { id, tenantId: context.tenantId, kind: "custom", term: input.term!.trim(), normalized_term: normalizePolicyText(input.term!), category: "custom", approved_revision: null, severity: null, suggestions: null, active: true, disabled: false, approved_at: null, created_by: context.actorId, created_at: now };
    const revision: DemoTermRevision = { id: crypto.randomUUID(), termId: id, revision: 1, severity, suggestions, disabled: false, active: true, loosening: false, reason: null, status: "pending", requestedBy: context.actorId, createdAt: now };
    pushDemoTerm(context.tenantId, row, revision);
    await recordAuditEvent(context, { type: "prohibited_term.created", resource: "tenant_prohibited_term", resourceId: id, detail: { termSha256: createHash("sha256").update(row.normalized_term!).digest("hex"), revision: 1 } });
    return demoTermView(row, [revision]);
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const lexicon = await currentLexiconInTransaction(client);
    assertSafeSuggestions(suggestions, [...lexicon, ...proposedTerm(input.term!, severity)]);
    const actorId = await actorDatabaseId(client, context);
    const id = crypto.randomUUID();
    const inserted = await client.query<ProhibitedTermRow>(`insert into tenant_prohibited_terms (id, tenant_id, kind, term, normalized_term, category, created_by) values ($1, $2, 'custom', $3, $4, 'custom', $5) returning ${termColumns}`, [id, context.tenantId, input.term!.trim(), normalizePolicyText(input.term!), actorId]);
    const revision = await insertTermRevision(client, context.tenantId, id, { severity, suggestions, disabled: false, active: true, loosening: false, reason: null, requestedBy: actorId });
    await recordAuditEventInTransaction(client, context, { type: "prohibited_term.created", resource: "tenant_prohibited_term", resourceId: id, detail: { termSha256: createHash("sha256").update(normalizePolicyText(input.term!)).digest("hex"), revision: 1 } });
    return persistentTermView(inserted.rows[0], [revision]);
  });
}

function assertSafeSuggestions(suggestions: readonly string[], lexicon: readonly LexiconTerm[]) {
  const blocking = lexicon.filter((entry) => entry.severity === "block");
  if (suggestions.some((suggestion) => scanProhibitedTerms(suggestion, blocking).length > 0)) {
    throw new Response("替换建议包含仍会拦截的违禁词", { status: 422, statusText: "prohibited_term_suggestion_blocked" });
  }
}

function termView(row: ProhibitedTermRow, revisions: readonly ProhibitedTermRevisionRow[]) {
  return { id: row.id, tenantId: row.tenant_id, kind: row.kind, builtinTermId: row.builtin_term_id, term: row.term, normalizedTerm: row.normalized_term, category: row.category, approvedRevision: row.approved_revision, severity: row.severity, suggestions: row.suggestions, disabled: row.disabled, active: row.active, approvedAt: row.approved_at, createdBy: row.created_by, createdAt: row.created_at, revisions: revisions.filter((revision) => revision.term_id === row.id).sort((a, b) => a.revision - b.revision) };
}

function persistentTermView(row: ProhibitedTermRow, revisions: readonly ProhibitedTermRevisionRow[]) { return termView(row, revisions); }

function demoTermView(row: DemoTermRow, revisions: readonly DemoTermRevision[]) {
  return { ...row, revisions: revisions.filter((revision) => revision.termId === row.id).sort((a, b) => a.revision - b.revision) };
}

function pushDemoTerm(tenantId: string, row: DemoTermRow, revision: DemoTermRevision) {
  const store = demoStore();
  store.rows.set(tenantId, [...(store.rows.get(tenantId) ?? []), row]);
  store.revisions.set(tenantId, [...(store.revisions.get(tenantId) ?? []), revision]);
}

function proposedTerm(term: string, severity: LexiconTerm["severity"]): LexiconTerm[] {
  return [{ id: `proposed:${normalizePolicyText(term)}`, term: term.trim(), normalized: normalizePolicyText(term), category: "custom", severity, suggestions: [] }];
}

async function actorDatabaseId(client: PoolClient, context: RequestContext) {
  return (await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role])).rows[0].id;
}

async function insertTermRevision(client: PoolClient, tenantId: string, termId: string, input: Omit<DemoTermRevision, "id" | "termId" | "revision" | "status" | "decidedBy" | "decidedAt" | "createdAt">) {
  const result = await client.query<ProhibitedTermRevisionRow>(
    `insert into tenant_prohibited_term_revisions (tenant_id, term_id, revision, severity, suggestions, disabled, active, loosening, reason, requested_by)
     select $1, $2, coalesce(max(revision), 0) + 1, $3, $4::jsonb, $5, $6, $7, $8, $9
     from tenant_prohibited_term_revisions where tenant_id = $1 and term_id = $2
     returning ${revisionColumns}`,
    [tenantId, termId, input.severity, JSON.stringify(input.suggestions), input.disabled, input.active, input.loosening, input.reason, input.requestedBy]
  );
  return result.rows[0];
}

function assertRevisionReason(loosening: boolean, reason: unknown) {
  if (!loosening) return null;
  const value = typeof reason === "string" ? reason.trim() : "";
  if (value.length < 10 || value.length > 500) throw new Response("放宽词表必须填写 10 至 500 字的原因", { status: 400, statusText: "prohibited_term_reason_required" });
  return value;
}

/** Requests a custom-term change; the current lexicon remains unchanged until approval. */
export async function updateProhibitedTerm(context: RequestContext, termId: string, input: ProhibitedTermMutation) {
  requireTenantWideAccess(context);
  const problem = inputError(input, { allowActive: true });
  if (problem || input.term !== undefined || (input.category !== undefined && input.category !== "custom")) throw new Response(problem ?? "自定义词的词条与类别不可修改", { status: 422, statusText: "invalid_prohibited_term" });
  if (input.severity === undefined && input.suggestions === undefined && input.active === undefined) throw new Response("请至少提交一个变更字段", { status: 400, statusText: "empty_prohibited_term_change" });
  const suggestions = cleanSuggestionsInput(input.suggestions);
  if (suggestions === null) throw new Response("替换建议格式无效", { status: 422, statusText: "invalid_prohibited_term" });
  if (!databasePool()) {
    const rows = demoStore().rows.get(context.tenantId) ?? [];
    const row = rows.find((entry) => entry.id === termId && entry.kind === "custom");
    if (!row) throw new Response("自定义违禁词不存在", { status: 404, statusText: "prohibited_term_not_found" });
    const revisions = demoStore().revisions.get(context.tenantId) ?? [];
    if (revisions.some((entry) => entry.termId === termId && entry.status === "pending")) throw new Response("该词条已有待审批修订", { status: 409, statusText: "prohibited_term_revision_pending" });
    const prior = revisions.filter((entry) => entry.termId === termId && entry.status === "approved").at(-1);
    const severity = input.severity ?? prior?.severity ?? "block";
    const active = input.active ?? prior?.active ?? true;
    const nextSuggestions = input.suggestions === undefined ? prior?.suggestions ?? [] : suggestions;
    const loosening = (!active && (prior?.active ?? true)) || (severity === "warn" && (prior?.severity ?? "block") === "block");
    const reason = assertRevisionReason(loosening, input.reason);
    assertSafeSuggestions(nextSuggestions, currentDemoLexicon(context.tenantId));
    const revision: DemoTermRevision = { id: crypto.randomUUID(), termId, revision: Math.max(0, ...revisions.filter((entry) => entry.termId === termId).map((entry) => entry.revision)) + 1, severity, suggestions: nextSuggestions, disabled: false, active, loosening, reason, status: "pending", requestedBy: context.actorId, createdAt: new Date().toISOString() };
    demoStore().revisions.set(context.tenantId, [...revisions, revision]);
    await recordAuditEvent(context, { type: "prohibited_term.updated", resource: "tenant_prohibited_term", resourceId: termId, detail: { revision: revision.revision, loosening } });
    return { ...row, revisions: [revision] };
  }
  if (!isUuid(termId)) throw new Response("自定义违禁词不存在", { status: 404, statusText: "prohibited_term_not_found" });
  return withTenantTransaction(context.tenantId, async (client) => {
    const row = (await client.query<ProhibitedTermRow>(`select ${termColumns} from tenant_prohibited_terms where id = $1 for update`, [termId])).rows[0];
    if (!row || row.kind !== "custom") throw new Response("自定义违禁词不存在", { status: 404, statusText: "prohibited_term_not_found" });
    if ((await client.query("select 1 from tenant_prohibited_term_revisions where term_id = $1 and status = 'pending'", [termId])).rowCount) throw new Response("该词条已有待审批修订", { status: 409, statusText: "prohibited_term_revision_pending" });
    const prior = (await client.query<ProhibitedTermRevisionRow>(`select ${revisionColumns} from tenant_prohibited_term_revisions where term_id = $1 and status = 'approved' order by revision desc limit 1`, [termId])).rows[0];
    const severity = input.severity ?? prior?.severity ?? "block";
    const active = input.active ?? prior?.active ?? true;
    const nextSuggestions = input.suggestions === undefined ? Array.isArray(prior?.suggestions) ? prior.suggestions as string[] : [] : suggestions;
    const loosening = (!active && (prior?.active ?? true)) || (severity === "warn" && (prior?.severity ?? "block") === "block");
    const reason = assertRevisionReason(loosening, input.reason);
    assertSafeSuggestions(nextSuggestions, await currentLexiconInTransaction(client));
    const actor = await actorDatabaseId(client, context);
    const revision = await insertTermRevision(client, context.tenantId, termId, { severity, suggestions: nextSuggestions, disabled: false, active, loosening, reason, requestedBy: actor });
    await recordAuditEventInTransaction(client, context, { type: "prohibited_term.updated", resource: "tenant_prohibited_term", resourceId: termId, detail: { revision: revision.revision, loosening } });
    return termView(row, [revision]);
  });
}

/** Retires a custom term through a reasoned, second-person-reviewed loosening revision. */
export async function retireProhibitedTerm(context: RequestContext, termId: string, reasonInput: unknown) {
  requireTenantWideAccess(context);
  const reason = assertRevisionReason(true, reasonInput)!;
  if (!databasePool()) {
    const row = (demoStore().rows.get(context.tenantId) ?? []).find((entry) => entry.id === termId && entry.kind === "custom");
    if (!row) throw new Response("自定义违禁词不存在", { status: 404, statusText: "prohibited_term_not_found" });
    const revisions = demoStore().revisions.get(context.tenantId) ?? [];
    if (revisions.some((entry) => entry.termId === termId && entry.status === "pending")) throw new Response("该词条已有待审批修订", { status: 409, statusText: "prohibited_term_revision_pending" });
    const prior = revisions.filter((entry) => entry.termId === termId && entry.status === "approved").at(-1);
    if (!prior?.active) throw new Response("该词条尚未生效或已下线", { status: 409, statusText: "prohibited_term_inactive" });
    const revision: DemoTermRevision = { id: crypto.randomUUID(), termId, revision: Math.max(0, ...revisions.filter((entry) => entry.termId === termId).map((entry) => entry.revision)) + 1, severity: prior.severity, suggestions: prior.suggestions, disabled: false, active: false, loosening: true, reason, status: "pending", requestedBy: context.actorId, createdAt: new Date().toISOString() };
    demoStore().revisions.set(context.tenantId, [...revisions, revision]);
    await recordAuditEvent(context, { type: "prohibited_term.retire_requested", resource: "tenant_prohibited_term", resourceId: termId, detail: { revision: revision.revision, loosening: true } });
    return { ...row, revisions: [revision] };
  }
  if (!isUuid(termId)) throw new Response("自定义违禁词不存在", { status: 404, statusText: "prohibited_term_not_found" });
  return withTenantTransaction(context.tenantId, async (client) => {
    const row = (await client.query<ProhibitedTermRow>(`select ${termColumns} from tenant_prohibited_terms where id = $1 for update`, [termId])).rows[0];
    if (!row || row.kind !== "custom") throw new Response("自定义违禁词不存在", { status: 404, statusText: "prohibited_term_not_found" });
    if ((await client.query("select 1 from tenant_prohibited_term_revisions where term_id = $1 and status = 'pending'", [termId])).rowCount) throw new Response("该词条已有待审批修订", { status: 409, statusText: "prohibited_term_revision_pending" });
    const prior = (await client.query<ProhibitedTermRevisionRow>(`select ${revisionColumns} from tenant_prohibited_term_revisions where term_id = $1 and status = 'approved' order by revision desc limit 1`, [termId])).rows[0];
    if (!prior?.active) throw new Response("该词条尚未生效或已下线", { status: 409, statusText: "prohibited_term_inactive" });
    const revision = await insertTermRevision(client, context.tenantId, termId, { severity: prior.severity, suggestions: Array.isArray(prior.suggestions) ? prior.suggestions as string[] : [], disabled: false, active: false, loosening: true, reason, requestedBy: await actorDatabaseId(client, context) });
    await recordAuditEventInTransaction(client, context, { type: "prohibited_term.retire_requested", resource: "tenant_prohibited_term", resourceId: termId, detail: { revision: revision.revision, loosening: true } });
    return termView(row, [revision]);
  });
}

/** Requests a built-in override without changing the effective lexicon before review. */
export async function requestBuiltinTermOverride(context: RequestContext, builtinTermId: string, input: ProhibitedTermMutation) {
  requireTenantWideAccess(context);
  const builtin = BUILTIN_LEXICON.find((entry) => entry.id === builtinTermId);
  if (!builtin) throw new Response("内置违禁词不存在", { status: 404, statusText: "builtin_prohibited_term_not_found" });
  const problem = inputError(input, { allowDisabled: true });
  if (problem || input.term !== undefined || input.active !== undefined || input.category !== undefined) throw new Response(problem ?? "内置词覆盖字段无效", { status: 422, statusText: "invalid_prohibited_term_override" });
  if (input.disabled === undefined && input.suggestions === undefined && input.severity === undefined) throw new Response("请至少提交一个变更字段", { status: 400, statusText: "empty_prohibited_term_change" });
  const suggestions = cleanSuggestionsInput(input.suggestions);
  if (suggestions === null) throw new Response("替换建议格式无效", { status: 422, statusText: "invalid_prohibited_term" });
  const disabled = input.disabled ?? false;
  const severity = input.severity ?? builtin.severity;
  const loosening = disabled || (builtin.severity === "block" && severity === "warn");
  const reason = assertRevisionReason(loosening, input.reason);
  if (!databasePool()) {
    const rows = demoStore().rows.get(context.tenantId) ?? [];
    let row = rows.find((entry) => entry.kind === "builtin_override" && entry.builtin_term_id === builtinTermId);
    const revisions = demoStore().revisions.get(context.tenantId) ?? [];
    if (row && revisions.some((entry) => entry.termId === row!.id && entry.status === "pending")) throw new Response("该词条已有待审批修订", { status: 409, statusText: "prohibited_term_revision_pending" });
    if (!row) {
      row = { id: crypto.randomUUID(), tenantId: context.tenantId, kind: "builtin_override", builtin_term_id: builtinTermId, term: null, normalized_term: null, category: builtin.category, approved_revision: null, severity: null, suggestions: null, disabled: false, active: true, created_by: context.actorId, created_at: new Date().toISOString() } as DemoTermRow;
      demoStore().rows.set(context.tenantId, [...rows, row]);
    }
    const prior = revisions.filter((entry) => entry.termId === row!.id && entry.status === "approved").at(-1);
    const nextSuggestions = input.suggestions === undefined ? [...(prior?.suggestions ?? builtin.suggestions)] : suggestions;
    assertSafeSuggestions(nextSuggestions, currentDemoLexicon(context.tenantId));
    const revision: DemoTermRevision = { id: crypto.randomUUID(), termId: row.id, revision: Math.max(0, ...revisions.filter((entry) => entry.termId === row!.id).map((entry) => entry.revision)) + 1, severity, suggestions: nextSuggestions, disabled, active: true, loosening, reason, status: "pending", requestedBy: context.actorId, createdAt: new Date().toISOString() };
    demoStore().revisions.set(context.tenantId, [...revisions, revision]);
    await recordAuditEvent(context, { type: "prohibited_term.override_requested", resource: "tenant_prohibited_term", resourceId: row.id, detail: { builtinTermId, revision: revision.revision, loosening } });
    return { ...row, revisions: [revision] };
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    let row = (await client.query<ProhibitedTermRow>(`select ${termColumns} from tenant_prohibited_terms where builtin_term_id = $1 for update`, [builtinTermId])).rows[0];
    if (row && (await client.query("select 1 from tenant_prohibited_term_revisions where term_id = $1 and status = 'pending'", [row.id])).rowCount) throw new Response("该词条已有待审批修订", { status: 409, statusText: "prohibited_term_revision_pending" });
    const actor = await actorDatabaseId(client, context);
    if (!row) row = (await client.query<ProhibitedTermRow>(`insert into tenant_prohibited_terms (tenant_id, kind, builtin_term_id, category, created_by) values ($1, 'builtin_override', $2, $3, $4) returning ${termColumns}`, [context.tenantId, builtinTermId, builtin.category, actor])).rows[0];
    const prior = (await client.query<ProhibitedTermRevisionRow>(`select ${revisionColumns} from tenant_prohibited_term_revisions where term_id = $1 and status = 'approved' order by revision desc limit 1`, [row.id])).rows[0];
    const nextSuggestions = input.suggestions === undefined ? Array.isArray(prior?.suggestions) ? prior.suggestions as string[] : [...builtin.suggestions] : suggestions;
    assertSafeSuggestions(nextSuggestions, await currentLexiconInTransaction(client));
    const revision = await insertTermRevision(client, context.tenantId, row.id, { severity: severity as LexiconTerm["severity"], suggestions: nextSuggestions, disabled, active: true, loosening, reason, requestedBy: actor });
    await recordAuditEventInTransaction(client, context, { type: "prohibited_term.override_requested", resource: "tenant_prohibited_term", resourceId: row.id, detail: { builtinTermId, revision: revision.revision, loosening } });
    return termView(row, [revision]);
  });
}

/** Approves a pending revision and atomically updates the effective term values. */
export async function approveProhibitedTermRevision(context: RequestContext, termId: string) {
  requireTenantWideAccess(context);
  if (!databasePool()) {
    const row = (demoStore().rows.get(context.tenantId) ?? []).find((entry) => entry.id === termId);
    const revisions = demoStore().revisions.get(context.tenantId) ?? [];
    const revision = revisions.find((entry) => entry.termId === termId && entry.status === "pending");
    if (!row || !revision) throw new Response("待审批违禁词修订不存在", { status: 404, statusText: "prohibited_term_revision_not_found" });
    if (revision.loosening && revision.requestedBy === context.actorId) throw new Response("放宽类修订必须由另一位成员批准", { status: 409, statusText: "prohibited_term_second_approver_required" });
    revision.status = "approved"; revision.decidedBy = context.actorId; revision.decidedAt = new Date().toISOString();
    row.approved_revision = revision.revision; row.severity = revision.severity as LexiconTerm["severity"]; row.suggestions = revision.suggestions; row.disabled = revision.disabled; row.active = revision.active; row.approved_at = revision.decidedAt;
    const digest = lexiconSha256(currentDemoLexicon(context.tenantId));
    await recordAuditEvent(context, { type: "prohibited_term.approved", resource: "tenant_prohibited_term", resourceId: termId, detail: { termId, revision: revision.revision, loosening: revision.loosening, lexiconSha256After: digest } });
    return { ...row, revisions: revisions.filter((entry) => entry.termId === termId) };
  }
  if (!isUuid(termId)) throw new Response("待审批违禁词修订不存在", { status: 404, statusText: "prohibited_term_revision_not_found" });
  return withTenantTransaction(context.tenantId, async (client) => {
    const row = (await client.query<ProhibitedTermRow>(`select ${termColumns} from tenant_prohibited_terms where id = $1 for update`, [termId])).rows[0];
    const revision = (await client.query<ProhibitedTermRevisionRow>(`select ${revisionColumns} from tenant_prohibited_term_revisions where term_id = $1 and status = 'pending' order by revision desc limit 1 for update`, [termId])).rows[0];
    if (!row || !revision) throw new Response("待审批违禁词修订不存在", { status: 404, statusText: "prohibited_term_revision_not_found" });
    const actor = await actorDatabaseId(client, context);
    if (revision.loosening && revision.requested_by === actor) throw new Response("放宽类修订必须由另一位成员批准", { status: 409, statusText: "prohibited_term_second_approver_required" });
    await client.query("update tenant_prohibited_term_revisions set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [revision.id, actor]);
    await client.query("update tenant_prohibited_terms set approved_revision = $2, severity = $3, suggestions = $4::jsonb, disabled = $5, active = $6, approved_at = now() where id = $1", [termId, revision.revision, revision.severity, JSON.stringify(revision.suggestions), revision.disabled, revision.active]);
    const digest = lexiconSha256(await currentLexiconInTransaction(client));
    await recordAuditEventInTransaction(client, context, { type: "prohibited_term.approved", resource: "tenant_prohibited_term", resourceId: termId, detail: { termId, revision: revision.revision, loosening: revision.loosening, lexiconSha256After: digest } });
    return termView({ ...row, approved_revision: revision.revision, severity: revision.severity, suggestions: revision.suggestions, disabled: revision.disabled, active: revision.active } as ProhibitedTermRow, [revision]);
  });
}

function isUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

export function prohibitedTermErrorResponse(error: unknown, fallback: string) {
  if (error instanceof Response) return Response.json({ error: error.statusText || fallback }, { status: error.status });
  throw error;
}

// ---- Reading the lexicon ----

/** Tenant rows that have an approved revision; rows never approved have no effect. RLS limits the read to the transaction's tenant. */
async function approvedTermRows(client: PoolClient) {
  return (await client.query<TenantTermRow>(`select ${lexiconColumns} from tenant_prohibited_terms where approved_revision is not null`)).rows;
}

/** The lexicon in force now for the tenant of the transaction. */
export async function currentLexiconInTransaction(client: PoolClient): Promise<LexiconTerm[]> {
  return effectiveLexicon(BUILTIN_LEXICON as readonly RawLexiconTerm[], await approvedTermRows(client));
}

/**
 * The lexicon a run is checked against: its show revision's frozen snapshot united with the lexicon in force now.
 * A revision without a snapshot (approved before migration 088) is checked against the current lexicon alone.
 */
export async function runLexiconInTransaction(client: PoolClient, runId: string): Promise<LexiconTerm[]> {
  const frozen = (await client.query<{ lexicon: unknown }>(
    `select s.lexicon from show_revision_prohibited_term_snapshots s
     join live_runs r on r.tenant_id = s.tenant_id and r.show_revision_id = s.show_revision_id
     where r.id = $1`,
    [runId]
  )).rows[0];
  return runtimeLexicon(frozen ? parseFrozenLexicon(frozen.lexicon) : null, await currentLexiconInTransaction(client));
}

/**
 * Reads a stored lexicon value (an array, or its JSON text). Elements that cannot be compiled are dropped and counted in
 * the log line, never thrown: one bad element must not switch the whole check off.
 */
export function parseFrozenLexicon(value: unknown): LexiconTerm[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { parsed = null; }
  }
  if (!Array.isArray(parsed)) {
    console.error(JSON.stringify({ service: "control-plane", event: "prohibited_terms.snapshot_unreadable" }));
    return [];
  }
  const compiled = compileLexicon(parsed as RawLexiconTerm[]);
  if (compiled.length < parsed.length) console.error(JSON.stringify({ service: "control-plane", event: "prohibited_terms.snapshot_elements_dropped", dropped: parsed.length - compiled.length }));
  return compiled;
}

// ---- Freezing the lexicon into a revision ----

/**
 * Writes the lexicon in force now into the snapshot table for `revisionId`, which must still be a draft (the trigger refuses
 * anything else), and returns what was written. Call it after the script check and before the revision's approval_status
 * is updated; the audit event is the caller's, because it needs the request context. Pass the lexicon the scripts were checked
 * against as `checked` so that the snapshot is exactly what was checked; without it the lexicon in force now is read.
 */
export async function freezeRevisionLexiconInTransaction(client: PoolClient, revisionId: string, checked?: readonly LexiconTerm[]): Promise<FrozenLexiconInfo> {
  const lexicon = checked ?? await currentLexiconInTransaction(client);
  const info: FrozenLexiconInfo = { revisionId, lexiconSha256: lexiconSha256(lexicon), builtinVersion: BUILTIN_LEXICON_VERSION, termCount: lexicon.length };
  const inserted = await client.query(
    "insert into show_revision_prohibited_term_snapshots (tenant_id, show_revision_id, builtin_version, lexicon, lexicon_sha256, term_count) select tenant_id, id, $2, $3::jsonb, $4, $5 from show_revisions where id = $1 returning show_revision_id",
    [revisionId, info.builtinVersion, JSON.stringify(lexicon), info.lexiconSha256, info.termCount]
  );
  if (!inserted.rows[0]) throw new Response("Show revision not found", { status: 404 });
  return info;
}

/** The audit detail of `show_revision.prohibited_terms_frozen`: hashes and counts only, never term text. */
export function frozenLexiconAuditDetail(info: FrozenLexiconInfo, extra: { scriptCount: number; policyProfileId: string | null }) {
  return { revisionId: info.revisionId, lexiconSha256: info.lexiconSha256, builtinVersion: info.builtinVersion, termCount: info.termCount, scriptCount: extra.scriptCount, policyProfileId: extra.policyProfileId };
}

// ---- Demo mode: the same reads and writes over memory (lost on restart, like every demo store) ----

type DemoFrozenLexicon = FrozenLexiconInfo & { tenantId: string; lexicon: LexiconTerm[] };
type DemoLexiconStore = { rows: Map<string, DemoTermRow[]>; revisions: Map<string, DemoTermRevision[]>; snapshots: Map<string, DemoFrozenLexicon> };
declare global {
  var shuzhirenProhibitedTermStore: DemoLexiconStore | undefined;
}

function demoStore(): DemoLexiconStore {
  globalThis.shuzhirenProhibitedTermStore ??= { rows: new Map(), revisions: new Map(), snapshots: new Map() };
  globalThis.shuzhirenProhibitedTermStore.revisions ??= new Map();
  return globalThis.shuzhirenProhibitedTermStore;
}

/** Demo-mode counterpart of currentLexiconInTransaction; the tenant rows are those approved ones the demo store holds. */
export function currentDemoLexicon(tenantId: string): LexiconTerm[] {
  const rows = (demoStore().rows.get(tenantId) ?? []).filter((row) => Number.isInteger(row.approved_revision));
  return effectiveLexicon(BUILTIN_LEXICON as readonly RawLexiconTerm[], rows);
}

/** Demo-mode counterpart of runLexiconInTransaction. */
export function demoRunLexicon(tenantId: string, revisionId: string): LexiconTerm[] {
  const frozen = demoStore().snapshots.get(revisionId);
  return runtimeLexicon(frozen && frozen.tenantId === tenantId ? frozen.lexicon : null, currentDemoLexicon(tenantId));
}

/** Demo-mode counterpart of freezeRevisionLexiconInTransaction. A revision is frozen once: asking again returns the first snapshot. */
export function freezeDemoRevisionLexicon(tenantId: string, revisionId: string): FrozenLexiconInfo {
  const existing = demoLexiconSnapshot(revisionId);
  if (existing) return existing;
  const lexicon = currentDemoLexicon(tenantId);
  const info: FrozenLexiconInfo = { revisionId, lexiconSha256: lexiconSha256(lexicon), builtinVersion: BUILTIN_LEXICON_VERSION, termCount: lexicon.length };
  demoStore().snapshots.set(revisionId, { ...info, tenantId, lexicon });
  return info;
}

/** The demo-mode snapshot of a revision, or null; for tests and the demo pages. */
export function demoLexiconSnapshot(revisionId: string): FrozenLexiconInfo | null {
  const frozen = demoStore().snapshots.get(revisionId);
  return frozen ? { revisionId: frozen.revisionId, lexiconSha256: frozen.lexiconSha256, builtinVersion: frozen.builtinVersion, termCount: frozen.termCount } : null;
}

// ---- The check applied when a program is submitted or approved (design.md C.2, Q3) ----

/**
 * The rules of the policy profile bound to the revision (any approval state: a revoked profile still filters). A revision
 * without a binding has no profile rules; the preflight check of the run refuses to start without a bound, active profile.
 */
export async function policyRulesForRevisionInTransaction(client: PoolClient, revisionId: string): Promise<PolicyRule[]> {
  const bound = await client.query<{ id: string; rules: unknown }>(
    "select p.id, p.rules from show_revision_policy_profiles binding join policy_profiles p on p.tenant_id = binding.tenant_id and p.id = binding.policy_profile_id where binding.show_revision_id = $1",
    [revisionId]
  );
  return bound.rows.flatMap((row) => parsePolicyRules(row.rules));
}

/** The id of the policy profile bound to the revision, or null. */
export async function boundPolicyProfileIdInTransaction(client: PoolClient, revisionId: string): Promise<string | null> {
  return (await client.query<{ policy_profile_id: string }>("select policy_profile_id from show_revision_policy_profiles where show_revision_id = $1", [revisionId])).rows[0]?.policy_profile_id ?? null;
}

const isRunnableKind = (kind: string) => kind === "prepared_product" || kind === "interactive";

/** Runnable segments only: every version of every segment script, in position order. */
export function programScriptVersions(segments: readonly ProgramScriptSegment[]) {
  return segments.flatMap((segment) => isRunnableKind(segment.kind) && segment.runtimeScript ? [{ position: segment.position, scripts: [segment.runtimeScript, ...(segment.runtimeScriptVariants ?? [])] }] : []);
}

/** The number of script versions (primary plus extra) in the program. */
export function programScriptCount(segments: readonly ProgramScriptSegment[]) {
  return programScriptVersions(segments).reduce((total, segment) => total + segment.scripts.length, 0);
}

/** Every version of every runnable segment the broadcast guard refuses, in position and version order. Pure. */
export function programScriptFailures(segments: readonly ProgramScriptSegment[], guard: ProgramScriptGuard): ProgramScriptFailure[] {
  const failures: ProgramScriptFailure[] = [];
  for (const segment of programScriptVersions(segments)) {
    segment.scripts.forEach((text, variantIndex) => {
      const result = guardBroadcastText(text, { policyRules: guard.policyRules, lexicon: guard.lexicon, maxLength: scriptMaxLength });
      if (!result.allowed) failures.push({ position: segment.position, variantIndex, text, decision: result.decision.action, reasons: result.reasons, findings: result.findings });
    });
  }
  return failures;
}

/** The 422 answer for refused scripts. The status text is the error code, which the lifecycle and program-revision routes return as `error`. */
export function programScriptPolicyResponse(failures: ProgramScriptFailure[]) {
  return Response.json({ error: "program_script_policy_blocked", failures }, { status: 422, statusText: "program_script_policy_blocked" });
}

/** Audit only locations and hashes after the caller's transaction has rolled back; never persist blocked script text. */
export async function programScriptPolicyAuditDetail(runId: string, error: Response) {
  const body = await error.clone().json() as { failures?: unknown };
  const failures = Array.isArray(body.failures) ? body.failures.flatMap((failure) => {
    if (!failure || typeof failure !== "object") return [];
    const item = failure as Partial<ProgramScriptFailure>;
    if (typeof item.position !== "number" || !Number.isInteger(item.position) || typeof item.variantIndex !== "number" || !Number.isInteger(item.variantIndex) || typeof item.text !== "string") return [];
    return [{ position: item.position, variantIndex: item.variantIndex, textSha256: createHash("sha256").update(item.text).digest("hex") }];
  }) : [];
  return { runId, failureCount: failures.length, failures };
}

/** Throws the 422 Response when any version of any runnable segment is refused. */
export function assertProgramScriptsAllowed(segments: readonly ProgramScriptSegment[], guard: ProgramScriptGuard) {
  const failures = programScriptFailures(segments, guard);
  if (failures.length > 0) throw programScriptPolicyResponse(failures);
}
