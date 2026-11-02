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
const missingAudioPath = path.join(directory, "missing-audio.json");
const evidence = {
  schemaVersion: 1,
  completedAt: "2026-11-03T12:00:00.000Z",
  operator: "integration-duty-operator",
  releaseManifestSha256: "a".repeat(64),
  host: { hostname: "rtx4090-integration", gpuName: "NVIDIA GeForce RTX 4090", gpuMemoryMiB: 24564, driverVersion: "570.124", cudaVersion: "12.8" },
  trial: { durationMinutes: 240, maxConcurrentAvatars: 1, minimumOutputFps: 25, maximumAvSyncMs: 80, outputProbeVerified: true, audioActivityProbeVerified: true, recordingVerified: true, runtimeObservationEvidence: "obs://integration/report-1", audioActivityEvidence: "audio://integration/report-1", recordingEvidence: "archive://integration/recording-1" },
  drills: Object.fromEntries(["networkLoss", "rtmpRejected", "gpuOom", "ttsTimeout", "blackFrame", "silence"].map((name) => [name, { passed: true, evidence: `drill://integration/${name}` }]))
};
try {
  await writeFile(goodPath, JSON.stringify(evidence));
  await writeFile(badPath, JSON.stringify({ ...evidence, trial: { ...evidence.trial, durationMinutes: 30 } }));
  await writeFile(missingAudioPath, JSON.stringify({ ...evidence, trial: { ...evidence.trial, audioActivityProbeVerified: undefined, audioActivityEvidence: undefined } }));
  const good = spawnSync(process.execPath, ["scripts/verify-4090-acceptance.mjs", "--evidence", goodPath], { cwd: root, encoding: "utf8" });
  assert.equal(good.status, 0, good.stderr);
  const bad = spawnSync(process.execPath, ["scripts/verify-4090-acceptance.mjs", "--evidence", badPath], { cwd: root, encoding: "utf8" });
  assert.notEqual(bad.status, 0, "short trial evidence must fail the acceptance gate");
  assert.match(bad.stderr, /durationMinutes/);
  const missingAudio = spawnSync(process.execPath, ["scripts/verify-4090-acceptance.mjs", "--evidence", missingAudioPath], { cwd: root, encoding: "utf8" });
  assert.notEqual(missingAudio.status, 0, "missing audio-activity evidence must fail the acceptance gate");
  assert.match(missingAudio.stderr, /audioActivity/);
  console.log("PASS  4090 acceptance verifier accepts complete evidence and rejects an insufficient trial");
} finally { await rm(directory, { recursive: true, force: true }); }
