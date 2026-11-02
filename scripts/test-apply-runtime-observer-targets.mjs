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
const invalidCandidate = path.join(directory, "runtime-observer-targets.invalid.json");
const otherDirectory = await mkdtemp(path.join(os.tmpdir(), "shuzhiren-observer-target-apply-other-"));
const crossDirectoryCandidate = path.join(otherDirectory, "runtime-observer-targets.next.json");
const validPayload = JSON.stringify([{ tenantId: "tenant_demo", runId: "run_demo", sessionId: "session_demo", telemetryToken: "telemetry-token-at-least-16", outputProbeUrl: "https://probe.internal/v1/probes/demo", outputProbeToken: "output-probe-token-at-least-16" }]);

function apply(candidate) {
  return spawnSync(process.execPath, ["scripts/apply-runtime-observer-targets.mjs", "--candidate", candidate, "--destination", destination, "--require-targets"], { cwd: root, encoding: "utf8" });
}

try {
  await writeFile(destination, "[]");
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

  await writeFile(crossDirectoryCandidate, validPayload);
  const crossDirectory = apply(crossDirectoryCandidate);
  assert.notEqual(crossDirectory.status, 0, "cross-directory replacement must be rejected");
  assert.equal(await readFile(destination, "utf8"), validPayload);
  console.log("PASS  runtime observer target publishing validates candidates and preserves atomic replacement constraints");
} finally {
  await rm(directory, { recursive: true, force: true });
  await rm(otherDirectory, { recursive: true, force: true });
}
