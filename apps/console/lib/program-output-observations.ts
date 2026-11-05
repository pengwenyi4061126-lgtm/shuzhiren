import { recordAuditEvent, recordAuditEventInTransaction } from "@/lib/audit";
import { CanonicalJsonError, canonicalJson } from "@/lib/canonical-json.mjs";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { assertLiveRunAccess } from "@/lib/control-plane/run-access";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { createHash, createPublicKey, verify } from "node:crypto";

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
  attestation: ProgramOutputAttestationSummary;
};

export type ProgramOutputObservationInput = Omit<ProgramOutputObservation, "id" | "tenantId" | "attestation"> & { attestation: ProgramOutputAttestation };
export type ProgramOutputAttestation = {
  issuer: string;
  keyId: string;
  audience: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
};
export type ProgramOutputAttestationSummary = Omit<ProgramOutputAttestation, "signature"> & { signatureSha256: string };
type PersistentObservationRow = {
  id: string; tenant_id: string; live_run_id: string; outbox_event_id: string; runtime_session_id: string; command_id: string; program_segment_id: string; control_action: ProgramOutputObservation["action"]; source: string; evidence_ref: string; content_sha256: string; confidence: number | string; media_time_ms: number | string; observed_at: Date | string; verifier_issuer: string; verifier_key_id: string; attested_at: Date | string; attestation_expires_at: Date | string; attestation_sha256: string;
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
    && typeof body.observedAt === "string" && !Number.isNaN(Date.parse(body.observedAt)) && isProgramOutputAttestation(body.attestation);
}

export function verifyProgramOutputAttestation(tenantId: string, input: ProgramOutputObservationInput) {
  const attestation = input.attestation;
  const trust = trustedProgramOutputVerifiers().get(tenantId);
  if (!trust || trust.issuer !== attestation.issuer) throw new Response("Program output verifier is not trusted for this tenant", { status: 403 });
  const publicKey = trust.keys.get(attestation.keyId);
  if (!publicKey) throw new Response("Program output verifier key is not trusted for this tenant", { status: 403 });
  const issuedAt = Date.parse(attestation.issuedAt);
  const expiresAt = Date.parse(attestation.expiresAt);
  const now = Date.now();
  if (attestation.audience !== `${tenantId}:${input.runId}` || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now + 60_000 || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > 10 * 60_000 || Date.parse(input.observedAt) < issuedAt - 60_000 || Date.parse(input.observedAt) > expiresAt + 60_000) throw new Response("Program output verifier attestation is stale or is not bound to this run", { status: 409 });
  const signature = Buffer.from(attestation.signature, "base64url");
  if (!signature.length || !verify(null, Buffer.from(canonicalProgramOutputAttestationPayload(input)), publicKey, signature)) throw new Response("Program output verifier signature is invalid", { status: 403 });
}

export function canonicalProgramOutputAttestationPayload(input: ProgramOutputObservationInput) {
  const attestation = input.attestation;
  const observation = { runId: input.runId, outboxEventId: input.outboxEventId, runtimeSessionId: input.runtimeSessionId, commandId: input.commandId, programSegmentId: input.programSegmentId, action: input.action, source: input.source, evidenceRef: input.evidenceRef, contentSha256: input.contentSha256, confidence: input.confidence, mediaTimeMs: input.mediaTimeMs, observedAt: new Date(input.observedAt).toISOString() };
  return canonicalAttestationJson({ issuer: attestation.issuer, keyId: attestation.keyId, audience: attestation.audience, issuedAt: new Date(attestation.issuedAt).toISOString(), expiresAt: new Date(attestation.expiresAt).toISOString(), observation });
}

export async function recordProgramOutputObservation(context: RequestContext, input: ProgramOutputObservationInput) {
  if (!databasePool()) {
    const key = `${context.tenantId}:${input.outboxEventId}`;
    const existing = observationStore().get(key);
    if (existing) {
      if (!sameObservation(existing, input)) throw new Response("Output observation conflicts with the existing command evidence", { status: 409 });
      return { observation: existing, duplicate: true };
    }
    const observation: ProgramOutputObservation = { id: `program-output:${crypto.randomUUID()}`, tenantId: context.tenantId, ...input, attestation: summarizedAttestation(input) };
    observationStore().set(key, observation);
    await recordAuditEvent(context, { type: "live_program.output_observed", resource: "live_run", resourceId: input.runId, detail: auditDetail(observation) });
    return { observation, duplicate: false };
  }

  return withTenantTransaction(context.tenantId, async (client) => {
    const existing = await client.query<PersistentObservationRow>("select id, tenant_id, live_run_id, outbox_event_id, runtime_session_id, command_id, program_segment_id, control_action, source, evidence_ref, content_sha256, confidence, media_time_ms, observed_at, verifier_issuer, verifier_key_id, attested_at, attestation_expires_at, attestation_sha256 from program_output_observations where outbox_event_id = $1::uuid", [input.outboxEventId]);
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
      `insert into program_output_observations (tenant_id, live_run_id, outbox_event_id, runtime_session_id, command_id, program_segment_id, control_action, source, evidence_ref, content_sha256, confidence, media_time_ms, observed_at, verifier_issuer, verifier_key_id, attested_at, attestation_expires_at, attestation_sha256)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14, $15, $16::timestamptz, $17::timestamptz, $18)
       returning id, tenant_id, live_run_id, outbox_event_id, runtime_session_id, command_id, program_segment_id, control_action, source, evidence_ref, content_sha256, confidence, media_time_ms, observed_at, verifier_issuer, verifier_key_id, attested_at, attestation_expires_at, attestation_sha256`,
      [context.tenantId, input.runId, input.outboxEventId, input.runtimeSessionId, input.commandId, input.programSegmentId, input.action, input.source, input.evidenceRef, input.contentSha256, input.confidence, input.mediaTimeMs, input.observedAt, input.attestation.issuer, input.attestation.keyId, input.attestation.issuedAt, input.attestation.expiresAt, attestationHash(input)]
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
    const result = await client.query<PersistentObservationRow>("select id, tenant_id, live_run_id, outbox_event_id, runtime_session_id, command_id, program_segment_id, control_action, source, evidence_ref, content_sha256, confidence, media_time_ms, observed_at, verifier_issuer, verifier_key_id, attested_at, attestation_expires_at, attestation_sha256 from program_output_observations where live_run_id = $1::uuid order by observed_at desc limit 250", [runId]);
    return result.rows.map(persistentObservation);
  });
}

function persistentObservation(row: PersistentObservationRow): ProgramOutputObservation {
  return { id: row.id, tenantId: row.tenant_id, runId: row.live_run_id, outboxEventId: row.outbox_event_id, runtimeSessionId: row.runtime_session_id, commandId: row.command_id, programSegmentId: row.program_segment_id, action: row.control_action, source: row.source, evidenceRef: row.evidence_ref, contentSha256: row.content_sha256, confidence: Number(row.confidence), mediaTimeMs: Number(row.media_time_ms), observedAt: new Date(row.observed_at).toISOString(), attestation: { issuer: row.verifier_issuer, keyId: row.verifier_key_id, audience: `${row.tenant_id}:${row.live_run_id}`, issuedAt: new Date(row.attested_at).toISOString(), expiresAt: new Date(row.attestation_expires_at).toISOString(), signatureSha256: row.attestation_sha256 } };
}

function auditDetail(observation: ProgramOutputObservation): Record<string, string | number | boolean | null> {
  return { runId: observation.runId, outboxEventId: observation.outboxEventId, commandId: observation.commandId, programSegmentId: observation.programSegmentId, action: observation.action, source: observation.source, evidenceRef: observation.evidenceRef, contentSha256: observation.contentSha256, confidence: observation.confidence, mediaTimeMs: observation.mediaTimeMs, observedAt: observation.observedAt, verifierIssuer: observation.attestation.issuer, verifierKeyId: observation.attestation.keyId, attestedAt: observation.attestation.issuedAt, attestationExpiresAt: observation.attestation.expiresAt, attestationSha256: observation.attestation.signatureSha256 };
}

function sameObservation(existing: ProgramOutputObservation, input: ProgramOutputObservationInput) {
  return existing.runId === input.runId && existing.runtimeSessionId === input.runtimeSessionId && existing.commandId === input.commandId && existing.programSegmentId === input.programSegmentId && existing.action === input.action && existing.source === input.source && existing.evidenceRef === input.evidenceRef && existing.contentSha256 === input.contentSha256 && existing.confidence === input.confidence && existing.mediaTimeMs === input.mediaTimeMs && existing.observedAt === new Date(input.observedAt).toISOString() && existing.attestation.issuer === input.attestation.issuer && existing.attestation.keyId === input.attestation.keyId && existing.attestation.issuedAt === new Date(input.attestation.issuedAt).toISOString() && existing.attestation.expiresAt === new Date(input.attestation.expiresAt).toISOString() && existing.attestation.signatureSha256 === attestationHash(input);
}

function isUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isSessionId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }
function isMediaCommandId(value: unknown): value is string { return typeof value === "string" && /^media_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isEvidenceRef(value: unknown): value is string { return typeof value === "string" && (/^evidence:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(value) || /^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/.test(value)); }
function isProgramOutputAttestation(value: unknown): value is ProgramOutputAttestation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attestation = value as Record<string, unknown>;
  return typeof attestation.issuer === "string" && /^[a-z][a-z0-9_-]{1,63}$/.test(attestation.issuer)
    && typeof attestation.keyId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(attestation.keyId)
    && typeof attestation.audience === "string" && attestation.audience.length > 0 && attestation.audience.length <= 200
    && typeof attestation.issuedAt === "string" && !Number.isNaN(Date.parse(attestation.issuedAt))
    && typeof attestation.expiresAt === "string" && !Number.isNaN(Date.parse(attestation.expiresAt))
    && typeof attestation.signature === "string" && /^[A-Za-z0-9_-]{80,1024}$/.test(attestation.signature);
}

function trustedProgramOutputVerifiers() {
  const raw = process.env.PROGRAM_OUTPUT_VERIFIER_TRUST;
  if (!raw) throw new Response("Program output verifier trust is not configured", { status: 503 });
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid trust map");
    const result = new Map<string, { issuer: string; keys: Map<string, ReturnType<typeof createPublicKey>> }>();
    for (const [tenantId, entry] of Object.entries(parsed)) {
      if (!isUuid(tenantId) || !entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid trust tenant");
      const trust = entry as { issuer?: unknown; keys?: unknown };
      if (typeof trust.issuer !== "string" || !/^[a-z][a-z0-9_-]{1,63}$/.test(trust.issuer) || !trust.keys || typeof trust.keys !== "object" || Array.isArray(trust.keys)) throw new Error("invalid verifier trust");
      const keys = new Map<string, ReturnType<typeof createPublicKey>>();
      for (const [keyId, pem] of Object.entries(trust.keys)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(keyId) || typeof pem !== "string" || pem.length > 16_000) throw new Error("invalid verifier key");
        const key = createPublicKey(pem);
        if (key.asymmetricKeyType !== "ed25519") throw new Error("program output verifier keys must use Ed25519");
        keys.set(keyId, key);
      }
      if (!keys.size) throw new Error("missing verifier keys");
      result.set(tenantId, { issuer: trust.issuer, keys });
    }
    return result;
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Program output verifier trust is invalid", { status: 503 });
  }
}

function attestationHash(input: ProgramOutputObservationInput) { return createHash("sha256").update(input.attestation.signature).digest("hex"); }
function summarizedAttestation(input: ProgramOutputObservationInput): ProgramOutputAttestationSummary { return { issuer: input.attestation.issuer, keyId: input.attestation.keyId, audience: input.attestation.audience, issuedAt: new Date(input.attestation.issuedAt).toISOString(), expiresAt: new Date(input.attestation.expiresAt).toISOString(), signatureSha256: attestationHash(input) }; }
// Attestations are only verified on receipt, so they always use the current
// code-point rule; the attestation keys order identically under the previous
// localeCompare rule, so existing verifiers keep producing valid signatures.
function canonicalAttestationJson(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw new Error("attestation payload is invalid");
    throw error;
  }
}
