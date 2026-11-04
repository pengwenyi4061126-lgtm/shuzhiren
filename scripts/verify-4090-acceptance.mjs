import { readFile } from "node:fs/promises";
import path from "node:path";

const option = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const evidencePath = option("--evidence");
if (!evidencePath) {
  console.error("ERROR Usage: node scripts/verify-4090-acceptance.mjs --evidence /secure/path/runtime-acceptance.json");
  process.exit(1);
}

let evidence;
try { evidence = JSON.parse(await readFile(path.resolve(evidencePath), "utf8")); }
catch (error) { console.error(`ERROR Cannot read acceptance evidence: ${error instanceof Error ? error.message : "invalid JSON"}`); process.exit(1); }

const errors = [];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mediaCommandPattern = /^media_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requireString = (value, label, pattern) => {
  if (typeof value !== "string" || !value.trim() || value.includes("replace-with") || (pattern && !pattern.test(value))) errors.push(`${label} is required and must not be a template placeholder`);
};
const requireNumber = (value, label, minimum) => {
  if (!Number.isFinite(value) || value < minimum) errors.push(`${label} must be at least ${minimum}`);
};
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

if (!isObject(evidence)) errors.push("evidence must be a JSON object");
if (evidence?.schemaVersion !== 4) errors.push("schemaVersion must be 4");
requireString(evidence?.completedAt, "completedAt");
if (Number.isNaN(Date.parse(evidence?.completedAt ?? ""))) errors.push("completedAt must be an ISO timestamp");
requireString(evidence?.operator, "operator");
requireString(evidence?.releaseManifestSha256, "releaseManifestSha256", /^[a-f0-9]{64}$/i);

const host = evidence?.host;
if (!isObject(host)) errors.push("host must be an object");
requireString(host?.hostname, "host.hostname");
requireString(host?.gpuName, "host.gpuName");
if (!/4090/i.test(host?.gpuName ?? "")) errors.push("host.gpuName must identify an RTX 4090-class host");
requireNumber(host?.gpuMemoryMiB, "host.gpuMemoryMiB", 22 * 1024);
requireString(host?.driverVersion, "host.driverVersion");
requireString(host?.cudaVersion, "host.cudaVersion");

const trial = evidence?.trial;
if (!isObject(trial)) errors.push("trial must be an object");
requireNumber(trial?.durationMinutes, "trial.durationMinutes", 240);
if (trial?.maxConcurrentAvatars !== 1) errors.push("trial.maxConcurrentAvatars must be exactly 1 for the approved single-4090 profile");
requireNumber(trial?.minimumOutputFps, "trial.minimumOutputFps", 24);
requireNumber(trial?.minimumOutputWidth, "trial.minimumOutputWidth", 1280);
requireNumber(trial?.minimumOutputHeight, "trial.minimumOutputHeight", 720);
requireNumber(trial?.minimumBitrateMbps, "trial.minimumBitrateMbps", 2);
if (!Number.isFinite(trial?.maximumAvSyncMs) || trial.maximumAvSyncMs > 120 || trial.maximumAvSyncMs < 0) errors.push("trial.maximumAvSyncMs must be between 0 and 120");
if (trial?.outputProbeVerified !== true) errors.push("trial.outputProbeVerified must be true");
if (trial?.audioActivityProbeVerified !== true) errors.push("trial.audioActivityProbeVerified must be true");
if (trial?.recordingVerified !== true) errors.push("trial.recordingVerified must be true");
requireString(trial?.runtimeObservationEvidence, "trial.runtimeObservationEvidence");
requireString(trial?.outputProbeEvidence, "trial.outputProbeEvidence");
requireString(trial?.audioActivityEvidence, "trial.audioActivityEvidence");
requireString(trial?.recordingEvidence, "trial.recordingEvidence");
const programOutputObservation = trial?.programOutputObservation;
if (!isObject(programOutputObservation)) errors.push("trial.programOutputObservation must be an object");
requireString(programOutputObservation?.runId, "trial.programOutputObservation.runId", uuidPattern);
requireString(programOutputObservation?.outboxEventId, "trial.programOutputObservation.outboxEventId", uuidPattern);
requireString(programOutputObservation?.commandId, "trial.programOutputObservation.commandId", mediaCommandPattern);
requireString(programOutputObservation?.programSegmentId, "trial.programOutputObservation.programSegmentId", uuidPattern);
requireString(programOutputObservation?.source, "trial.programOutputObservation.source", /^[a-z][a-z0-9_-]{1,63}$/);
requireString(programOutputObservation?.evidenceRef, "trial.programOutputObservation.evidenceRef", /^(evidence:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}|urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255})$/);
requireString(programOutputObservation?.contentSha256, "trial.programOutputObservation.contentSha256", /^[a-f0-9]{64}$/i);
requireNumber(programOutputObservation?.confidence, "trial.programOutputObservation.confidence", 0);
if (Number.isFinite(programOutputObservation?.confidence) && programOutputObservation.confidence > 1) errors.push("trial.programOutputObservation.confidence must be at most 1");
if (!Number.isInteger(programOutputObservation?.mediaTimeMs) || programOutputObservation.mediaTimeMs < 0) errors.push("trial.programOutputObservation.mediaTimeMs must be a non-negative integer");
requireString(programOutputObservation?.observedAt, "trial.programOutputObservation.observedAt");
if (Number.isNaN(Date.parse(programOutputObservation?.observedAt ?? ""))) errors.push("trial.programOutputObservation.observedAt must be an ISO timestamp");

for (const name of ["networkLoss", "rtmpRejected", "gpuOom", "ttsTimeout", "blackFrame", "silence"]) {
  const drill = evidence?.drills?.[name];
  if (!isObject(drill) || drill.passed !== true) errors.push(`drills.${name}.passed must be true`);
  requireString(drill?.evidence, `drills.${name}.evidence`);
}

const recovery = evidence?.recovery;
if (!isObject(recovery)) errors.push("recovery must be an object");
requireString(recovery?.postgresRestoreEvidence, "recovery.postgresRestoreEvidence");
requireString(recovery?.gatewayJournalSnapshotEvidence, "recovery.gatewayJournalSnapshotEvidence");
requireString(recovery?.gatewayJournalRecoveryEvidence, "recovery.gatewayJournalRecoveryEvidence");
if (recovery?.completedCommandNoReplayVerified !== true) errors.push("recovery.completedCommandNoReplayVerified must be true");

if (errors.length) {
  for (const error of errors) console.error(`ERROR ${error}`);
  process.exit(1);
}
console.log(`PASS  4090 runtime acceptance evidence verified for ${host.hostname}; ${trial.durationMinutes} minutes, ${trial.minimumOutputFps} FPS, ${trial.minimumOutputWidth}x${trial.minimumOutputHeight}, ${trial.minimumBitrateMbps} Mbps minimum, ${trial.maximumAvSyncMs} ms maximum A/V sync, governed program-output observation and recovery evidence complete`);
