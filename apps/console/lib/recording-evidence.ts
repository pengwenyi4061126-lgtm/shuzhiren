import { controlPlaneConfig } from "@/lib/control-plane/config";
import { isControlledEvidenceRef, isSafeObjectKey } from "@/lib/governance-input";
import type { RegisterRecordingInput } from "@/lib/recordings";

export type RecordingContentVerification = {
  objectVersion: string;
  evidenceRef: string;
  verifiedAt: string;
};

type VerifierConfig = { url?: string; token?: string; demoMode: boolean; timeoutMs: number };

export async function verifyRecordingEvidence(context: { tenantId: string }, input: Omit<RegisterRecordingInput, "idempotencyKey">): Promise<RecordingContentVerification> {
  const config = verifierConfig();
  if (config.demoMode) return { objectVersion: "demo", evidenceRef: "demo://recording-evidence", verifiedAt: new Date().toISOString() };
  const response = await fetch(`${config.url}/v1/recording-evidence/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ tenantId: context.tenantId, ...input }),
    cache: "no-store",
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  if (!response.ok) throw new Response("Recording evidence verification failed", { status: 502 });
  return validateVerification(await response.json(), context.tenantId, input);
}

function verifierConfig(): VerifierConfig {
  const config = controlPlaneConfig();
  const url = process.env.RECORDING_EVIDENCE_VERIFIER_URL;
  const token = process.env.RECORDING_EVIDENCE_VERIFIER_TOKEN;
  const timeoutMs = boundedTimeout();
  if (config.demoMode) return { demoMode: true, timeoutMs };
  if (!url || !token) throw new Response("Recording evidence verifier is not configured", { status: 503 });
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Response("Recording evidence verifier configuration is invalid", { status: 503 }); }
  const loopbackHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.hash || (parsed.protocol !== "https:" && !loopbackHttp) || token.length < 32 || /\s/.test(token)) throw new Response("Recording evidence verifier configuration is invalid", { status: 503 });
  return { url: url.replace(/\/$/, ""), token, demoMode: false, timeoutMs };
}

function boundedTimeout() {
  const value = Number.parseInt(process.env.RECORDING_EVIDENCE_VERIFIER_TIMEOUT_MS ?? "5000", 10);
  if (!Number.isInteger(value) || value < 100 || value > 60_000) throw new Response("Recording evidence verifier configuration is invalid", { status: 503 });
  return value;
}

function validateVerification(value: unknown, tenantId: string, input: Omit<RegisterRecordingInput, "idempotencyKey">): RecordingContentVerification {
  if (!value || typeof value !== "object") throw new Response("Recording evidence verifier response is invalid", { status: 502 });
  const proof = value as Record<string, unknown>;
  if (proof.tenantId !== tenantId || proof.runId !== input.runId || proof.objectKey !== input.objectKey || proof.checksumSha256 !== input.checksumSha256
    || proof.bytes !== input.bytes || proof.durationSeconds !== input.durationSeconds || !sameTimestamp(proof.startedAt, input.startedAt)
    || !sameTimestamp(proof.endedAt, input.endedAt) || !sameDate(proof.retentionUntil, input.retentionUntil)
    || !isSafeObjectKey(proof.objectKey) || !isChecksum(proof.checksumSha256)
    || typeof proof.objectVersion !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(proof.objectVersion)
    || !isControlledEvidenceRef(proof.evidenceRef) || typeof proof.verifiedAt !== "string") throw new Response("Recording evidence verifier response is invalid", { status: 502 });
  const verifiedAt = new Date(proof.verifiedAt);
  const age = Date.now() - verifiedAt.getTime();
  if (Number.isNaN(verifiedAt.getTime()) || age < -60_000 || age > 10 * 60_000) throw new Response("Recording evidence verifier response is invalid", { status: 502 });
  return { objectVersion: proof.objectVersion, evidenceRef: proof.evidenceRef, verifiedAt: verifiedAt.toISOString() };
}

function isChecksum(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
function sameTimestamp(value: unknown, expected: string | undefined) {
  if (expected === undefined) return value === undefined || value === null;
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && Date.parse(value) === Date.parse(expected);
}
function sameDate(value: unknown, expected: string | undefined) {
  if (expected === undefined) return value === undefined || value === null;
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === new Date(expected).toISOString().slice(0, 10);
}
