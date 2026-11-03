import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(os.tmpdir(), "shuzhiren-acceptance-"));
const goodPath = path.join(directory, "good.json");
const badPath = path.join(directory, "bad.json");
const badOutputPath = path.join(directory, "bad-output.json");
const missingAudioPath = path.join(directory, "missing-audio.json");
const missingRecoveryPath = path.join(directory, "missing-recovery.json");
const evidence = {
  schemaVersion: 3,
  completedAt: "2026-11-03T12:00:00.000Z",
  operator: "integration-duty-operator",
  releaseManifestSha256: "a".repeat(64),
  host: { hostname: "rtx4090-integration", gpuName: "NVIDIA GeForce RTX 4090", gpuMemoryMiB: 24564, driverVersion: "570.124", cudaVersion: "12.8" },
  trial: { durationMinutes: 240, maxConcurrentAvatars: 1, minimumOutputFps: 25, minimumOutputWidth: 1280, minimumOutputHeight: 720, minimumBitrateMbps: 3, maximumAvSyncMs: 80, outputProbeVerified: true, audioActivityProbeVerified: true, recordingVerified: true, runtimeObservationEvidence: "obs://integration/report-1", outputProbeEvidence: "probe://integration/report-1", audioActivityEvidence: "audio://integration/report-1", recordingEvidence: "archive://integration/recording-1" },
  drills: Object.fromEntries(["networkLoss", "rtmpRejected", "gpuOom", "ttsTimeout", "blackFrame", "silence"].map((name) => [name, { passed: true, evidence: `drill://integration/${name}` }])),
  recovery: {
    postgresRestoreEvidence: "restore://integration/postgres-1",
    gatewayJournalSnapshotEvidence: "snapshot://integration/gateway-1",
    gatewayJournalRecoveryEvidence: "restore://integration/gateway-1",
    completedCommandNoReplayVerified: true
  }
};
try {
  await writeFile(goodPath, JSON.stringify(evidence));
  await writeFile(badPath, JSON.stringify({ ...evidence, trial: { ...evidence.trial, durationMinutes: 30 } }));
  await writeFile(badOutputPath, JSON.stringify({ ...evidence, trial: { ...evidence.trial, minimumOutputWidth: 640 } }));
  await writeFile(missingAudioPath, JSON.stringify({ ...evidence, trial: { ...evidence.trial, audioActivityProbeVerified: undefined, audioActivityEvidence: undefined } }));
  await writeFile(missingRecoveryPath, JSON.stringify({ ...evidence, recovery: { ...evidence.recovery, completedCommandNoReplayVerified: false, gatewayJournalRecoveryEvidence: undefined } }));
  const good = spawnSync(process.execPath, ["scripts/verify-4090-acceptance.mjs", "--evidence", goodPath], { cwd: root, encoding: "utf8" });
  assert.equal(good.status, 0, good.stderr);
  const bad = spawnSync(process.execPath, ["scripts/verify-4090-acceptance.mjs", "--evidence", badPath], { cwd: root, encoding: "utf8" });
  assert.notEqual(bad.status, 0, "short trial evidence must fail the acceptance gate");
  assert.match(bad.stderr, /durationMinutes/);
  const badOutput = spawnSync(process.execPath, ["scripts/verify-4090-acceptance.mjs", "--evidence", badOutputPath], { cwd: root, encoding: "utf8" });
  assert.notEqual(badOutput.status, 0, "low-resolution evidence must fail the acceptance gate");
  assert.match(badOutput.stderr, /minimumOutputWidth/);
  const missingAudio = spawnSync(process.execPath, ["scripts/verify-4090-acceptance.mjs", "--evidence", missingAudioPath], { cwd: root, encoding: "utf8" });
  assert.notEqual(missingAudio.status, 0, "missing audio-activity evidence must fail the acceptance gate");
  assert.match(missingAudio.stderr, /audioActivity/);
  const missingRecovery = spawnSync(process.execPath, ["scripts/verify-4090-acceptance.mjs", "--evidence", missingRecoveryPath], { cwd: root, encoding: "utf8" });
  assert.notEqual(missingRecovery.status, 0, "missing Gateway recovery evidence must fail the acceptance gate");
  assert.match(missingRecovery.stderr, /recovery/);
  console.log("PASS  4090 acceptance verifier accepts complete evidence and rejects an insufficient trial");
} finally { await rm(directory, { recursive: true, force: true }); }
