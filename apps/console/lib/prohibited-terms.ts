import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { parsePolicyRules, type PolicyRule } from "@/lib/shared/policy-engine.mjs";
import { guardBroadcastText } from "@/lib/shared/broadcast-guard.mjs";
import { BUILTIN_LEXICON, BUILTIN_LEXICON_VERSION } from "@/lib/shared/prohibited-terms-builtin.mjs";
import { compileLexicon, effectiveLexicon, lexiconSha256, runtimeLexicon, type Finding, type LexiconTerm, type RawLexiconTerm, type TenantTermRow } from "@/lib/shared/prohibited-terms.mjs";

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
type DemoLexiconStore = { rows: Map<string, TenantTermRow[]>; snapshots: Map<string, DemoFrozenLexicon> };
declare global {
  var shuzhirenProhibitedTermStore: DemoLexiconStore | undefined;
}

function demoStore(): DemoLexiconStore {
  globalThis.shuzhirenProhibitedTermStore ??= { rows: new Map(), snapshots: new Map() };
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
