import { recordAuditEvent, recordAuditEventInTransaction } from "@/lib/audit";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { assertLiveRunAccess } from "@/lib/control-plane/run-access";
import { databasePool, withTenantTransaction } from "@/lib/database";

const allowedActions = new Set(["START", "RECOVER", "SCHEDULED_START", "INSERT_PROGRAM", "ROLLBACK_PROGRAM"]);

export type ProgramOutputObservation = {
  id: string;
  tenantId: string;
  runId: string;
  outboxEventId: string;
  runtimeSessionId: string;
  commandId: string;
  programSegmentId: string;
  action: "START" | "RECOVER" | "SCHEDULED_START" | "INSERT_PROGRAM" | "ROLLBACK_PROGRAM";
  source: string;
  evidenceRef: string;
  contentSha256: string;
  confidence: number;
  mediaTimeMs: number;
  observedAt: string;
};

export type ProgramOutputObservationInput = Omit<ProgramOutputObservation, "id" | "tenantId">;
type PersistentObservationRow = {
  id: string; tenant_id: string; live_run_id: string; outbox_event_id: string; runtime_session_id: string; command_id: string; program_segment_id: string; control_action: ProgramOutputObservation["action"]; source: string; evidence_ref: string; content_sha256: string; confidence: number | string; media_time_ms: number | string; observed_at: Date | string;
};
type ObservationStore = Map<string, ProgramOutputObservation>;

declare global { var shuzhirenProgramOutputObservationStore: ObservationStore | undefined; }

function observationStore() { globalThis.shuzhirenProgramOutputObservationStore ??= new Map(); return globalThis.shuzhirenProgramOutputObservationStore; }

export function isProgramOutputObservationInput(value: unknown): value is ProgramOutputObservationInput & { tenantId?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return isUuid(body.runId) && isUuid(body.outboxEventId) && isSessionId(body.runtimeSessionId) && isMediaCommandId(body.commandId)
    && isUuid(body.programSegmentId) && typeof body.action === "string" && allowedActions.has(body.action)
    && typeof body.source === "string" && /^[a-z][a-z0-9_-]{1,63}$/.test(body.source)
    && isEvidenceRef(body.evidenceRef) && typeof body.contentSha256 === "string" && /^[0-9a-f]{64}$/.test(body.contentSha256)
    && typeof body.confidence === "number" && Number.isFinite(body.confidence) && body.confidence >= 0 && body.confidence <= 1
    && typeof body.mediaTimeMs === "number" && Number.isInteger(body.mediaTimeMs) && body.mediaTimeMs >= 0
    && typeof body.observedAt === "string" && !Number.isNaN(Date.parse(body.observedAt));
}

export async function recordProgramOutputObservation(context: RequestContext, input: ProgramOutputObservationInput) {
  if (!databasePool()) {
    const key = `${context.tenantId}:${input.outboxEventId}`;
    const existing = observationStore().get(key);
    if (existing) {
      if (!sameObservation(existing, input)) throw new Response("Output observation conflicts with the existing command evidence", { status: 409 });
      return { observation: existing, duplicate: true };
    }
    const observation: ProgramOutputObservation = { id: `program-output:${crypto.randomUUID()}`, tenantId: context.tenantId, ...input };
    observationStore().set(key, observation);
    await recordAuditEvent(context, { type: "live_program.output_observed", resource: "live_run", resourceId: input.runId, detail: auditDetail(observation) });
    return { observation, duplicate: false };
  }

  return withTenantTransaction(context.tenantId, async (client) => {
    const existing = await client.query<PersistentObservationRow>("select id, tenant_id, live_run_id, outbox_event_id, runtime_session_id, command_id, program_segment_id, control_action, source, evidence_ref, content_sha256, confidence, media_time_ms, observed_at from program_output_observations where outbox_event_id = $1::uuid", [input.outboxEventId]);
    if (existing.rows[0]) {
      const observation = persistentObservation(existing.rows[0]);
      if (!sameObservation(observation, input)) throw new Response("Output observation conflicts with the existing command evidence", { status: 409 });
      return { observation, duplicate: true };
    }

    const command = await client.query<{ id: string }>(
      `select event.id
       from outbox_events event join live_runs run on run.id = event.aggregate_id
       where event.id = $1::uuid and event.tenant_id = $2::uuid
         and event.event_type = 'media.dispatch' and event.aggregate_type = 'live_run'
         and event.aggregate_id = $3::uuid and event.state = 'delivered'
         and run.runtime_session_id = $4
         and event.payload ->> 'sessionId' = $4
         and event.payload -> 'command' ->> 'id' = $5
         and event.payload -> 'command' -> 'payload' ->> 'controlAction' = $6
         and event.payload -> 'command' -> 'payload' ->> 'programSegmentId' = $7::text`,
      [input.outboxEventId, context.tenantId, input.runId, input.runtimeSessionId, input.commandId, input.action, input.programSegmentId]
    );
    if (!command.rows[0]) throw new Response("Output observation does not match a delivered governed media command", { status: 409 });

    const inserted = await client.query<PersistentObservationRow>(
      `insert into program_output_observations (tenant_id, live_run_id, outbox_event_id, runtime_session_id, command_id, program_segment_id, control_action, source, evidence_ref, content_sha256, confidence, media_time_ms, observed_at)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7, $8, $9, $10, $11, $12, $13::timestamptz)
       returning id, tenant_id, live_run_id, outbox_event_id, runtime_session_id, command_id, program_segment_id, control_action, source, evidence_ref, content_sha256, confidence, media_time_ms, observed_at`,
      [context.tenantId, input.runId, input.outboxEventId, input.runtimeSessionId, input.commandId, input.programSegmentId, input.action, input.source, input.evidenceRef, input.contentSha256, input.confidence, input.mediaTimeMs, input.observedAt]
    );
    const observation = persistentObservation(inserted.rows[0]);
    await recordAuditEventInTransaction(client, context, { type: "live_program.output_observed", resource: "live_run", resourceId: input.runId, detail: auditDetail(observation) });
    return { observation, duplicate: false };
  });
}

export async function listProgramOutputObservations(context: RequestContext, runId: string) {
  await assertLiveRunAccess(context, runId);
  if (!databasePool()) return [...observationStore().values()].filter((observation) => observation.tenantId === context.tenantId && observation.runId === runId).sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentObservationRow>("select id, tenant_id, live_run_id, outbox_event_id, runtime_session_id, command_id, program_segment_id, control_action, source, evidence_ref, content_sha256, confidence, media_time_ms, observed_at from program_output_observations where live_run_id = $1::uuid order by observed_at desc limit 250", [runId]);
    return result.rows.map(persistentObservation);
  });
}

function persistentObservation(row: PersistentObservationRow): ProgramOutputObservation {
  return { id: row.id, tenantId: row.tenant_id, runId: row.live_run_id, outboxEventId: row.outbox_event_id, runtimeSessionId: row.runtime_session_id, commandId: row.command_id, programSegmentId: row.program_segment_id, action: row.control_action, source: row.source, evidenceRef: row.evidence_ref, contentSha256: row.content_sha256, confidence: Number(row.confidence), mediaTimeMs: Number(row.media_time_ms), observedAt: new Date(row.observed_at).toISOString() };
}

function auditDetail(observation: ProgramOutputObservation): Record<string, string | number | boolean | null> {
  return { runId: observation.runId, outboxEventId: observation.outboxEventId, commandId: observation.commandId, programSegmentId: observation.programSegmentId, action: observation.action, source: observation.source, evidenceRef: observation.evidenceRef, contentSha256: observation.contentSha256, confidence: observation.confidence, mediaTimeMs: observation.mediaTimeMs, observedAt: observation.observedAt };
}

function sameObservation(existing: ProgramOutputObservation, input: ProgramOutputObservationInput) {
  return existing.runId === input.runId && existing.runtimeSessionId === input.runtimeSessionId && existing.commandId === input.commandId && existing.programSegmentId === input.programSegmentId && existing.action === input.action && existing.source === input.source && existing.evidenceRef === input.evidenceRef && existing.contentSha256 === input.contentSha256 && existing.confidence === input.confidence && existing.mediaTimeMs === input.mediaTimeMs && existing.observedAt === new Date(input.observedAt).toISOString();
}

function isUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isSessionId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }
function isMediaCommandId(value: unknown): value is string { return typeof value === "string" && /^media_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isEvidenceRef(value: unknown): value is string { return typeof value === "string" && (/^evidence:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(value) || /^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/.test(value)); }
