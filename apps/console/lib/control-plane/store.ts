import type { PoolClient } from "pg";
import type { LiveCommand, LiveCommandAction, LiveRun, LiveRunState } from "@/lib/domain";
import { canTransition, nextStateFor } from "@/lib/live-run";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { findApprovedProductVersion } from "@/lib/catalog";
import { evaluatePreflight } from "@/lib/control-plane/preflight";
import { hasApprovedFallbackProgram } from "@/lib/show-program";
import { hasApprovedLiveRights } from "@/lib/assets";
import { validateChannelConnection } from "@/lib/channels";
import { evaluateRuntimeReadiness } from "@/lib/monitoring";
import { databasePool, withTenantTransaction } from "@/lib/database";

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
  const runtime = evaluateRuntimeReadiness(context, run.id);
  return evaluatePreflight({
    ...run,
    hasApprovedRights: await hasApprovedLiveRights(context),
    hasApprovedSkuVersion: Boolean(run.productVersionId && await findApprovedProductVersion(context, run.productVersionId)),
    hasFallbackProgram: await hasApprovedFallbackProgram(context, run.id),
    channelReady: channel.passed,
    channelDetail: channel.detail,
    outputReady: run.outputReady && runtime.passed,
    outputDetail: runtime.passed ? runtime.detail : `运行时探针未通过：${runtime.detail}`
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
    return { command, run: { ...run, state: nextState, commandHistory: [command, ...run.commandHistory] }, duplicate: false as const };
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
  run.state = nextStateFor(run.state, input.action);
  run.commandHistory.unshift(command);
  activeStore.idempotency.set(`${context.tenantId}:${input.idempotencyKey}`, command);
  return { command, run, duplicate: false as const };
}

async function loadPersistentRun(client: PoolClient, runId: string, lock = false) {
  const result = await client.query<PersistentRunRow>(
    `select r.id, r.tenant_id, r.show_revision_id, s.name as show_name, r.state, r.trace_id,
      r.channel_connection_id, r.product_version_id, r.has_operator, r.rights_approved,
      r.has_approved_sku_version, r.has_fallback_program, r.channel_ready, r.output_ready,
      r.ai_disclosure_enabled
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
