import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { assertLiveRunAccess } from "@/lib/control-plane/run-access";
import type { StoredRun } from "@/lib/control-plane/store";
import { recordAuditEvent, recordAuditEventInTransaction, type AuditEventInput } from "@/lib/audit";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { policyRulesForRunInTransaction } from "@/lib/policy-profiles";
import type { PolicyRule } from "@/lib/policy-engine";
import { guardBroadcastText } from "@/lib/shared/broadcast-guard.mjs";
import type { LexiconTerm } from "@/lib/shared/prohibited-terms.mjs";
import { demoRunLexicon, runLexiconInTransaction } from "@/lib/prohibited-terms";
import { chooseScriptVariant, scriptVariantsProblem } from "@/lib/shared/script-rotation.mjs";

// Script rotation for dispatched program scripts (design.md module C, K4). Version 0 of a segment is its runtime
// script and versions 1..k are its runtime_script_variants. The control plane picks the next version from the
// append-only ledger live_run_script_plays under the live run's row lock and writes the ledger row in the same
// transaction as the media.dispatch outbox event it describes.

/** The control actions that dispatch a segment script; the ledger accepts exactly these (SCHEDULED_START belongs to the worker). */
export type ScriptDispatchAction = "START" | "RECOVER" | "INSERT_PROGRAM" | "ROLLBACK_PROGRAM" | "SCHEDULED_START";
/** A runnable segment of the run's frozen revision with all of its versions; scripts[0] is the primary runtime script. */
export type FrozenRuntimeSegment = { id: string; scripts: string[] };
export type ScriptGuardContext = { policyRules: PolicyRule[]; lexicon: readonly LexiconTerm[] };
export type SelectedScript = {
  segmentId: string;
  variantIndex: number;
  variantCount: number;
  runtimeScript: string;
  scriptSha256: string;
  playSeq: number;
  skipped: number[];
  controlAction: ScriptDispatchAction;
};
export type ScriptPlay = {
  id: string;
  liveRunId: string;
  showRevisionId: string;
  segmentId: string;
  playSeq: number;
  variantIndex: number;
  variantCount: number;
  scriptSha256: string;
  controlAction: ScriptDispatchAction;
  outboxEventId: string;
  skippedVariantIndexes: number[];
  createdAt: string;
};

type LastPlay = { variant_index: number; play_seq: number };
type PersistentPlayRow = {
  id: string;
  live_run_id: string;
  show_revision_id: string;
  segment_id: string;
  play_seq: number;
  variant_index: number;
  variant_count: number;
  script_sha256: string;
  control_action: ScriptDispatchAction;
  outbox_event_id: string;
  skipped_variant_indexes: number[];
  created_at: Date | string;
};

const guardMaxLength = 800;
const listLimit = 200;

/**
 * All versions of a runnable segment as stored (primary script first), or null when the stored extra versions do
 * not have the shape migration 085 enforces. The database makes that impossible; reading still checks, and a
 * segment that fails is treated as not runnable (design.md C.6).
 */
export function frozenScripts(primaryScript: string, rawVariants: unknown): string[] | null {
  let variants: unknown = rawVariants ?? [];
  if (typeof variants === "string") {
    try { variants = JSON.parse(variants); } catch { return null; }
  }
  if (!Array.isArray(variants) || !variants.every((item) => typeof item === "string")) return null;
  if (scriptVariantsProblem(variants, primaryScript) !== null) return null;
  return [primaryScript, ...(variants as string[])];
}

/**
 * The run's policy rules (from the frozen policy profile) and the lexicon the pre-broadcast check uses. Until the
 * tenant lexicon is wired in (design.md module E), the lexicon is the built-in list. A run without an active
 * policy profile is refused by policyRulesForRunInTransaction; the lexicon is the run snapshot union the current tenant lexicon.
 */
export async function scriptGuardContextInTransaction(client: PoolClient, run: StoredRun): Promise<ScriptGuardContext> {
  return { policyRules: await policyRulesForRunInTransaction(client, run.id), lexicon: await runLexiconInTransaction(client, run.id) };
}

/** Demo mode has no policy profile binding, but checks the revision snapshot union the current tenant lexicon. */
export function demoScriptGuardContext(tenantId: string, revisionId?: string): ScriptGuardContext {
  return { policyRules: [], lexicon: demoRunLexicon(tenantId, revisionId ?? "") };
}

/**
 * Chooses the version to dispatch for `segment`: the next one after the segment's last ledger row, skipping versions the
 * broadcast guard refuses. The caller holds the live_runs row lock (for update), and `segment` is a runnable segment of
 * the run's frozen revision. Writes nothing: recordScriptPlayInTransaction writes the ledger row after the outbox event.
 * Throws a 409 `program_script_policy_blocked` Response when every version is refused.
 */
export async function selectScriptForDispatch(client: PoolClient, run: StoredRun, segment: FrozenRuntimeSegment, action: ScriptDispatchAction, guard: ScriptGuardContext): Promise<SelectedScript> {
  const last = (await client.query<LastPlay>(
    "select variant_index, play_seq from live_run_script_plays where live_run_id = $1 and segment_id = $2 order by play_seq desc limit 1",
    [run.id, segment.id]
  )).rows[0] ?? null;
  return chooseForDispatch(last, segment, action, guard);
}

function chooseForDispatch(last: LastPlay | null, segment: FrozenRuntimeSegment, action: ScriptDispatchAction, guard: ScriptGuardContext): SelectedScript {
  const choice = chooseScriptVariant({
    scripts: segment.scripts,
    lastVariantIndex: last && last.variant_index < segment.scripts.length ? last.variant_index : null,
    isAllowed: (script) => guardBroadcastText(script, { policyRules: guard.policyRules, lexicon: guard.lexicon, maxLength: guardMaxLength }).allowed
  });
  if (!choice) throw new Response("Every frozen script version of the segment is blocked", { status: 409, statusText: "program_script_policy_blocked" });
  const runtimeScript = segment.scripts[choice.variantIndex];
  return {
    segmentId: segment.id,
    variantIndex: choice.variantIndex,
    variantCount: segment.scripts.length,
    runtimeScript,
    scriptSha256: createHash("sha256").update(runtimeScript).digest("hex"),
    playSeq: (last?.play_seq ?? 0) + 1,
    skipped: choice.skipped,
    controlAction: action
  };
}

/**
 * Writes the ledger row and the `program_script.variant_selected` audit event for a dispatch whose media.dispatch outbox
 * event is already inserted. Runs in the command's transaction: a failure (for example a key conflict) rolls the command back.
 */
export async function recordScriptPlayInTransaction(client: PoolClient, context: RequestContext, run: StoredRun, selected: SelectedScript, outboxEventId: string) {
  await client.query(
    "insert into live_run_script_plays (tenant_id, live_run_id, show_revision_id, segment_id, play_seq, variant_index, variant_count, script_sha256, control_action, outbox_event_id, skipped_variant_indexes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::int[])",
    [run.tenantId, run.id, run.revisionId, selected.segmentId, selected.playSeq, selected.variantIndex, selected.variantCount, selected.scriptSha256, selected.controlAction, outboxEventId, selected.skipped]
  );
  await recordAuditEventInTransaction(client, context, scriptPlayAudit(run, selected, outboxEventId));
}

function scriptPlayAudit(run: StoredRun, selected: SelectedScript, outboxEventId: string): AuditEventInput {
  return {
    type: "program_script.variant_selected",
    resource: "live_run",
    resourceId: run.id,
    // The audit detail holds scalars only, so the skipped indexes are a comma-separated list ("" when none).
    detail: { segmentId: selected.segmentId, variantIndex: selected.variantIndex, variantCount: selected.variantCount, scriptSha256: selected.scriptSha256, playSeq: selected.playSeq, outboxEventId, skippedVariantIndexes: selected.skipped.join(","), controlAction: selected.controlAction }
  };
}

/** The newest 200 ledger rows of a run: indexes and hashes only, never the script text. */
export async function listScriptPlays(context: RequestContext, runId: string): Promise<ScriptPlay[]> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) throw new Response("Live run not found", { status: 404 });
  await assertLiveRunAccess(context, runId);
  if (!databasePool()) {
    return demoPlays().plays.filter((entry) => entry.tenantId === context.tenantId && entry.play.liveRunId === runId).slice(-listLimit).reverse().map((entry) => entry.play);
  }
  return withTenantTransaction(context.tenantId, async (client) => (await client.query<PersistentPlayRow>(
    `select id, live_run_id, show_revision_id, segment_id, play_seq, variant_index, variant_count, script_sha256, control_action, outbox_event_id, skipped_variant_indexes, created_at
     from live_run_script_plays where live_run_id = $1 order by created_at desc, play_seq desc limit ${listLimit}`,
    [runId]
  )).rows.map(persistentPlay));
}

function persistentPlay(row: PersistentPlayRow): ScriptPlay {
  return {
    id: row.id,
    liveRunId: row.live_run_id,
    showRevisionId: row.show_revision_id,
    segmentId: row.segment_id,
    playSeq: row.play_seq,
    variantIndex: row.variant_index,
    variantCount: row.variant_count,
    scriptSha256: row.script_sha256,
    controlAction: row.control_action,
    outboxEventId: row.outbox_event_id,
    skippedVariantIndexes: row.skipped_variant_indexes ?? [],
    createdAt: new Date(row.created_at).toISOString()
  };
}

// ---- Demo mode: the same algorithm over an in-memory ledger (lost on restart, like every demo store) ----

type DemoPlay = { tenantId: string; play: ScriptPlay };
type DemoPlayStore = { plays: DemoPlay[]; last: Map<string, LastPlay> };
declare global {
  var shuzhirenScriptPlayStore: DemoPlayStore | undefined;
}

function demoPlays(): DemoPlayStore {
  globalThis.shuzhirenScriptPlayStore ??= { plays: [], last: new Map() };
  return globalThis.shuzhirenScriptPlayStore;
}

const demoKey = (runId: string, segmentId: string) => `${runId}:${segmentId}`;

/** Demo-mode counterpart of selectScriptForDispatch; the last version is kept per run and segment in memory. */
export function selectDemoScriptForDispatch(run: StoredRun, segment: FrozenRuntimeSegment, action: ScriptDispatchAction, guard: ScriptGuardContext): SelectedScript {
  return chooseForDispatch(demoPlays().last.get(demoKey(run.id, segment.id)) ?? null, segment, action, guard);
}

/** Demo-mode counterpart of recordScriptPlayInTransaction. */
export async function recordDemoScriptPlay(context: RequestContext, run: StoredRun, selected: SelectedScript, outboxEventId: string) {
  const state = demoPlays();
  state.last.set(demoKey(run.id, selected.segmentId), { variant_index: selected.variantIndex, play_seq: selected.playSeq });
  state.plays.push({
    tenantId: context.tenantId,
    play: {
      id: `script_play_${crypto.randomUUID()}`,
      liveRunId: run.id,
      showRevisionId: run.revisionId,
      segmentId: selected.segmentId,
      playSeq: selected.playSeq,
      variantIndex: selected.variantIndex,
      variantCount: selected.variantCount,
      scriptSha256: selected.scriptSha256,
      controlAction: selected.controlAction,
      outboxEventId,
      skippedVariantIndexes: selected.skipped,
      createdAt: new Date().toISOString()
    }
  });
  await recordAuditEvent(context, scriptPlayAudit(run, selected, outboxEventId));
}
