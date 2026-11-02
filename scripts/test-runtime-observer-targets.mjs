import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(os.tmpdir(), "shuzhiren-observer-target-check-"));
const valid = path.join(directory, "valid.json");
const invalid = path.join(directory, "invalid.json");
const empty = path.join(directory, "empty.json");
const runtimeEnv = path.join(directory, "runtime.env");

function check(file, requireTargets = false, checkRuntimeEnv) {
  return spawnSync(process.execPath, ["scripts/check-runtime-observer-targets.mjs", "--file", file, ...(requireTargets ? ["--require-targets"] : []), ...(checkRuntimeEnv ? ["--runtime-env", checkRuntimeEnv] : [])], { cwd: root, encoding: "utf8" });
}

try {
  await writeFile(valid, JSON.stringify([{ tenantId: "tenant_demo", runId: "run_demo", sessionId: "session_demo", telemetryToken: "telemetry-token-at-least-16", outputProbeUrl: "https://probe.internal/v1/probes/demo", outputProbeToken: "output-probe-token-at-least-16" }]));
  await writeFile(invalid, JSON.stringify([{ tenantId: "tenant_demo", runId: "run_demo", sessionId: "session_demo", telemetryToken: "short", outputProbeUrl: "https://probe.internal/v1/probes/demo" }]));
  await writeFile(empty, "[]");
  await writeFile(runtimeEnv, "OUTPUT_PROBE_SHARED_TOKEN=output-probe-token-at-least-16\n");
  const accepted = check(valid, true, runtimeEnv);
  assert.equal(accepted.status, 0, accepted.stderr);
  const rejected = check(invalid, true);
  assert.notEqual(rejected.status, 0, "short telemetry tokens must be rejected");
  assert.match(rejected.stderr, /telemetryToken/);
  const emptyRejected = check(empty, true);
  assert.notEqual(emptyRejected.status, 0, "empty live target files must be rejected when requested");
  assert.match(emptyRejected.stderr, /at least one target/);
  await writeFile(invalid, JSON.stringify([{ tenantId: "tenant_demo", runId: "run_demo", sessionId: "session_demo", telemetryToken: "telemetry-token-at-least-16", outputProbeUrl: "https://probe.internal/v1/probes/demo", outputProbeToken: "different-output-probe-token-at-least-16" }]));
  const probeTokenRejected = check(invalid, true, runtimeEnv);
  assert.notEqual(probeTokenRejected.status, 0, "observer target probe tokens must match the configured output probe secret");
  assert.match(probeTokenRejected.stderr, /OUTPUT_PROBE_SHARED_TOKEN/);
  console.log("PASS  runtime observer target file validator accepts valid targets and rejects unsafe updates");
} finally {
  await rm(directory, { recursive: true, force: true });
}
