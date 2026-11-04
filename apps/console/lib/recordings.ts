import type { RequestContext } from "@/lib/control-plane/auth-context";
import { hasRestrictedMembership } from "@/lib/control-plane/run-access";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { verifyRecordingEvidence, type RecordingContentVerification } from "@/lib/recording-evidence";

export type RecordingEvidence = {
  id: string;
  tenantId: string;
  runId: string;
  objectKey: string;
  checksumSha256: string;
  bytes: number;
  durationSeconds: number;
  startedAt?: string;
  endedAt?: string;
  recordedAt: string;
  retentionUntil?: string;
  contentVerification: RecordingContentVerification;
};

export type RegisterRecordingInput = Pick<RecordingEvidence, "runId" | "objectKey" | "checksumSha256" | "bytes" | "durationSeconds" | "startedAt" | "endedAt" | "retentionUntil"> & { idempotencyKey: string };
export type RecordingRegistration = { recording: RecordingEvidence; duplicate: boolean };

type RecordingStore = { recordings: Map<string, RecordingEvidence>; idempotency: Map<string, string> };
type PersistentRecordingRow = {
  id: string;
  tenant_id: string;
  live_run_id: string;
  object_key: string;
  checksum_sha256: string;
  bytes: string | number;
  duration_seconds: number;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  recorded_at: Date | string;
  retention_until: Date | string | null;
  verified_object_version: string;
  verification_evidence_ref: string;
  verified_at: Date | string;
};

declare global { var shuzhirenRecordingStore: RecordingStore | undefined; }

function recordingStore(): RecordingStore {
  globalThis.shuzhirenRecordingStore ??= { recordings: new Map(), idempotency: new Map() };
  return globalThis.shuzhirenRecordingStore;
}

export async function listRecordings(context: RequestContext) {
  if (!databasePool()) return [...recordingStore().recordings.values()].filter((recording) => recording.tenantId === context.tenantId).sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentRecordingRow>(
      "select evidence.id, evidence.tenant_id, evidence.live_run_id, evidence.object_key, evidence.checksum_sha256, evidence.bytes, evidence.duration_seconds, evidence.started_at, evidence.ended_at, evidence.recorded_at, evidence.retention_until, evidence.verified_object_version, evidence.verification_evidence_ref, evidence.verified_at from recording_evidence evidence where evidence.verified_object_version is not null and evidence.verification_evidence_ref is not null and evidence.verified_at is not null and (not $1::boolean or exists (select 1 from live_runs r where r.id = evidence.live_run_id and exists (select 1 from membership_resource_scopes scope where scope.membership_id = $2::uuid and ((scope.resource_type = 'live_run' and scope.resource_id = r.id) or (scope.resource_type = 'channel_connection' and scope.resource_id = r.channel_connection_id))))) order by evidence.recorded_at desc limit 500",
      [hasRestrictedMembership(context), context.membershipId ?? null]
    );
    return result.rows.map(persistentRecording);
  });
}

export async function registerRecording(context: RequestContext, input: RegisterRecordingInput) {
  const verification = await verifyRecordingEvidence(context, input);
  if (!databasePool()) {
    const store = recordingStore();
    const key = `${context.tenantId}:${input.idempotencyKey}`;
    const existingId = store.idempotency.get(key);
    if (existingId) {
      const existing = store.recordings.get(existingId)!;
      if (!sameRecording(existing, input)) throw new Response("Recording idempotency key was already used with different content", { status: 409 });
      return { recording: existing, duplicate: true };
    }
    const recording: RecordingEvidence = { id: `recording_${crypto.randomUUID()}`, tenantId: context.tenantId, recordedAt: new Date().toISOString(), ...input, contentVerification: verification };
    store.recordings.set(recording.id, recording);
    store.idempotency.set(key, recording.id);
    return { recording, duplicate: false };
  }
  if (!isUuid(input.runId)) throw new Response("Live run not found", { status: 404 });
  return withTenantTransaction(context.tenantId, async (client) => {
    const run = await client.query("select id from live_runs where id = $1::uuid", [input.runId]);
    if (!run.rows[0]) throw new Response("Live run not found", { status: 404 });
    const existing = await client.query<PersistentRecordingRow>(
      "select id, tenant_id, live_run_id, object_key, checksum_sha256, bytes, duration_seconds, started_at, ended_at, recorded_at, retention_until, verified_object_version, verification_evidence_ref, verified_at from recording_evidence where idempotency_key = $1",
      [input.idempotencyKey],
    );
    if (existing.rows[0]) {
      const recording = persistentRecording(existing.rows[0]);
      if (!sameRecording(recording, input)) throw new Response("Recording idempotency key was already used with different content", { status: 409 });
      return { recording, duplicate: true };
    }
    const result = await client.query<PersistentRecordingRow>(
      `insert into recording_evidence (tenant_id, live_run_id, object_key, checksum_sha256, bytes, duration_seconds, started_at, ended_at, retention_until, idempotency_key, verified_object_version, verification_evidence_ref, verified_at)
       values ($1, $2::uuid, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::date, $10, $11, $12, $13::timestamptz)
       on conflict do nothing
       returning id, tenant_id, live_run_id, object_key, checksum_sha256, bytes, duration_seconds, started_at, ended_at, recorded_at, retention_until, verified_object_version, verification_evidence_ref, verified_at`,
      [context.tenantId, input.runId, input.objectKey, input.checksumSha256, input.bytes, input.durationSeconds, input.startedAt ?? null, input.endedAt ?? null, input.retentionUntil ?? null, input.idempotencyKey, verification.objectVersion, verification.evidenceRef, verification.verifiedAt],
    );
    if (result.rows[0]) return { recording: persistentRecording(result.rows[0]), duplicate: false };
    const conflicted = await client.query<PersistentRecordingRow>(
      "select id, tenant_id, live_run_id, object_key, checksum_sha256, bytes, duration_seconds, started_at, ended_at, recorded_at, retention_until, verified_object_version, verification_evidence_ref, verified_at from recording_evidence where idempotency_key = $1",
      [input.idempotencyKey],
    );
    if (conflicted.rows[0]) {
      const recording = persistentRecording(conflicted.rows[0]);
      if (!sameRecording(recording, input)) throw new Response("Recording idempotency key was already used with different content", { status: 409 });
      return { recording, duplicate: true };
    }
    throw new Response("Recording object key is already registered", { status: 409 });
  });
}

function persistentRecording(row: PersistentRecordingRow): RecordingEvidence {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    runId: row.live_run_id,
    objectKey: row.object_key,
    checksumSha256: row.checksum_sha256,
    bytes: Number(row.bytes),
    durationSeconds: row.duration_seconds,
    startedAt: timestamp(row.started_at),
    endedAt: timestamp(row.ended_at),
    recordedAt: new Date(row.recorded_at).toISOString(),
    retentionUntil: row.retention_until ? new Date(row.retention_until).toISOString().slice(0, 10) : undefined,
    contentVerification: { objectVersion: row.verified_object_version, evidenceRef: row.verification_evidence_ref, verifiedAt: new Date(row.verified_at).toISOString() },
  };
}

function timestamp(value: Date | string | null) { return value ? new Date(value).toISOString() : undefined; }

function sameRecording(existing: RecordingEvidence, input: RegisterRecordingInput) {
  return existing.runId === input.runId
    && existing.objectKey === input.objectKey
    && existing.checksumSha256 === input.checksumSha256
    && existing.bytes === input.bytes
    && existing.durationSeconds === input.durationSeconds
    && sameTimestamp(existing.startedAt, input.startedAt)
    && sameTimestamp(existing.endedAt, input.endedAt)
    && (existing.retentionUntil ?? undefined) === (input.retentionUntil ?? undefined);
}

function sameTimestamp(existing: string | undefined, input: string | undefined) {
  if (!existing || !input) return existing === input;
  return Date.parse(existing) === Date.parse(input);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
