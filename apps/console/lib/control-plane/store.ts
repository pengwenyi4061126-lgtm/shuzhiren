import type { PoolClient } from "pg";
import type { LiveCommand, LiveCommandAction, LiveRun, LiveRunState } from "@/lib/domain";
import { canTransition, nextStateFor } from "@/lib/live-run";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { findApprovedProductVersion } from "@/lib/catalog";
import { evaluatePreflight } from "@/lib/control-plane/preflight";
import { hasApprovedFallbackProgram } from "@/lib/show-program";
import { registerDemoProgram, type ShowProgram } from "@/lib/show-program";
import { hasApprovedLiveRights } from "@/lib/assets";
import { validateChannelConnection } from "@/lib/channels";
import { evaluateRuntimeReadiness } from "@/lib/monitoring";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { enqueueMediaCommand, enqueueMediaCommandInTransaction } from "@/lib/control-plane/outbox";
import { createMediaCommand, type MediaCommand } from "@/lib/media-protocol";

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

type CommandInput = { action: LiveCommandAction; idempotencyKey: string; expectedState: LiveRunState };
type Store = { runs: Map<string, StoredRun>; idempotency: Map<string, LiveCommand> };
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
};
type PersistentCommandRow = {
  id: string;
  action: LiveCommandAction;
  expected_state: LiveRunState;
  issued_at: Date | string;
  result: unknown;
  actor_name: string;
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
  return withTenantTransaction(context.tenantId, async (client) => loadPersistentRun(client, runId));
}

export async function listRuns(context: RequestContext) {
  if (!databasePool()) return [...store().runs.values()].filter((run) => run.tenantId === context.tenantId).sort((left, right) => (left.scheduledAt ?? "").localeCompare(right.scheduledAt ?? ""));
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentRunRow>(`select r.id, r.tenant_id, r.show_revision_id, s.name as show_name, r.state, r.trace_id, r.channel_connection_id, r.product_version_id, r.has_operator, r.rights_approved, r.has_approved_sku_version, r.has_fallback_program, r.channel_ready, r.output_ready, r.ai_disclosure_enabled, r.runtime_session_id, r.scheduled_at from live_runs r join show_revisions sr on sr.id = r.show_revision_id join shows s on s.id = sr.show_id order by r.scheduled_at asc nulls last, r.created_at desc`);
    return result.rows.map((row) => persistentRun(row, []));
  });
}

export async function createLiveRun(context: RequestContext, input: { showName: string; scheduledAt?: string; channelConnectionId: string; productVersionId: string; runtimeSessionId?: string; aiDisclosureEnabled: boolean }) {
  const product = await findApprovedProductVersion(context, input.productVersionId);
  if (!product) throw new Response("An approved product version is required", { status: 409 });
  const channel = await validateChannelConnection(context, input.channelConnectionId, { resolution: "720p", aiDisclosureEnabled: input.aiDisclosureEnabled });
  if (!channel.passed) throw new Response(`Channel is not ready: ${channel.detail}`, { status: 409 });
  if (!databasePool()) return createDemoRun(context, input);
  return withTenantTransaction(context.tenantId, async (client) => {
    const show = await client.query<{ id: string }>("insert into shows (tenant_id, name) values ($1, $2) returning id", [context.tenantId, input.showName]);
    const revision = await client.query<{ id: string }>("insert into show_revisions (tenant_id, show_id, revision, plan, approval_status) values ($1, $2, 1, $3::jsonb, 'approved') returning id", [context.tenantId, show.rows[0].id, JSON.stringify({ generatedBy: "run-planner" })]);
    const run = await client.query<PersistentRunRow>(`insert into live_runs (tenant_id, show_revision_id, state, trace_id, channel_connection_id, product_version_id, has_operator, rights_approved, has_approved_sku_version, has_fallback_program, channel_ready, output_ready, ai_disclosure_enabled, runtime_session_id, scheduled_at) values ($1, $2, 'DRAFT', $3, $4, $5, true, $6, true, true, true, false, $7, $8, $9::timestamptz) returning id, tenant_id, show_revision_id, $10::text as show_name, state, trace_id, channel_connection_id, product_version_id, has_operator, rights_approved, has_approved_sku_version, has_fallback_program, channel_ready, output_ready, ai_disclosure_enabled, runtime_session_id, scheduled_at`, [context.tenantId, revision.rows[0].id, `run_${crypto.randomUUID()}`, input.channelConnectionId, input.productVersionId, await hasApprovedLiveRights(context), input.aiDisclosureEnabled, input.runtimeSessionId ?? null, input.scheduledAt ?? null, input.showName]);
    await client.query(`insert into show_revision_segments (tenant_id, show_revision_id, position, kind, title, duration_seconds, product_version_id, purpose, is_fallback) values ($1, $2, 1, 'prepared_product', '商品讲解', 180, $3, '受审核商品事实', false), ($1, $2, 2, 'interactive', '受控互动', 120, $3, '仅低风险可追溯问答', false), ($1, $2, 3, 'fallback', '备用节目', 150, $3, '运行异常降级', true), ($1, $2, 4, 'human_handoff', '人工接管', 0, null, '高风险人工处理', true)`, [context.tenantId, revision.rows[0].id, input.productVersionId]);
    return persistentRun(run.rows[0], []);
  });
}

async function createDemoRun(context: RequestContext, input: { showName: string; scheduledAt?: string; channelConnectionId: string; productVersionId: string; runtimeSessionId?: string; aiDisclosureEnabled: boolean }) {
  const id = `run_${crypto.randomUUID()}`;
  const revisionId = `show_revision_${crypto.randomUUID()}`;
  const run: StoredRun = { id, tenantId: context.tenantId, revisionId, channelConnectionId: input.channelConnectionId, productVersionId: input.productVersionId, showName: input.showName, state: "DRAFT", traceId: id, scheduledAt: input.scheduledAt, hasOperator: true, hasApprovedRights: await hasApprovedLiveRights(context), hasApprovedSkuVersion: true, hasFallbackProgram: true, channelReady: true, outputReady: false, aiDisclosureEnabled: input.aiDisclosureEnabled, runtimeSessionId: input.runtimeSessionId, commandHistory: [], questions: [] };
  store().runs.set(id, run);
  const program: ShowProgram = { runId: id, tenantId: context.tenantId, revisionId, status: "approved", segments: [{ id: `${id}_product`, position: 1, kind: "prepared_product", title: "商品讲解", durationSeconds: 180, productVersionId: input.productVersionId, purpose: "受审核商品事实", fallback: false }, { id: `${id}_interactive`, position: 2, kind: "interactive", title: "受控互动", durationSeconds: 120, productVersionId: input.productVersionId, purpose: "仅低风险可追溯问答", fallback: false }, { id: `${id}_fallback`, position: 3, kind: "fallback", title: "备用节目", durationSeconds: 150, productVersionId: input.productVersionId, purpose: "运行异常降级", fallback: true }, { id: `${id}_handoff`, position: 4, kind: "human_handoff", title: "人工接管", durationSeconds: 0, purpose: "高风险人工处理", fallback: true }] };
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
  const channel = await validateChannelConnection(context, run.channelConnectionId, { resolution: "720p", aiDisclosureEnabled: run.aiDisclosureEnabled });
  const runtime = await evaluateRuntimeReadiness(context, run.id);
  return evaluatePreflight({
    ...run,
    hasApprovedRights: await hasApprovedLiveRights(context),
    hasApprovedSkuVersion: Boolean(run.productVersionId && await findApprovedProductVersion(context, run.productVersionId)),
    hasFallbackProgram: await hasApprovedFallbackProgram(context, run.id),
    channelReady: channel.passed,
    channelDetail: channel.detail,
    outputReady: run.outputReady && runtime.passed,
    outputDetail: runtime.passed ? runtime.detail : `运行时探针未通过：${runtime.detail}`,
    runtimeSessionReady: Boolean(run.runtimeSessionId),
    runtimeSessionDetail: run.runtimeSessionId ? `已绑定运行时会话 ${run.runtimeSessionId}` : "尚未绑定 LiveTalking 运行时会话"
  });
}

export async function issueCommand(context: RequestContext, runId: string, input: CommandInput) {
  if (!databasePool()) return issueDemoCommand(context, runId, input);
  return withTenantTransaction(context.tenantId, async (client) => {
    const run = await loadPersistentRun(client, runId, true);
    if (!run) throw new Response("Live run not found", { status: 404 });

    const duplicate = await findCommandByIdempotency(client, input.idempotencyKey);
    if (duplicate) return { command: duplicate, run, duplicate: true as const };
    if (run.state !== input.expectedState) throw new Response("Live run state changed", { status: 409 });
    if (!canTransition(run.state, input.action)) throw new Response("Command is not allowed in current state", { status: 409 });
    if (!run.runtimeSessionId) throw new Response("Runtime session is not bound", { status: 409 });
    if (input.action === "START" && !(await evaluateRunPreflight(context, run)).passed) {
      throw new Response("Preflight requirements are not satisfied", { status: 409 });
    }

    const nextState = nextStateFor(run.state, input.action);
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const inserted = await client.query<PersistentCommandRow>(
      "insert into live_commands (tenant_id, live_run_id, actor_id, idempotency_key, expected_state, action, result) values ($1, $2, $3, $4, $5, $6, $7::jsonb) returning id, action, expected_state, issued_at, result, $8::text as actor_name",
      [context.tenantId, run.id, actor.rows[0].id, input.idempotencyKey, input.expectedState, input.action, JSON.stringify({ status: "accepted" }), context.actorName]
    );
    await client.query("update live_runs set state = $2, updated_at = now() where id = $1", [run.id, nextState]);
    const command = persistentCommand(inserted.rows[0]);
    const mediaEvent = await enqueueMediaCommandInTransaction(client, context, createMediaCommand(mediaCommandFor(run, input.action)), run.runtimeSessionId);
    return { command, mediaEvent, run: { ...run, state: nextState, commandHistory: [command, ...run.commandHistory] }, duplicate: false as const };
  });
}

async function issueDemoCommand(context: RequestContext, runId: string, input: CommandInput) {
  const activeStore = store();
  const run = getDemoRun(context, runId);
  if (!run) throw new Response("Live run not found", { status: 404 });

  const existing = activeStore.idempotency.get(`${context.tenantId}:${input.idempotencyKey}`);
  if (existing) return { command: existing, run, duplicate: true as const };
  if (run.state !== input.expectedState) throw new Response("Live run state changed", { status: 409 });
  if (!canTransition(run.state, input.action)) throw new Response("Command is not allowed in current state", { status: 409 });
  if (!run.runtimeSessionId) throw new Response("Runtime session is not bound", { status: 409 });
  if (input.action === "START" && !(await evaluateRunPreflight(context, run)).passed) {
    throw new Response("Preflight requirements are not satisfied", { status: 409 });
  }

  const command: LiveCommand = {
    id: `cmd_${crypto.randomUUID()}`,
    action: input.action,
    actorName: context.actorName,
    issuedAt: new Date().toISOString(),
    expectedState: input.expectedState,
    result: "accepted"
  };
  const mediaEvent = await enqueueMediaCommand(context, { ...mediaCommandFor(run, input.action), sessionId: run.runtimeSessionId });
  run.state = nextStateFor(run.state, input.action);
  run.commandHistory.unshift(command);
  activeStore.idempotency.set(`${context.tenantId}:${input.idempotencyKey}`, command);
  return { command, mediaEvent, run, duplicate: false as const };
}

function mediaCommandFor(run: StoredRun, action: LiveCommandAction): Omit<MediaCommand, "id" | "issuedAt"> {
  const typeByAction = { START: "start_program", PAUSE: "switch_to_fallback", HANDOFF: "switch_to_human", RECOVER: "start_program", END: "stop_program" } as const;
  return { runId: run.id, traceId: run.traceId, type: typeByAction[action], payload: { controlAction: action } };
}

export async function bindRuntimeSession(context: RequestContext, runId: string, runtimeSessionId: string) {
  if (!databasePool()) {
    const run = getDemoRun(context, runId);
    if (!run) throw new Response("Live run not found", { status: 404 });
    run.runtimeSessionId = runtimeSessionId;
    return run;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentRunRow>(
      `update live_runs set runtime_session_id = $2, updated_at = now() where id = $1
       returning id, tenant_id, show_revision_id, ''::text as show_name, state, trace_id,
         channel_connection_id, product_version_id, has_operator, rights_approved, has_approved_sku_version,
         has_fallback_program, channel_ready, output_ready, ai_disclosure_enabled, runtime_session_id, scheduled_at`,
      [runId, runtimeSessionId]
    );
    if (!result.rows[0]) throw new Response("Live run not found", { status: 404 });
    const run = result.rows[0];
    const show = await client.query<{ show_name: string }>("select s.name as show_name from live_runs r join show_revisions sr on sr.id = r.show_revision_id join shows s on s.id = sr.show_id where r.id = $1", [runId]);
    return persistentRun({ ...run, show_name: show.rows[0]?.show_name ?? "直播场次" }, []);
  });
}

async function loadPersistentRun(client: PoolClient, runId: string, lock = false) {
  const result = await client.query<PersistentRunRow>(
    `select r.id, r.tenant_id, r.show_revision_id, s.name as show_name, r.state, r.trace_id,
      r.channel_connection_id, r.product_version_id, r.has_operator, r.rights_approved,
      r.has_approved_sku_version, r.has_fallback_program, r.channel_ready, r.output_ready,
      r.ai_disclosure_enabled, r.runtime_session_id, r.scheduled_at
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

async function findCommandByIdempotency(client: PoolClient, idempotencyKey: string) {
  const result = await client.query<PersistentCommandRow>(
    `select c.id, c.action, c.expected_state, c.issued_at, c.result, u.display_name as actor_name
     from live_commands c join users u on u.id = c.actor_id
     where c.idempotency_key = $1`,
    [idempotencyKey]
  );
  return result.rows[0] ? persistentCommand(result.rows[0]) : null;
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
    commandHistory,
    questions: []
  };
}

function persistentCommand(row: PersistentCommandRow): LiveCommand {
  const result = typeof row.result === "string" ? JSON.parse(row.result) as { status?: string } : row.result as { status?: string };
  return {
    id: row.id,
    action: row.action,
    actorName: row.actor_name,
    issuedAt: new Date(row.issued_at).toISOString(),
    expectedState: row.expected_state,
    result: result.status === "rejected" ? "rejected" : "accepted"
  };
}
