// Behavioral tests for the Release_Workflow_Gate, scripts/check-release-workflow.mjs
// (Requirement 3.5, 3.6, 3.7). Every case runs the gate in a child process and
// asserts on its exit code and its MISSING_ACTION / ACTION_REF lines. Variants
// of scripts/fixtures/release-workflow/pinned.yml are written to a temporary
// directory and passed with --workflow.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");
const gate = path.join(scriptsDir, "check-release-workflow.mjs");
const pinnedFixture = path.join(scriptsDir, "fixtures", "release-workflow", "pinned.yml");
const pinnedText = readFileSync(pinnedFixture, "utf8").replace(/\r\n?/g, "\n");

const REQUIRED_ACTIONS = ["docker/setup-buildx-action", "docker/login-action", "docker/build-push-action", "actions/upload-artifact", "actions/download-artifact"];
const NON_SHA_REFS = ["v4", "main", "3d3c42e"];

const tempDir = mkdtempSync(path.join(os.tmpdir(), "release-workflow-gate-"));
after(() => rmSync(tempDir, { recursive: true, force: true }));

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Runs the gate and returns its exit code, full output and violation lines. */
function runGate(args = []) {
  const result = spawnSync(process.execPath, [gate, ...args], { cwd: repoRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  const output = `${result.stdout}${result.stderr}`;
  return { status: result.status, output, violations: output.split(/\r?\n/).filter((line) => /^(MISSING_ACTION|ACTION_REF) /.test(line)) };
}

function writeVariant(name, text) {
  const file = path.join(tempDir, name);
  writeFileSync(file, text);
  return file;
}

/** Replaces the ref of the first `uses: <action>@…` line. */
function withRef(text, action, ref) {
  const pattern = new RegExp(`^(\\s*-\\s+uses:\\s*${escapeRegExp(action)})@[^\\s#]+`, "m");
  if (!pattern.test(text)) throw new Error(`fixture does not reference ${action}`);
  return text.replace(pattern, `$1@${ref}`);
}

/** Removes the whole step whose first key is `uses: <action>@…`. */
function withoutStep(text, action) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s+uses:\\s*${escapeRegExp(action)}@`).test(line));
  if (start < 0) throw new Error(`fixture does not reference ${action}`);
  const indent = lines[start].indexOf("-");
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || lines[end].search(/\S/) > indent)) end += 1;
  lines.splice(start, end - start);
  return lines.join("\n");
}

test("passes when the five required actions and every other action use 40-hex commit SHAs", () => {
  const result = runGate(["--workflow", pinnedFixture]);
  assert.deepEqual(result.violations, [], result.output);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /^PASS {2}/m);
});

test("fails with the action name and ref when a third-party action uses a tag, a branch or a short SHA", () => {
  for (const action of [...REQUIRED_ACTIONS, "actions/checkout"]) {
    for (const ref of NON_SHA_REFS) {
      const file = writeVariant(`${action.replace("/", "__")}-${ref}.yml`, withRef(pinnedText, action, ref));
      const result = runGate(["--workflow", file]);
      assert.equal(result.status, 1, `${action}@${ref}\n${result.output}`);
      assert.equal(result.violations.length, 1, `${action}@${ref}\n${result.output}`);
      assert.match(result.violations[0], new RegExp(`^ACTION_REF job=\\S+ step=\\S+ action=${escapeRegExp(action)} ref=${escapeRegExp(ref)}$`));
    }
  }
});

test("fails with MISSING_ACTION when a required action is removed", () => {
  for (const action of REQUIRED_ACTIONS) {
    const file = writeVariant(`${action.replace("/", "__")}-missing.yml`, withoutStep(pinnedText, action));
    const result = runGate(["--workflow", file]);
    assert.equal(result.status, 1, `${action}\n${result.output}`);
    assert.deepEqual(result.violations, [`MISSING_ACTION ${action}`], result.output);
  }
});

test("passes on the repository release workflow", () => {
  const result = runGate();
  assert.deepEqual(result.violations, [], result.output);
  assert.equal(result.status, 0, result.output);
});

test("exits 2 when the workflow cannot be read", () => {
  const result = runGate(["--workflow", path.join(tempDir, "does-not-exist.yml")]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /^ERROR source=.*does-not-exist\.yml reason=/m);
});
