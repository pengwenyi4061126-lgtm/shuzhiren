import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { LiveCommand, LiveCommandAction, LiveRun, LiveRunState } from "@/lib/domain";
import { canTransition, nextStateFor } from "@/lib/live-run";
import { requireTenantWideAccess, type RequestContext } from "@/lib/control-plane/auth-context";
import { findApprovedProductVersion, frozenProductVersionStatusForRun, frozenProductVersionStatusForRunInTransaction, type ProductVersion } from "@/lib/catalog";
import { evaluatePreflight } from "@/lib/control-plane/preflight";
import { approveShowProgramInTransaction, getShowProgram, hasApprovedFallbackProgram, hasApprovedFallbackProgramInTransaction, registerDemoProgram, updateDemoProgramLifecycle, validateShowProgramInTransaction, type ShowProgram } from "@/lib/show-program";
import { activeMediaAssetStatus, activeMediaAssetStatusInTransaction, currentApprovedMediaAssetsInTransaction, hasApprovedLiveRights, requiredLiveAssetKinds, runtimeVoiceForRun, runtimeVoiceForRunInTransaction, isVoiceChecksum, type RuntimeVoiceBinding } from "@/lib/assets";
import { activeModelReleaseStatus, activeModelReleaseStatusInTransaction, requiredProductionReleaseComponents, type ReleaseComponent } from "@/lib/releases";
import { validateChannelConnection, validateChannelConnectionInTransaction } from "@/lib/channels";
import { evaluateRuntimeReadiness, evaluateRuntimeReadinessInTransaction } from "@/lib/monitoring";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { recordAuditEvent, recordAuditEventInTransaction, type AuditEventInput } from "@/lib/audit";
import { enqueueMediaCommand, enqueueMediaCommandInTransaction, enqueueSpeechCommand, enqueueSpeechCommandInTransaction, type SpeechOutboxEvent } from "@/lib/control-plane/outbox";
import { createMediaCommand, type MediaCommand, type MediaCommandPayload } from "@/lib/media-protocol";
import { createGroundedResponseDraft, type ResponseDraft } from "@/lib/response-draft";
import { createSpeechCommand } from "@/lib/speech-protocol";
import { assertLiveActivationAllowed } from "@/lib/entitlements";
import { activePolicyProfileStatusForRun, activePolicyProfileStatusForRunInTransaction, latestApprovedPolicyProfile, policyRulesForRun } from "@/lib/policy-profiles";
import { createReleaseManifestSnapshotInTransaction, frozenAigcLabelTextInTransaction } from "@/lib/release-manifest";
import { aigcLabelText, evaluateAigcLabelReadiness } from "@/lib/aigc-label";
import { aiDisclosureRuleStatus, aiDisclosureRuleStatusInTransaction } from "@/lib/interaction-rules";
import { evaluateOverlayReadinessForRun } from "@/lib/overlay-scene";
import { demoRunLexicon, programScriptPolicyAuditDetail, runLexiconInTransaction } from "@/lib/prohibited-terms";
import type { PolicyRule } from "@/lib/policy-engine";
import { demoScriptGuardContext, frozenScripts, recordDemoScriptPlay, recordScriptPlayInTransaction, scriptGuardContextInTransaction, selectDemoScriptForDispatch, selectScriptForDispatch, type FrozenRuntimeSegment, type ScriptDispatchAction, type SelectedScript } from "@/lib/script-plays";

export type StoredRun = LiveRun & {
  tenantId: string;
  revisionId: string;
  channelConnectionId?: string;
  productVersionId?: string;
  hasOperator: boolean;
  hasApprovedRights: boolean;
  hasApprovedSkuVersion: boolean;
  hasFallbackProgram: boolean;
  channelReady: boolean;
  outputReady: boolean;
  aiDisclosureEnabled: boolean;
  runtimeSessionId?: string;
  scheduledAt?: string;
};

export type CommandInput = { action: LiveCommandAction; idempotencyKey: string; expectedState: LiveRunState; programSegmentId?: string };
export type RunLifecycleAction = "submit_review" | "approve" | "begin_preflight" | "arm" | "disarm" | "archive";
const runtimeSessionBindingStates = new Set<LiveRunState>(["DRAFT", "REVIEW", "APPROVED", "PREFLIGHT"]);
type CommandIdempotencyRecord = { command: LiveCommand; runId: string };
type Store = { runs: Map<string, StoredRun>; idempotency: Map<string, CommandIdempotencyRecord> };
type PersistentRunRow = {
  id: string;
  tenant_id: string;
  show_revision_id: string;
  show_name: string;
  state: LiveRunState;
  trace_id: string;
  channel_connection_id: string | null;
  product_version_id: string | null;
  has_operator: boolean;
  rights_approved: boolean;
  has_approved_sku_version: boolean;
  has_fallback_program: boolean;
  channel_ready: boolean;
  output_ready: boolean;
  ai_disclosure_enabled: boolean;
  runtime_session_id: string | null;
  scheduled_at: Date | string | null;
  active_program_segment_id: string | null;
  active_insert_source_segment_id: string | null;
  active_insert_program_segment_id: string | null;
  pending_program_transition_event_id: string | null;
};
type PersistentCommandRow = {
  id: string;
  action: LiveCommandAction;
  expected_state: LiveRunState;
  issued_at: Date | string;
  result: unknown;
  actor_name: string;
};

export type GroundedSpeechDispatch = {
  status: "queued" | "handoff";
  draft: ResponseDraft;
  event?: SpeechOutboxEvent;
  duplicate?: boolean;
};

declare global {
  var shuzhirenControlStore: Store | undefined;
}

function initialStore(): Store {
  return {
    runs: new Map([["run_20261101_001", {
      id: "run_20261101_001",
      tenantId: "tenant_demo",
      revisionId: "show_revision_demo_v1",
      channelConnectionId: "channel_demo",
      productVersionId: "pv_a102_v1",
      showName: "双十一预热场 · 美妆专场",
      state: "LIVE",
      traceId: "run_20261101_001",
      hasOperator: true,
      hasApprovedRights: true,
      hasApprovedSkuVersion: true,
      hasFallbackProgram: true,
      channelReady: true,
      outputReady: true,
      aiDisclosureEnabled: true,
      runtimeSessionId: "session_demo_001",
      activeProgramSegmentId: "10000000-0000-4000-8000-000000000002",
      commandHistory: [],
      questions: []
    }]]),
    idempotency: new Map()
  };
}

function store() {
  globalThis.shuzhirenControlStore ??= initialStore();
  return globalThis.shuzhirenControlStore;
}

export async function getRun(context: RequestContext, runId: string) {
  if (!databasePool()) return getDemoRun(context, runId);
  return withTenantTransaction(context.tenantId, async (client) => loadAuthorizedPersistentRun(client, context, runId));
}

export async function listRuns(context: RequestContext) {
  if (!databasePool()) return [...store().runs.values()].filter((run) => run.tenantId === context.tenantId).sort((left, right) => (left.scheduledAt ?? "").localeCompare(right.scheduledAt ?? ""));
  return withTenantTransaction(context.tenantId, async (client) => {
    const scopeClause = restrictedMembership(context)
      ? "where exists (select 1 from membership_resource_scopes scope where scope.membership_id = $1::uuid and ((scope.resource_type = 'live_run' and scope.resource_id = r.id) or (scope.resource_type = 'channel_connection' and scope.resource_id = r.channel_connection_id)))"
      : "";
    const result = await client.query<PersistentRunRow>(`select r.id, r.tenant_id, r.show_revision_id, s.name as show_name, r.state, r.trace_id, r.channel_connection_id, r.product_version_id, r.has_operator, r.rights_approved, r.has_approved_sku_version, r.has_fallback_program, r.channel_ready, r.output_ready, r.ai_disclosure_enabled, r.runtime_session_id, r.scheduled_at, r.active_program_segment_id, r.active_insert_source_segment_id, r.active_insert_program_segment_id, r.pending_program_transition_event_id from live_runs r join show_revisions sr on sr.id = r.show_revision_id join shows s on s.id = sr.show_id ${scopeClause} order by r.scheduled_at asc nulls last, r.created_at desc`, restrictedMembership(context) ? [context.membershipId] : []);
    return result.rows.map((row) => persistentRun(row, []));
  });
}

export async function createLiveRun(context: RequestContext, input: { showName: string; scheduledAt?: string; channelConnectionId: string; productVersionId: string; runtimeSessionId?: string; aiDisclosureEnabled: boolean }) {
  requireTenantWideAccess(context);
  const product = await findApprovedProductVersion(context, input.productVersionId);
  if (!product) throw new Response("An approved product version is required", { status: 409 });
  const channel = await validateChannelConnection(context, input.channelConnectionId, { resolution: "720p", aiDisclosureEnabled: input.aiDisclosureEnabled });
  if (!channel.passed) throw new Response(`Channel is not ready: ${channel.detail}`, { status: 409 });
  if (!databasePool()) {
    const run = await createDemoRun(context, input);
    await recordAuditEvent(context, liveRunCreatedAudit(run, input));
    return run;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const releases = await client.query<{ id: string; component: ReleaseComponent }>("select id, component from model_releases where approval_status = 'approved' and btrim(evidence_ref) <> '' and btrim(validation_summary) <> '' and (evidence_ref ~ '^evidence://[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$' or evidence_ref ~ '^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$') and component = any($1::model_release_component[]) order by approved_at desc", [requiredProductionReleaseComponents]);
    const frozenReleases = new Map<ReleaseComponent, string>();
    for (const release of releases.rows) if (!frozenReleases.has(release.component)) frozenReleases.set(release.component, release.id);
    if (!requiredProductionReleaseComponents.every((component) => frozenReleases.has(component))) throw new Response("Approved runtime, lip-sync, and voice releases are required", { status: 409 });
    const policyProfile = await latestApprovedPolicyProfile(client);
    if (!policyProfile) throw new Response("An approved policy profile is required", { status: 409 });
    const mediaAssets = await currentApprovedMediaAssetsInTransaction(client);
    if (!requiredLiveAssetKinds.every((kind) => mediaAssets.has(kind))) throw new Response("Approved portrait, voice, product clip, and music assets are required", { status: 409 });
    if (!mediaAssets.get("voice")?.runtimeVoiceId) throw new Response("Approved voice asset requires a runtime voice identifier", { status: 409 });
    if (!isVoiceChecksum(mediaAssets.get("voice")?.checksum)) throw new Response("Approved voice asset requires a sha256 voice checksum", { status: 409, statusText: "runtime_voice_binding_unavailable" });
    const show = await client.query<{ id: string }>("insert into shows (tenant_id, name) values ($1, $2) returning id", [context.tenantId, input.showName]);
    const revision = await client.query<{ id: string }>("insert into show_revisions (tenant_id, show_id, revision, plan, approval_status) values ($1, $2, 1, $3::jsonb, 'draft') returning id", [context.tenantId, show.rows[0].id, JSON.stringify({ generatedBy: "run-planner", productVersionId: input.productVersionId, modelReleaseIds: Object.fromEntries(frozenReleases), mediaAssetIds: Object.fromEntries(mediaAssets), policyProfileId: policyProfile.id })]);
    await client.query("insert into show_revision_product_versions (tenant_id, show_revision_id, product_version_id, slot_key) values ($1, $2, $3, 'primary')", [context.tenantId, revision.rows[0].id, input.productVersionId]);
    for (const component of requiredProductionReleaseComponents) await client.query("insert into show_revision_model_releases (tenant_id, show_revision_id, model_release_id, component) values ($1, $2, $3, $4)", [context.tenantId, revision.rows[0].id, frozenReleases.get(component), component]);
    await client.query("insert into show_revision_policy_profiles (tenant_id, show_revision_id, policy_profile_id) values ($1, $2, $3)", [context.tenantId, revision.rows[0].id, policyProfile.id]);
    for (const kind of requiredLiveAssetKinds) await client.query("insert into show_revision_media_assets (tenant_id, show_revision_id, media_asset_id, kind) values ($1, $2, $3, $4)", [context.tenantId, revision.rows[0].id, mediaAssets.get(kind)?.id, kind]);
    const run = await client.query<PersistentRunRow>(`insert into live_runs (tenant_id, show_revision_id, state, trace_id, channel_connection_id, product_version_id, has_operator, rights_approved, has_approved_sku_version, has_fallback_program, channel_ready, output_ready, ai_disclosure_enabled, runtime_session_id, scheduled_at) values ($1, $2, 'DRAFT', $3, $4, $5, true, true, true, false, true, false, $6, $7, $8::timestamptz) returning id, tenant_id, show_revision_id, $9::text as show_name, state, trace_id, channel_connection_id, product_version_id, has_operator, rights_approved, has_approved_sku_version, has_fallback_program, channel_ready, output_ready, ai_disclosure_enabled, runtime_session_id, scheduled_at, active_program_segment_id, active_insert_source_segment_id, active_insert_program_segment_id, pending_program_transition_event_id`, [context.tenantId, revision.rows[0].id, `run_${crypto.randomUUID()}`, input.channelConnectionId, input.productVersionId, input.aiDisclosureEnabled, input.runtimeSessionId ?? null, input.scheduledAt ?? null, input.showName]);
    await client.query(`insert into show_revision_segments (tenant_id, show_revision_id, position, kind, title, duration_seconds, product_version_id, purpose, runtime_script, is_fallback) values ($1, $2, 1, 'prepared_product', '商品讲解', 180, $3, '受审核商品事实', '本段仅讲解已审核商品事实、价格和活动权益。', false), ($1, $2, 2, 'interactive', '受控互动', 120, $3, '仅低风险可追溯问答', '本段只处理低风险、可追溯的已审核问题，其他请求转人工。', false), ($1, $2, 3, 'fallback', '备用节目', 150, $3, '运行异常降级', null, true), ($1, $2, 4, 'human_handoff', '人工接管', 0, null, '高风险人工处理', null, true)`, [context.tenantId, revision.rows[0].id, input.productVersionId]);
    await createReleaseManifestSnapshotInTransaction(client, { tenantId: context.tenantId, revisionId: revision.rows[0].id, runId: run.rows[0].id });
    const created = persistentRun(run.rows[0], []);
    await recordAuditEventInTransaction(client, context, liveRunCreatedAudit(created, input));
    return created;
  });
}

function liveRunCreatedAudit(run: StoredRun, input: { channelConnectionId: string; productVersionId: string }): AuditEventInput {
  return { type: "live_run.created", resource: "live_run", resourceId: run.id, detail: { scheduledAt: run.scheduledAt ?? null, channelConnectionId: input.channelConnectionId, productVersionId: input.productVersionId } };
}

export async function advanceRunLifecycle(context: RequestContext, runId: string, action: RunLifecycleAction) {
  if (!databasePool()) {
    const run = getDemoRun(context, runId);
    if (!run) throw new Response("Live run not found", { status: 404 });
    const next = lifecycleTarget(run.state, action);
    if (action === "arm" && !(await evaluateRunPreflight(context, run)).passed) throw new Response("Preflight requirements are not satisfied", { status: 409 });
    if (reservesRuntimeSession(next) && run.runtimeSessionId && [...store().runs.values()].some((candidate) => candidate.id !== run.id && candidate.tenantId === context.tenantId && candidate.runtimeSessionId === run.runtimeSessionId && reservesRuntimeSession(candidate.state))) throw new Response("Runtime session is already reserved by another active run", { status: 409 });
    let overlaySceneSha256: string | null = null;
    if (action === "submit_review" || action === "approve") {
      try {
        overlaySceneSha256 = await updateDemoProgramLifecycle(run.id, action, context) ?? null;
      } catch (error) {
        if (error instanceof Response && error.statusText === "program_script_policy_blocked") {
          await recordAuditEvent(context, { type: "show_program.script_policy_blocked", resource: "show_revision", resourceId: run.revisionId, detail: await programScriptPolicyAuditDetail(run.id, error) });
        }
        throw error;
      }
    }
    run.state = next;
    if (action === "approve") run.hasFallbackProgram = true;
    await recordAuditEvent(context, { type: `live_run.${action}`, resource: "live_run", resourceId: run.id, detail: { state: run.state, ...(action === "approve" ? { overlaySceneSha256 } : {}) } });
    return run;
  }
  let revisionId: string | null = null;
  try {
    return await withTenantTransaction(context.tenantId, async (client) => {
    if (action === "disarm") {
      const disarmed = await disarmPersistentRun(client, context, runId);
      await recordAuditEventInTransaction(client, context, { type: "live_run.disarm", resource: "live_run", resourceId: disarmed.id, detail: { state: disarmed.state } });
      return disarmed;
    }
    const run = await loadAuthorizedPersistentRun(client, context, runId, true);
    if (!run) throw new Response("Live run not found", { status: 404 });
    revisionId = run.revisionId;
    const next = lifecycleTarget(run.state, action);
    if (action === "submit_review") await validateShowProgramInTransaction(client, run.id, run.revisionId, run.productVersionId);
    const approval = action === "approve" ? await approveShowProgramInTransaction(client, context, run.id, run.revisionId, run.productVersionId) : null;
    if (action === "arm" && !(await evaluateRunPreflightInTransaction(client, context, run)).passed) throw new Response("Preflight requirements are not satisfied", { status: 409 });
    try {
      await client.query("update live_runs set state = $2, has_fallback_program = case when $3 then true else has_fallback_program end, updated_at = now() where id = $1", [run.id, next, action === "approve"]);
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new Response("Runtime session is already reserved by another active run", { status: 409 });
      throw error;
    }
    const updated = { ...run, state: next, hasFallbackProgram: action === "approve" ? true : run.hasFallbackProgram };
    await recordAuditEventInTransaction(client, context, { type: `live_run.${action}`, resource: "live_run", resourceId: run.id, detail: { state: next, ...(action === "approve" ? { overlaySceneSha256: approval?.overlaySceneSha256 ?? null } : {}) } });
    return updated;
    });
  } catch (error) {
    if (error instanceof Response && error.statusText === "program_script_policy_blocked" && revisionId) {
      await recordAuditEvent(context, { type: "show_program.script_policy_blocked", resource: "show_revision", resourceId: revisionId, detail: await programScriptPolicyAuditDetail(runId, error) });
    }
    throw error;
  }
}

function lifecycleTarget(state: LiveRunState, action: RunLifecycleAction): LiveRunState {
  const target = ({ DRAFT: { submit_review: "REVIEW" }, REVIEW: { approve: "APPROVED" }, APPROVED: { begin_preflight: "PREFLIGHT" }, PREFLIGHT: { arm: "ARMED" }, ARMED: { disarm: "PREFLIGHT" }, ENDED: { archive: "ARCHIVED" } } as Partial<Record<LiveRunState, Partial<Record<RunLifecycleAction, LiveRunState>>>>)[state]?.[action];
  if (!target) throw new Response("Lifecycle action is not allowed in current state", { status: 409 });
  return target;
}

async function disarmPersistentRun(client: PoolClient, context: RequestContext, runId: string) {
  const run = await loadAuthorizedPersistentRun(client, context, runId);
  if (!run) throw new Response("Live run not found", { status: 404 });
  const next = lifecycleTarget(run.state, "disarm");
  const pending = await client.query<{ scheduled_start_event_id: string | null }>("select scheduled_start_event_id from live_runs where id = $1", [run.id]);
  const eventId = pending.rows[0]?.scheduled_start_event_id ?? null;
  if (eventId) {
    const cancelled = await client.query<{ id: string }>("update outbox_events set state = 'cancelled', last_error = 'activation_cancelled_by_operator', available_at = now() where id = $1 and state in ('pending', 'failed') returning id", [eventId]);
    if (!cancelled.rows[0]) throw new Response("Pending activation is already delivering or delivered", { status: 409 });
  }
  const updated = await client.query<{ id: string }>("update live_runs set state = $2, scheduled_start_event_id = null, updated_at = now() where id = $1 and state = 'ARMED' and scheduled_start_event_id is not distinct from $3 returning id", [run.id, next, eventId]);
  if (!updated.rows[0]) throw new Response("Live run changed while cancelling activation", { status: 409 });
  return { ...run, state: next };
}

function reservesRuntimeSession(state: LiveRunState) {
  return state === "PREFLIGHT" || state === "ARMED" || state === "LIVE" || state === "DEGRADED";
}

function isUniqueConstraintError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  return "code" in error && (error as { code?: unknown }).code === "23505";
}

async function createDemoRun(context: RequestContext, input: { showName: string; scheduledAt?: string; channelConnectionId: string; productVersionId: string; runtimeSessionId?: string; aiDisclosureEnabled: boolean }) {
  const id = `run_${crypto.randomUUID()}`;
  const revisionId = `show_revision_${crypto.randomUUID()}`;
  const run: StoredRun = { id, tenantId: context.tenantId, revisionId, channelConnectionId: input.channelConnectionId, productVersionId: input.productVersionId, showName: input.showName, state: "DRAFT", traceId: id, scheduledAt: input.scheduledAt, hasOperator: true, hasApprovedRights: await hasApprovedLiveRights(context), hasApprovedSkuVersion: true, hasFallbackProgram: false, channelReady: true, outputReady: false, aiDisclosureEnabled: input.aiDisclosureEnabled, runtimeSessionId: input.runtimeSessionId, commandHistory: [], questions: [] };
  store().runs.set(id, run);
  const program: ShowProgram = { runId: id, tenantId: context.tenantId, revisionId, status: "draft", editable: true, segments: [{ id: `${id}_product`, position: 1, kind: "prepared_product", title: "商品讲解", durationSeconds: 180, productVersionId: input.productVersionId, purpose: "受审核商品事实", fallback: false }, { id: `${id}_interactive`, position: 2, kind: "interactive", title: "受控互动", durationSeconds: 120, productVersionId: input.productVersionId, purpose: "仅低风险可追溯问答", fallback: false }, { id: `${id}_fallback`, position: 3, kind: "fallback", title: "备用节目", durationSeconds: 150, productVersionId: input.productVersionId, purpose: "运行异常降级", fallback: true }, { id: `${id}_handoff`, position: 4, kind: "human_handoff", title: "人工接管", durationSeconds: 0, purpose: "高风险人工处理", fallback: true }] };
  registerDemoProgram(program);
  return run;
}

function getDemoRun(context: RequestContext, runId: string) {
  const run = store().runs.get(runId);
  if (!run || run.tenantId !== context.tenantId) return null;
  // Retain a stable fixture across development hot reloads; production records use durable bindings.
  if (run.id === "run_20261101_001" && !run.productVersionId) run.productVersionId = "pv_a102_v1";
  if (run.id === "run_20261101_001" && !run.channelConnectionId) run.channelConnectionId = "channel_demo";
  return run;
}

export async function evaluateRunPreflight(context: RequestContext, run: StoredRun) {
  if (databasePool()) return withTenantTransaction(context.tenantId, async (client) => evaluateRunPreflightInTransaction(client, context, run), { readOnly: true });
  const [channel, runtime, policyProfile, modelRelease, mediaAssets, product, aiDisclosureRule, aigcLabel, overlay] = await Promise.all([
    validateChannelConnection(context, run.channelConnectionId, { resolution: "720p", aiDisclosureEnabled: run.aiDisclosureEnabled }),
    evaluateRuntimeReadiness(context, run.id),
    activePolicyProfileStatusForRun(context, run.id),
    activeModelReleaseStatus(context, run.revisionId),
    activeMediaAssetStatus(context, run.revisionId),
    frozenProductVersionStatusForRun(context, run.id, run.productVersionId),
    aiDisclosureRuleStatus(context),
    evaluateAigcLabelReadiness(),
    evaluateOverlayReadinessForRun(null, run.id, run.revisionId)
  ]);
  return composeRunPreflight(run, { channel, runtime, policyProfile, modelRelease, mediaAssets, product, aiDisclosureRule, aigcLabel, overlay, hasFallbackProgram: await hasApprovedFallbackProgram(context, run.id) });
}

// Reads every preflight input on the caller's client, one query at a time, so
// lifecycle and command transactions that already hold a connection (and the
// live run lock) neither take more connections from the pool nor read outside
// their own snapshot.
export async function evaluateRunPreflightInTransaction(client: PoolClient, context: RequestContext, run: StoredRun) {
  const channel = await validateChannelConnectionInTransaction(client, context, run.channelConnectionId, { resolution: "720p", aiDisclosureEnabled: run.aiDisclosureEnabled });
  const runtime = await evaluateRuntimeReadinessInTransaction(client, context, run.id);
  const policyProfile = await activePolicyProfileStatusForRunInTransaction(client, context, run.id);
  const modelRelease = await activeModelReleaseStatusInTransaction(client, run.revisionId);
  const mediaAssets = await activeMediaAssetStatusInTransaction(client, run.revisionId);
  const product = await frozenProductVersionStatusForRunInTransaction(client, run.id);
  const hasFallbackProgram = await hasApprovedFallbackProgramInTransaction(client, context, run.id);
  // A failed read throws, so the arm or START transaction rolls back instead of treating the check as passed.
  const aiDisclosureRule = await aiDisclosureRuleStatusInTransaction(client);
  // The run's sealed label text (release manifest snapshot), then the Gateway health with a bounded timeout.
  const aigcLabel = await evaluateAigcLabelReadiness(await frozenAigcLabelTextInTransaction(client, run.id) ?? aigcLabelText());
  const overlay = await evaluateOverlayReadinessForRun(client, run.id);
  return composeRunPreflight(run, { channel, runtime, policyProfile, modelRelease, mediaAssets, product, aiDisclosureRule, aigcLabel, overlay, hasFallbackProgram });
}

type RunPreflightInputs = {
  channel: { passed: boolean; detail: string };
  runtime: { passed: boolean; detail: string };
  policyProfile: { active: boolean; detail: string };
  modelRelease: { active: boolean; detail: string };
  mediaAssets: { active: boolean; detail: string };
  product: { active: boolean; detail: string };
  aiDisclosureRule: { passed: boolean; detail: string };
  aigcLabel: { passed: boolean; detail: string };
  overlay: { passed: boolean; detail: string };
  hasFallbackProgram: boolean;
};

function composeRunPreflight(run: StoredRun, { channel, runtime, policyProfile, modelRelease, mediaAssets, product, aiDisclosureRule, aigcLabel, overlay, hasFallbackProgram }: RunPreflightInputs) {
  return evaluatePreflight({
    ...run,
    hasApprovedRights: mediaAssets.active,
    hasApprovedModelReleases: modelRelease.active,
    modelReleaseDetail: modelRelease.detail,
    rightsDetail: mediaAssets.detail,
    hasApprovedPolicyProfile: policyProfile.active,
    policyProfileDetail: policyProfile.detail,
    hasApprovedSkuVersion: product.active,
    skuDetail: product.detail,
    hasFallbackProgram,
    channelReady: channel.passed,
    channelDetail: channel.detail,
    // output_ready was an early manual flag. A fresh observer sample is the only
    // authoritative proof that the current runtime/output path is usable.
    outputReady: runtime.passed,
    outputDetail: runtime.passed ? runtime.detail : `运行时探针未通过：${runtime.detail}`,
    runtimeSessionReady: Boolean(run.runtimeSessionId),
    runtimeSessionDetail: run.runtimeSessionId ? `已绑定运行时会话 ${run.runtimeSessionId}` : "尚未绑定 LiveTalking 运行时会话",
    aiDisclosureRuleReady: aiDisclosureRule.passed,
    aiDisclosureRuleDetail: aiDisclosureRule.detail,
    aigcLabelReady: aigcLabel.passed,
    aigcLabelDetail: aigcLabel.detail,
    overlayReady: overlay.passed,
    overlayDetail: overlay.detail
  });
}

type RuntimeDegradation = { changed: true; mediaType: "switch_to_fallback" | "switch_to_human"; mediaEvent?: { id: string; command: MediaCommand } };

// `audit` builds the audit event of a degradation; it is written in the degradation's transaction, so a failed
// audit write rolls back the DEGRADED state and its media command.
export async function degradeRunFromRuntime(context: RequestContext, runId: string, input: { fallbackReady: boolean; reasons: string[]; audit?: (degradation: RuntimeDegradation) => AuditEventInput | null }) {
  const mediaType = input.fallbackReady ? "switch_to_fallback" as const : "switch_to_human" as const;
  if (!databasePool()) {
    const run = getDemoRun(context, runId);
    if (!run || run.state !== "LIVE") return { changed: false as const };
    run.state = "DEGRADED";
    const mediaEvent = run.runtimeSessionId ? await enqueueMediaCommand(context, { runId: run.id, traceId: run.traceId, type: mediaType, payload: { controlAction: "RUNTIME_GUARD", reasons: input.reasons.join(",") }, sessionId: run.runtimeSessionId }) : undefined;
    const degradation = { changed: true as const, mediaType, mediaEvent };
    const audit = input.audit?.(degradation);
    if (audit) await recordAuditEvent(context, audit);
    return degradation;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const run = await loadAuthorizedPersistentRun(client, context, runId, true);
    if (!run || run.state !== "LIVE") return { changed: false as const };
    await client.query("update live_runs set state = 'DEGRADED', updated_at = now() where id = $1", [run.id]);
    const mediaEvent = run.runtimeSessionId ? await enqueueMediaCommandInTransaction(client, context, createMediaCommand({ runId: run.id, traceId: run.traceId, type: mediaType, payload: { controlAction: "RUNTIME_GUARD", reasons: input.reasons.join(",") } }), run.runtimeSessionId) : undefined;
    const degradation = { changed: true as const, mediaType, mediaEvent };
    const audit = input.audit?.(degradation);
    if (audit) await recordAuditEventInTransaction(client, context, audit);
    return degradation;
  });
}

function commandAuditEvents(runId: string, input: CommandInput, command: LiveCommand, mediaEvent: { id: string; command: MediaCommand }): AuditEventInput[] {
  return [
    { type: "live_command.accepted", resource: "live_run", resourceId: runId, detail: { action: input.action, commandId: command.id, programSegmentId: input.programSegmentId ?? null } },
    { type: "media_command.enqueued", resource: "outbox_event", resourceId: mediaEvent.id, detail: { mediaCommandId: mediaEvent.command.id, commandType: mediaEvent.command.type, controlAction: input.action, programSegmentId: input.programSegmentId ?? null } }
  ];
}

export async function issueCommand(context: RequestContext, runId: string, input: CommandInput) {
  if (!databasePool()) {
    const result = await issueDemoCommand(context, runId, input);
    if (!result.duplicate) for (const event of commandAuditEvents(runId, input, result.command, result.mediaEvent)) await recordAuditEvent(context, event);
    return result;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const run = await loadAuthorizedPersistentRun(client, context, runId, true);
    if (!run) throw new Response("Live run not found", { status: 404 });

    const duplicate = await findCommandByIdempotency(client, input.idempotencyKey);
    if (duplicate) {
      if (!sameCommandInput(duplicate, run.id, input)) throw new Response("Command idempotency key was already used with different content", { status: 409 });
      return { command: duplicate.command, run, duplicate: true as const };
    }
    if (run.state !== input.expectedState) throw new Response("Live run state changed", { status: 409 });
    if (!canTransition(run.state, input.action)) throw new Response("Command is not allowed in current state", { status: 409 });
    if (!run.runtimeSessionId) throw new Response("Runtime session is not bound", { status: 409 });
    const requiresActivationConfirmation = input.action === "START" || input.action === "RECOVER";
    const requiresEndConfirmation = input.action === "END";
    const isProgramTransition = input.action === "INSERT_PROGRAM" || input.action === "ROLLBACK_PROGRAM";
    if (input.action === "START" && !(await evaluateRunPreflightInTransaction(client, context, run)).passed) {
      throw new Response("Preflight requirements are not satisfied", { status: 409 });
    }
    if (input.action === "RECOVER" && !(await activeMediaAssetStatusInTransaction(client, run.revisionId)).active) {
      throw new Response("Frozen media asset rights are not active for recovery", { status: 409 });
    }
    if (input.action === "RECOVER" && !(await activeModelReleaseStatusInTransaction(client, run.revisionId)).active) {
      throw new Response("Frozen model releases are not active for recovery", { status: 409 });
    }
    if (input.action === "RECOVER" && !(await evaluateRuntimeReadinessInTransaction(client, context, run.id)).passed) {
      throw new Response("Runtime health is not ready for recovery", { status: 409 });
    }
    if (input.action === "START" || input.action === "RECOVER") await assertLiveActivationAllowed(client, context, run.id);
    if (requiresActivationConfirmation) {
      const pending = await client.query<{ scheduled_start_event_id: string | null }>("select scheduled_start_event_id from live_runs where id = $1", [run.id]);
      if (pending.rows[0]?.scheduled_start_event_id) throw new Response("A runtime activation command is already pending confirmation", { status: 409 });
    }
    if (requiresEndConfirmation) {
      const pending = await client.query<{ pending_media_event_id: string | null }>("select pending_media_event_id from live_runs where id = $1", [run.id]);
      if (pending.rows[0]?.pending_media_event_id) throw new Response("A runtime stop command is already pending confirmation", { status: 409 });
    }
    const activationProgram = requiresActivationConfirmation ? await resolveActivationProgram(client, run) : undefined;
    const programTransition = isProgramTransition ? await resolveProgramTransition(client, run, input) : undefined;
    // A command that carries a script must carry the frozen voice the Gateway synthesizes it with; without
    // one the command is refused here instead of being queued for a certain Gateway rejection.
    const programVoice = (programTransition?.target ?? activationProgram) ? await runtimeVoiceForRunInTransaction(client, run.revisionId) : undefined;
    // The segment's next script version is chosen from the rotation ledger under the run lock; when every version is
    // refused by the pre-broadcast check the command is rejected before anything is written.
    const dispatchSegment = programTransition?.target ?? activationProgram;
    const selectedScript = dispatchSegment ? await selectScriptForDispatch(client, run, dispatchSegment, input.action as ScriptDispatchAction, await scriptGuardContextInTransaction(client, run)) : undefined;

    const nextState = nextStateFor(run.state, input.action);
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const inserted = await client.query<PersistentCommandRow>(
      "insert into live_commands (tenant_id, live_run_id, actor_id, idempotency_key, expected_state, action, result) values ($1, $2, $3, $4, $5, $6, $7::jsonb) returning id, action, expected_state, issued_at, result, $8::text as actor_name",
      [context.tenantId, run.id, actor.rows[0].id, input.idempotencyKey, input.expectedState, input.action, JSON.stringify({ status: "accepted", programSegmentId: programTransition?.target?.id ?? activationProgram?.id ?? null, sourceProgramSegmentId: programTransition?.source?.id ?? null }), context.actorName]
    );
    const command = persistentCommand(inserted.rows[0]);
    const overlayScene = input.action === "START" || input.action === "RECOVER" ? await overlaySceneForRunInTransaction(client, run) : undefined;
    const mediaEvent = await enqueueMediaCommandInTransaction(client, context, createMediaCommand(mediaCommandFor(run, input.action, programTransition, activationProgram, programVoice, selectedScript, overlayScene)), run.runtimeSessionId);
    // The command, its outbox event, the rotation ledger row and their audit events commit together: a failed
    // write rolls back the command instead of leaving an unaudited command queued for the runtime.
    for (const event of commandAuditEvents(runId, input, command, mediaEvent)) await recordAuditEventInTransaction(client, context, event);
    if (selectedScript) await recordScriptPlayInTransaction(client, context, run, selectedScript, mediaEvent.id);
    if (requiresActivationConfirmation) {
      await client.query("update live_runs set scheduled_start_event_id = $2, updated_at = now() where id = $1 and state = $3 and scheduled_start_event_id is null", [run.id, mediaEvent.id, run.state]);
      return { command, mediaEvent, run: { ...run, commandHistory: [command, ...run.commandHistory] }, duplicate: false as const };
    }
    if (requiresEndConfirmation) {
      await client.query("update live_runs set pending_media_event_id = $2, updated_at = now() where id = $1 and state = $3 and pending_media_event_id is null", [run.id, mediaEvent.id, run.state]);
      return { command, mediaEvent, run: { ...run, commandHistory: [command, ...run.commandHistory] }, duplicate: false as const };
    }
    if (programTransition) {
      const updated = await client.query("update live_runs set pending_program_transition_event_id = $2, updated_at = now() where id = $1 and pending_program_transition_event_id is null returning id", [run.id, mediaEvent.id]);
      if (!updated.rows[0]) throw new Response("A program transition is already pending runtime confirmation", { status: 409 });
      return { command, mediaEvent, run: { ...run, pendingProgramTransitionEventId: mediaEvent.id, commandHistory: [command, ...run.commandHistory] }, duplicate: false as const };
    }
    await client.query("update live_runs set state = $2, updated_at = now() where id = $1", [run.id, nextState]);
    return { command, mediaEvent, run: { ...run, state: nextState, commandHistory: [command, ...run.commandHistory] }, duplicate: false as const };
  });
}

type ProgramTransition = { kind: "insert" | "rollback"; target?: FrozenRuntimeSegment; source?: FrozenRuntimeSegment };

async function resolveActivationProgram(client: PoolClient, run: StoredRun): Promise<FrozenRuntimeSegment | undefined> {
  if (run.activeProgramSegmentId) {
    const current = await loadFrozenRuntimeSegment(client, run, run.activeProgramSegmentId);
    if (current) return current;
  }
  const initial = await client.query<{ id: string; runtime_script: string; runtime_script_variants: unknown }>("select id, runtime_script, runtime_script_variants from show_revision_segments where show_revision_id = $1 and tenant_id = $2 and kind in ('prepared_product', 'interactive') and runtime_script is not null order by position", [run.revisionId, run.tenantId]);
  for (const row of initial.rows) {
    // A segment whose stored versions have an invalid shape is not runnable; the first valid one is the baseline.
    const scripts = frozenScripts(row.runtime_script, row.runtime_script_variants);
    if (scripts) return { id: row.id, scripts };
  }
  return undefined;
}

async function resolveProgramTransition(client: PoolClient, run: StoredRun, input: CommandInput): Promise<ProgramTransition> {
  if (run.pendingProgramTransitionEventId) throw new Response("A program transition is already pending runtime confirmation", { status: 409 });
  if (input.action === "INSERT_PROGRAM") {
    if (run.activeInsertProgramSegmentId) throw new Response("An accepted program insertion must be rolled back before another insertion", { status: 409 });
    if (!input.programSegmentId || !isUuid(input.programSegmentId)) throw new Response("A frozen program segment is required", { status: 400 });
    const target = await loadFrozenRuntimeSegment(client, run, input.programSegmentId);
    if (!target) throw new Response("Program segment is not runnable in this frozen revision", { status: 409 });
    const source = run.activeProgramSegmentId ? await loadFrozenRuntimeSegment(client, run, run.activeProgramSegmentId) : undefined;
    return { kind: "insert", target, source: source ?? undefined };
  }
  if (!run.activeInsertProgramSegmentId) throw new Response("No accepted program insertion is available to roll back", { status: 409 });
  const source = run.activeInsertSourceSegmentId ? await loadFrozenRuntimeSegment(client, run, run.activeInsertSourceSegmentId) : undefined;
  return { kind: "rollback", target: source ?? undefined, source: source ?? undefined };
}

async function loadFrozenRuntimeSegment(client: PoolClient, run: StoredRun, segmentId: string): Promise<FrozenRuntimeSegment | null> {
  const result = await client.query<{ id: string; runtime_script: string; runtime_script_variants: unknown }>("select id, runtime_script, runtime_script_variants from show_revision_segments where id = $1 and show_revision_id = $2 and tenant_id = $3 and kind in ('prepared_product', 'interactive') and runtime_script is not null", [segmentId, run.revisionId, run.tenantId]);
  const row = result.rows[0];
  const scripts = row ? frozenScripts(row.runtime_script, row.runtime_script_variants) : null;
  return row && scripts ? { id: row.id, scripts } : null;
}

export async function enqueueGroundedSpeech(context: RequestContext, runId: string, question: string, idempotencyKey: string): Promise<GroundedSpeechDispatch> {
  const policyRules = await policyRulesForRun(context, runId);
  if (!databasePool()) {
    const run = getDemoRun(context, runId);
    if (!run) throw new Response("Live run not found", { status: 404 });
    if (!(await activeMediaAssetStatus(context, run.revisionId)).active) throw new Response("Frozen media asset rights are not active for speech dispatch", { status: 409 });
    if (!(await activeModelReleaseStatus(context, run.revisionId)).active) throw new Response("Frozen model releases are not active for speech dispatch", { status: 409 });
    const product = await frozenProductVersionStatusForRun(context, run.id, run.productVersionId);
    if (!product.active || !product.version) throw new Response("Frozen product version is not active for speech dispatch", { status: 409 });
    return enqueueDemoGroundedSpeech(context, run, product.version, question, await runtimeVoiceForRun(context, run.revisionId), idempotencyKey, policyRules);
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const run = await loadAuthorizedPersistentRun(client, context, runId, true);
    if (!run) throw new Response("Live run not found", { status: 404 });
    if (!(await activeMediaAssetStatusInTransaction(client, run.revisionId)).active) throw new Response("Frozen media asset rights are not active for speech dispatch", { status: 409 });
    if (!(await activeModelReleaseStatusInTransaction(client, run.revisionId)).active) throw new Response("Frozen model releases are not active for speech dispatch", { status: 409 });
    const product = await frozenProductVersionStatusForRunInTransaction(client, run.id);
    if (!product.active || !product.version) throw new Response("Frozen product version is not active for speech dispatch", { status: 409 });
    return enqueueGroundedSpeechInTransaction(client, context, run, product.version, question, await runtimeVoiceForRunInTransaction(client, run.revisionId), idempotencyKey, policyRules);
  });
}

async function enqueueDemoGroundedSpeech(context: RequestContext, run: StoredRun, version: ProductVersion, question: string, voice: RuntimeVoiceBinding, idempotencyKey: string, policyRules: PolicyRule[]): Promise<GroundedSpeechDispatch> {
  assertSpeechReadyRun(run);
  const draft = createGroundedResponseDraft(question, version, policyRules, demoRunLexicon(context.tenantId, run.revisionId));
  if (draft.blockedByLexicon) throw new Response("Grounded speech text is blocked by the prohibited-term lexicon", { status: 409, statusText: "speech_text_blocked" });
  if (draft.status !== "ready" || !draft.text) {
    await recordAuditEvent(context, { type: "speech_dispatch.handoff_required", resource: "live_run", resourceId: run.id, detail: { productVersionId: version.id, revision: version.revision, decision: draft.decision.action, questionSha256: questionHash(question) } });
    return { status: "handoff", draft };
  }
  const queued = await enqueueSpeechCommand(context, { runId: run.id, traceId: run.traceId, text: draft.text, voice: voice.runtimeVoiceId, voiceChecksum: voice.voiceChecksum, productVersionId: version.id, productRevision: version.revision, sessionId: run.runtimeSessionId!, idempotencyKey });
  if (!queued.duplicate) await recordAuditEvent(context, { type: "speech_dispatch.queued", resource: "live_run", resourceId: run.id, detail: { productVersionId: version.id, revision: version.revision, speechCommandId: queued.event.command.id, outboxEventId: queued.event.id, questionSha256: questionHash(question) } });
  return { status: "queued", draft, event: queued.event, duplicate: queued.duplicate };
}

async function enqueueGroundedSpeechInTransaction(client: PoolClient, context: RequestContext, run: StoredRun, version: ProductVersion, question: string, voice: RuntimeVoiceBinding, idempotencyKey: string, policyRules: PolicyRule[]): Promise<GroundedSpeechDispatch> {
  assertSpeechReadyRun(run);
  const draft = createGroundedResponseDraft(question, version, policyRules, await runLexiconInTransaction(client, run.id));
  if (draft.blockedByLexicon) throw new Response("Grounded speech text is blocked by the prohibited-term lexicon", { status: 409, statusText: "speech_text_blocked" });
  if (draft.status !== "ready" || !draft.text) {
    await recordAuditEventInTransaction(client, context, { type: "speech_dispatch.handoff_required", resource: "live_run", resourceId: run.id, detail: { productVersionId: version.id, revision: version.revision, decision: draft.decision.action, questionSha256: questionHash(question) } });
    return { status: "handoff", draft };
  }
  const command = createSpeechCommand({ runId: run.id, traceId: run.traceId, text: draft.text, voice: voice.runtimeVoiceId, voiceChecksum: voice.voiceChecksum, productVersionId: version.id, productRevision: version.revision, idempotencyKey });
  const queued = await enqueueSpeechCommandInTransaction(client, context, command, run.runtimeSessionId!);
  if (!queued.duplicate) await recordAuditEventInTransaction(client, context, { type: "speech_dispatch.queued", resource: "live_run", resourceId: run.id, detail: { productVersionId: version.id, revision: version.revision, speechCommandId: command.id, outboxEventId: queued.event.id, questionSha256: questionHash(question) } });
  return { status: "queued", draft, event: queued.event, duplicate: queued.duplicate };
}

function assertSpeechReadyRun(run: StoredRun) {
  if (run.state !== "LIVE") throw new Response("Live run must be active before speech dispatch", { status: 409 });
  if (!run.runtimeSessionId) throw new Response("Runtime session is not bound", { status: 409 });
}

function questionHash(question: string) { return createHash("sha256").update(question).digest("hex"); }

async function issueDemoCommand(context: RequestContext, runId: string, input: CommandInput) {
  const activeStore = store();
  const run = getDemoRun(context, runId);
  if (!run) throw new Response("Live run not found", { status: 404 });

  const existing = activeStore.idempotency.get(`${context.tenantId}:${input.idempotencyKey}`);
  if (existing) {
    if (!sameCommandInput(existing, run.id, input)) throw new Response("Command idempotency key was already used with different content", { status: 409 });
    return { command: existing.command, run, duplicate: true as const };
  }
  if (run.state !== input.expectedState) throw new Response("Live run state changed", { status: 409 });
  if (!canTransition(run.state, input.action)) throw new Response("Command is not allowed in current state", { status: 409 });
  if (!run.runtimeSessionId) throw new Response("Runtime session is not bound", { status: 409 });
  if (input.action === "START" && !(await evaluateRunPreflight(context, run)).passed) {
    throw new Response("Preflight requirements are not satisfied", { status: 409 });
  }
  if (input.action === "RECOVER" && !(await activeMediaAssetStatus(context, run.revisionId)).active) {
    throw new Response("Frozen media asset rights are not active for recovery", { status: 409 });
  }
  if (input.action === "RECOVER" && !(await activeModelReleaseStatus(context, run.revisionId)).active) {
    throw new Response("Frozen model releases are not active for recovery", { status: 409 });
  }
  if (input.action === "RECOVER" && !(await evaluateRuntimeReadiness(context, run.id)).passed) {
    throw new Response("Runtime health is not ready for recovery", { status: 409 });
  }
  const activationProgram = input.action === "START" || input.action === "RECOVER" ? await resolveDemoActivationProgram(context, run) : undefined;
  const programTransition = input.action === "INSERT_PROGRAM" || input.action === "ROLLBACK_PROGRAM" ? await resolveDemoProgramTransition(context, run, input) : undefined;
  const programVoice = (programTransition?.target ?? activationProgram) ? await runtimeVoiceForRun(context, run.revisionId) : undefined;

  const command: LiveCommand = {
    id: `cmd_${crypto.randomUUID()}`,
    action: input.action,
    actorName: context.actorName,
    issuedAt: new Date().toISOString(),
    expectedState: input.expectedState,
    result: "accepted",
    programSegmentId: programTransition?.target?.id ?? activationProgram?.id
  };
  const dispatchSegment = programTransition?.target ?? activationProgram;
  const selectedScript = dispatchSegment ? selectDemoScriptForDispatch(run, dispatchSegment, input.action as ScriptDispatchAction, demoScriptGuardContext(context.tenantId, run.revisionId)) : undefined;
  const overlayScene = input.action === "START" || input.action === "RECOVER" ? demoOverlaySceneForRun(run) : undefined;
  const mediaEvent = await enqueueMediaCommand(context, { ...mediaCommandFor(run, input.action, programTransition, activationProgram, programVoice, selectedScript, overlayScene), sessionId: run.runtimeSessionId });
  if (selectedScript) await recordDemoScriptPlay(context, run, selectedScript, mediaEvent.id);
  if (programTransition) {
    run.activeProgramSegmentId = programTransition.target?.id;
    run.activeInsertSourceSegmentId = programTransition.kind === "insert" ? programTransition.source?.id : undefined;
    run.activeInsertProgramSegmentId = programTransition.kind === "insert" ? programTransition.target?.id : undefined;
  } else {
    if (activationProgram) run.activeProgramSegmentId = activationProgram.id;
    run.state = nextStateFor(run.state, input.action);
  }
  run.commandHistory.unshift(command);
  activeStore.idempotency.set(`${context.tenantId}:${input.idempotencyKey}`, { command, runId: run.id });
  return { command, mediaEvent, run, duplicate: false as const };
}

async function resolveDemoProgramTransition(context: RequestContext, run: StoredRun, input: CommandInput): Promise<ProgramTransition> {
  if (run.pendingProgramTransitionEventId) throw new Response("A program transition is already pending runtime confirmation", { status: 409 });
  const program = await getShowProgram(context, run.id);
  if (!program) throw new Response("Show program not found", { status: 404 });
  const runnable = (segmentId: string | undefined) => program.segments.find((segment) => segment.id === segmentId && (segment.kind === "prepared_product" || segment.kind === "interactive") && Boolean(segment.runtimeScript));
  if (input.action === "INSERT_PROGRAM") {
    if (run.activeInsertProgramSegmentId) throw new Response("An accepted program insertion must be rolled back before another insertion", { status: 409 });
    const target = demoFrozenSegment(runnable(input.programSegmentId));
    if (!target) throw new Response("Program segment is not runnable in this frozen revision", { status: 409 });
    return { kind: "insert", target, source: demoFrozenSegment(runnable(run.activeProgramSegmentId)) };
  }
  if (!run.activeInsertProgramSegmentId) throw new Response("No accepted program insertion is available to roll back", { status: 409 });
  const source = demoFrozenSegment(runnable(run.activeInsertSourceSegmentId));
  return { kind: "rollback", target: source, source };
}

// A demo segment as the frozen runnable segment the dispatch rotates over: the primary script followed by its extra versions.
function demoFrozenSegment(segment: ShowProgram["segments"][number] | undefined): FrozenRuntimeSegment | undefined {
  if (!segment?.runtimeScript) return undefined;
  const scripts = frozenScripts(segment.runtimeScript, segment.runtimeScriptVariants);
  return scripts ? { id: segment.id, scripts } : undefined;
}

async function resolveDemoActivationProgram(context: RequestContext, run: StoredRun): Promise<FrozenRuntimeSegment | undefined> {
  const program = await getShowProgram(context, run.id);
  if (!program) throw new Response("Show program not found", { status: 404 });
  const runnable = (segmentId: string | undefined) => program.segments.find((segment) => segment.id === segmentId && (segment.kind === "prepared_product" || segment.kind === "interactive") && Boolean(segment.runtimeScript));
  const target = runnable(run.activeProgramSegmentId) ?? program.segments.find((segment) => (segment.kind === "prepared_product" || segment.kind === "interactive") && Boolean(segment.runtimeScript));
  return demoFrozenSegment(target);
}

async function overlaySceneForRunInTransaction(client: PoolClient, run: StoredRun) {
  const result = await client.query<{ caption_enabled: boolean; product_card_enabled: boolean; price_sticker_enabled: boolean; background_mode: string; scene_json: string | null; scene_sha256: string | null }>(
    "select o.caption_enabled, o.product_card_enabled, o.price_sticker_enabled, o.background_mode, o.scene_json, o.scene_sha256 from show_revision_overlays o where o.tenant_id = $1 and o.show_revision_id = $2",
    [run.tenantId, run.revisionId]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const enabled = row.caption_enabled || row.product_card_enabled || row.price_sticker_enabled || row.background_mode !== "none";
  if (!row.scene_json && !row.scene_sha256) {
    if (enabled) throw new Response("Frozen overlay scene is unavailable", { status: 409, statusText: "overlay_scene_unavailable" });
    return undefined;
  }
  const sceneSha256 = row.scene_sha256?.trimEnd();
  if (!row.scene_json || !sceneSha256 || createHash("sha256").update(row.scene_json, "utf8").digest("hex") !== sceneSha256) throw new Response("Frozen overlay scene hash is invalid", { status: 409, statusText: "overlay_scene_hash_invalid" });
  return { sceneJson: row.scene_json, sceneSha256 };
}

function demoOverlaySceneForRun(run: StoredRun) {
  const record = (globalThis as typeof globalThis & { shuzhirenOverlayStore?: { overlays: Map<string, { captionEnabled: boolean; productCardEnabled: boolean; priceStickerEnabled: boolean; backgroundMode: string; sceneJson: string | null; sceneSha256: string | null }> } }).shuzhirenOverlayStore?.overlays.get(run.revisionId);
  if (!record) return undefined;
  const enabled = record.captionEnabled || record.productCardEnabled || record.priceStickerEnabled || record.backgroundMode !== "none";
  if (!record.sceneJson && !record.sceneSha256) {
    if (enabled) throw new Response("Frozen overlay scene is unavailable", { status: 409, statusText: "overlay_scene_unavailable" });
    return undefined;
  }
  if (!record.sceneJson || !record.sceneSha256 || createHash("sha256").update(record.sceneJson, "utf8").digest("hex") !== record.sceneSha256) throw new Response("Frozen overlay scene hash is invalid", { status: 409, statusText: "overlay_scene_hash_invalid" });
  return { sceneJson: record.sceneJson, sceneSha256: record.sceneSha256 };
}

export function mediaCommandFor(run: StoredRun, action: LiveCommandAction, transition?: ProgramTransition, activationProgram?: FrozenRuntimeSegment, voice?: RuntimeVoiceBinding, selected?: SelectedScript, overlayScene?: { sceneJson: string; sceneSha256: string }): Omit<MediaCommand, "id" | "issuedAt"> {
  const typeByAction = { START: "start_program", PAUSE: "switch_to_fallback", HANDOFF: "switch_to_human", RECOVER: "start_program", END: "stop_program", INSERT_PROGRAM: "insert_program", ROLLBACK_PROGRAM: "resume_program" } as const;
  // START/RECOVER carry the activation baseline segment and INSERT/ROLLBACK their target, each with the
  // frozen voice that the Gateway synthesizes the script with.
  const segment = transition?.target ?? activationProgram;
  if (segment && !voice) throw new Response("Frozen voice asset is not approved for runtime speech", { status: 409, statusText: "runtime_voice_binding_unavailable" });
  const transitionPayload: Record<string, string> = transition ? { programTransition: transition.kind, ...(transition.source ? { sourceProgramSegmentId: transition.source.id } : {}), ...(run.activeInsertProgramSegmentId ? { insertedProgramSegmentId: run.activeInsertProgramSegmentId } : {}) } : {};
  // The script is the version selected for this dispatch (selectScriptForDispatch), never the primary by default.
  if (segment && (!selected || selected.segmentId !== segment.id)) throw new Error("A dispatched program segment requires its selected script version");
  const segmentPayload: Record<string, string> = segment && selected && voice ? { programSegmentId: segment.id, runtimeScript: selected.runtimeScript, scriptSha256: selected.scriptSha256, scriptVariantIndex: String(selected.variantIndex), runtimeVoiceId: voice.runtimeVoiceId, voiceChecksum: voice.voiceChecksum } : {};
  const overlayPayload: MediaCommandPayload = (action === "START" || action === "RECOVER") && overlayScene ? { overlaySceneJson: overlayScene.sceneJson, overlaySceneSha256: overlayScene.sceneSha256 } : {};
  return { runId: run.id, traceId: run.traceId, type: typeByAction[action], payload: { controlAction: action, ...transitionPayload, ...segmentPayload, ...overlayPayload } };
}

export async function bindRuntimeSession(context: RequestContext, runId: string, runtimeSessionId: string) {
  if (!databasePool()) {
    const run = getDemoRun(context, runId);
    if (!run) throw new Response("Live run not found", { status: 404 });
    if (!canBindRuntimeSession(run.state)) throw new Response("Runtime session is locked after arming", { status: 409 });
    run.runtimeSessionId = runtimeSessionId;
    await recordAuditEvent(context, runtimeSessionBoundAudit(run));
    return run;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const run = await loadAuthorizedPersistentRun(client, context, runId, true);
    if (!run) throw new Response("Live run not found", { status: 404 });
    if (!canBindRuntimeSession(run.state)) throw new Response("Runtime session is locked after arming", { status: 409 });
    await client.query("update live_runs set runtime_session_id = $2, updated_at = now() where id = $1", [runId, runtimeSessionId]);
    const bound = { ...run, runtimeSessionId };
    await recordAuditEventInTransaction(client, context, runtimeSessionBoundAudit(bound));
    return bound;
  });
}

function runtimeSessionBoundAudit(run: StoredRun): AuditEventInput {
  return { type: "runtime_session.bound", resource: "live_run", resourceId: run.id, detail: { runtimeSessionId: run.runtimeSessionId ?? "" } };
}

export function canBindRuntimeSession(state: LiveRunState) {
  return runtimeSessionBindingStates.has(state);
}

async function loadPersistentRun(client: PoolClient, runId: string, lock = false) {
  if (!isUuid(runId)) return null;
  const result = await client.query<PersistentRunRow>(
    `select r.id, r.tenant_id, r.show_revision_id, s.name as show_name, r.state, r.trace_id,
      r.channel_connection_id, r.product_version_id, r.has_operator, r.rights_approved,
      r.has_approved_sku_version, r.has_fallback_program, r.channel_ready, r.output_ready,
      r.ai_disclosure_enabled, r.runtime_session_id, r.scheduled_at, r.active_program_segment_id,
      r.active_insert_source_segment_id, r.active_insert_program_segment_id, r.pending_program_transition_event_id
     from live_runs r
     join show_revisions sr on sr.id = r.show_revision_id
     join shows s on s.id = sr.show_id
     where r.id = $1 ${lock ? "for update of r" : ""}`,
    [runId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const commands = await client.query<PersistentCommandRow>(
    `select c.id, c.action, c.expected_state, c.issued_at, c.result, u.display_name as actor_name
     from live_commands c join users u on u.id = c.actor_id
     where c.live_run_id = $1 order by c.issued_at desc limit 100`,
    [runId]
  );
  return persistentRun(row, commands.rows.map(persistentCommand));
}

async function loadAuthorizedPersistentRun(client: PoolClient, context: RequestContext, runId: string, lock = false) {
  const run = await loadPersistentRun(client, runId, lock);
  if (!run || !restrictedMembership(context)) return run;
  const result = await client.query<{ allowed: boolean }>(
    `select exists (
       select 1 from membership_resource_scopes scope
       where scope.membership_id = $1::uuid
         and ((scope.resource_type = 'live_run' and scope.resource_id = $2::uuid)
           or (scope.resource_type = 'channel_connection' and scope.resource_id = $3::uuid))
     ) as allowed`,
    [context.membershipId, run.id, run.channelConnectionId ?? null]
  );
  return result.rows[0]?.allowed ? run : null;
}

function restrictedMembership(context: RequestContext) {
  return context.accessScope === "restricted" && Boolean(context.membershipId);
}

async function findCommandByIdempotency(client: PoolClient, idempotencyKey: string) {
  const result = await client.query<PersistentCommandRow & { live_run_id: string }>(
    `select c.id, c.live_run_id, c.action, c.expected_state, c.issued_at, c.result, u.display_name as actor_name
     from live_commands c join users u on u.id = c.actor_id
     where c.idempotency_key = $1`,
    [idempotencyKey]
  );
  return result.rows[0] ? { command: persistentCommand(result.rows[0]), runId: result.rows[0].live_run_id } : null;
}

function sameCommandInput(existing: CommandIdempotencyRecord, runId: string, input: CommandInput) {
  return existing.runId === runId && existing.command.action === input.action && existing.command.expectedState === input.expectedState && (existing.command.programSegmentId ?? undefined) === (input.programSegmentId ?? undefined);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function persistentRun(row: PersistentRunRow, commandHistory: LiveCommand[]): StoredRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    revisionId: row.show_revision_id,
    showName: row.show_name,
    state: row.state,
    traceId: row.trace_id,
    channelConnectionId: row.channel_connection_id ?? undefined,
    productVersionId: row.product_version_id ?? undefined,
    hasOperator: row.has_operator,
    hasApprovedRights: row.rights_approved,
    hasApprovedSkuVersion: row.has_approved_sku_version,
    hasFallbackProgram: row.has_fallback_program,
    channelReady: row.channel_ready,
    outputReady: row.output_ready,
    aiDisclosureEnabled: row.ai_disclosure_enabled,
    runtimeSessionId: row.runtime_session_id ?? undefined,
    scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : undefined,
    activeProgramSegmentId: row.active_program_segment_id ?? undefined,
    activeInsertSourceSegmentId: row.active_insert_source_segment_id ?? undefined,
    activeInsertProgramSegmentId: row.active_insert_program_segment_id ?? undefined,
    pendingProgramTransitionEventId: row.pending_program_transition_event_id ?? undefined,
    commandHistory,
    questions: []
  };
}

function persistentCommand(row: PersistentCommandRow): LiveCommand {
  const result = typeof row.result === "string" ? JSON.parse(row.result) as { status?: string; programSegmentId?: unknown } : row.result as { status?: string; programSegmentId?: unknown };
  return {
    id: row.id,
    action: row.action,
    actorName: row.actor_name,
    issuedAt: new Date(row.issued_at).toISOString(),
    expectedState: row.expected_state,
    result: result.status === "rejected" ? "rejected" : "accepted",
    programSegmentId: typeof result.programSegmentId === "string" ? result.programSegmentId : undefined
  };
}
