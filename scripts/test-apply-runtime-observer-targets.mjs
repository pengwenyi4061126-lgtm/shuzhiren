import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(os.tmpdir(), "shuzhiren-observer-target-apply-"));
const destination = path.join(directory, "runtime-observer-targets.json");
const validCandidate = path.join(directory, "runtime-observer-targets.next.json");
const missingControlCandidate = path.join(directory, "runtime-observer-targets.missing-control.json");
const invalidCandidate = path.join(directory, "runtime-observer-targets.invalid.json");
const mismatchedCandidate = path.join(directory, "runtime-observer-targets.mismatched.json");
const mismatchedTelemetryCandidate = path.join(directory, "runtime-observer-targets.telemetry-mismatched.json");
const runtimeEnv = path.join(directory, "runtime.env");
const controlEnv = path.join(directory, "control.env");
const otherDirectory = await mkdtemp(path.join(os.tmpdir(), "shuzhiren-observer-target-apply-other-"));
const crossDirectoryCandidate = path.join(otherDirectory, "runtime-observer-targets.next.json");
const validPayload = JSON.stringify([{ tenantId: "tenant_demo", runId: "run_demo", sessionId: "session_demo", telemetryToken: "telemetry-token-at-least-32-chars", programOutputToken: "program-output-token-at-least-32-chars", outputProbeUrl: "https://probe.internal/v1/probes/demo", outputProbeToken: "output-probe-token-at-least-32-chars" }]);

function apply(candidate) {
  return spawnSync(process.execPath, ["scripts/apply-runtime-observer-targets.mjs", "--candidate", candidate, "--destination", destination, "--require-targets", "--runtime-env", runtimeEnv, "--control-env", controlEnv], { cwd: root, encoding: "utf8" });
}

function applyWithoutControlEnv(candidate) {
  return spawnSync(process.execPath, ["scripts/apply-runtime-observer-targets.mjs", "--candidate", candidate, "--destination", destination, "--require-targets", "--runtime-env", runtimeEnv], { cwd: root, encoding: "utf8" });
}

try {
  await writeFile(destination, "[]");
  await writeFile(runtimeEnv, "OUTPUT_PROBE_SHARED_TOKEN=output-probe-token-at-least-32-chars\n");
  await writeFile(controlEnv, 'RUNTIME_TELEMETRY_TENANT_TOKENS={"tenant_demo":"telemetry-token-at-least-32-chars"}\nPROGRAM_OUTPUT_OBSERVATION_TENANT_TOKENS={"tenant_demo":"program-output-token-at-least-32-chars"}\n');
  await writeFile(missingControlCandidate, validPayload);
  const missingControl = applyWithoutControlEnv(missingControlCandidate);
  assert.notEqual(missingControl.status, 0, "required observer targets must not be published without the control-plane token map");
  assert.equal(await readFile(destination, "utf8"), "[]");
  await writeFile(validCandidate, validPayload);
  const accepted = apply(validCandidate);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /applied atomically/);
  assert.equal(await readFile(destination, "utf8"), validPayload);
  await assert.rejects(access(validCandidate, constants.F_OK));

  await writeFile(invalidCandidate, "not-json");
  const invalid = apply(invalidCandidate);
  assert.notEqual(invalid.status, 0, "invalid candidate must not replace the active target file");
  assert.equal(await readFile(destination, "utf8"), validPayload);

  await writeFile(mismatchedCandidate, JSON.stringify([{ tenantId: "tenant_demo", runId: "run_demo", sessionId: "session_demo", telemetryToken: "telemetry-token-at-least-32-chars", programOutputToken: "program-output-token-at-least-32-chars", outputProbeUrl: "https://probe.internal/v1/probes/demo", outputProbeToken: "different-output-probe-token-at-least-32-chars" }]));
  const mismatched = apply(mismatchedCandidate);
  assert.notEqual(mismatched.status, 0, "mismatched output probe tokens must not replace the active target file");
  assert.equal(await readFile(destination, "utf8"), validPayload);

  await writeFile(mismatchedTelemetryCandidate, JSON.stringify([{ tenantId: "tenant_demo", runId: "run_demo", sessionId: "session_demo", telemetryToken: "different-telemetry-token-at-least-32-chars", programOutputToken: "program-output-token-at-least-32-chars", outputProbeUrl: "https://probe.internal/v1/probes/demo", outputProbeToken: "output-probe-token-at-least-32-chars" }]));
  const telemetryMismatched = apply(mismatchedTelemetryCandidate);
  assert.notEqual(telemetryMismatched.status, 0, "mismatched telemetry tokens must not replace the active target file");
  assert.equal(await readFile(destination, "utf8"), validPayload);

  await writeFile(crossDirectoryCandidate, validPayload);
  const crossDirectory = apply(crossDirectoryCandidate);
  assert.notEqual(crossDirectory.status, 0, "cross-directory replacement must be rejected");
  assert.equal(await readFile(destination, "utf8"), validPayload);
  console.log("PASS  runtime observer target publishing validates candidates and preserves atomic replacement constraints");
} finally {
  await rm(directory, { recursive: true, force: true });
  await rm(otherDirectory, { recursive: true, force: true });
}
