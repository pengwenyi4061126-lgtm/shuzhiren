// Behavioral tests for scripts/check-test-registries.mjs (design part 8 §2.3 error
// codes, task 7.4 REG-WORKFLOW). Each case writes a registry, coverage map or
// workflow that violates exactly one rule into a temporary directory, runs the
// gate against it and asserts the exit code and the reported code. The real
// repository must pass.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REGRESSIONS } from "./regression-registry.mjs";
import { STATIC_GATE_COVERAGE } from "./static-gate-coverage.mjs";
import { checkEvidenceWorkflow, labelOfTest, staticGateIds } from "./check-test-registries.mjs";
import { LOCAL_CHECKS } from "./verify-local-checks.mjs";
import { CI_ONLY_STEPS } from "./ci-required-steps.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gate = path.join(root, "scripts", "check-test-registries.mjs");
const directory = mkdtempSync(path.join(os.tmpdir(), "test-registries-"));
test.after(() => rmSync(directory, { recursive: true, force: true }));

let counter = 0;
function file(name, text) {
  counter += 1;
  const target = path.join(directory, `${counter}-${name}`);
  writeFileSync(target, text);
  return target;
}

function runGate(args) {
  const result = spawnSync(process.execPath, [gate, ...args], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  return { status: result.status, lines: result.stdout.split(/\r?\n/).filter(Boolean), stderr: result.stderr };
}

const registryModule = (entries) => file("registry.mjs", `export const REGRESSIONS = ${JSON.stringify(entries, null, 2)};\n`);
const coverageModule = (mapping) => file("coverage.mjs", `export const STATIC_GATE_COVERAGE = ${JSON.stringify(mapping, null, 2)};\n`);
const baseEntry = () => JSON.parse(JSON.stringify(REGRESSIONS.find((entry) => entry.issue === "H5")));

function expectOnly(code, args, matcher) {
  const run = runGate(args);
  assert.equal(run.status, 1, `${code}: ${run.lines.join("\n")}${run.stderr}`);
  const errors = run.lines.filter((line) => !line.startsWith("NOTE "));
  assert.ok(errors.length > 0 && errors.every((line) => line.startsWith(`${code} `)), `only ${code} expected:\n${errors.join("\n")}`);
  if (matcher) assert.ok(errors.some((line) => matcher.test(line)), errors.join("\n"));
}

test("the real repository passes", () => {
  const run = runGate([]);
  assert.equal(run.status, 0, run.lines.join("\n") + run.stderr);
  assert.ok(run.lines.some((line) => line.startsWith("PASS ")));
});

test("each registry rule is reported on its own", () => {
  const field = baseEntry();
  field.job = "nowhere";
  expectOnly("REG-FIELD", ["--registry", registryModule([field])], /job must be one of/);

  const commit = baseEntry();
  commit.fixCommit = "0".repeat(40);
  const commitRun = runGate(["--registry", registryModule([commit])]);
  assert.equal(commitRun.status, 1);
  assert.ok(commitRun.lines.some((line) => line.startsWith("REG-COMMIT ")), commitRun.lines.join("\n"));

  const missing = baseEntry();
  missing.files = [...missing.files, "scripts/fixtures/does-not-exist.mjs"];
  expectOnly("REG-FILE", ["--registry", registryModule([missing])], /does-not-exist/);

  const issue = baseEntry();
  issue.registerTest = "npm run deploy:check:test";
  const issueRun = runGate(["--registry", registryModule([issue])]);
  assert.equal(issueRun.status, 1);
  assert.ok(issueRun.lines.some((line) => line.startsWith("REG-ISSUE ") && line.includes("registerTest")), issueRun.lines.join("\n"));

  expectOnly("REG-DUP", ["--registry", registryModule([baseEntry(), baseEntry()])]);

  const ci = baseEntry();
  ci.job = "python-gateway";
  expectOnly("REG-CI", ["--registry", registryModule([ci])], /python-gateway/);
});

test("coverage keys must be exactly the Static_Gates and values behavioral checks", () => {
  const withoutKey = { ...STATIC_GATE_COVERAGE };
  delete withoutKey["deploy:check"];
  expectOnly("SGC-KEY", ["--coverage", coverageModule(withoutKey)], /deploy:check is a Static_Gate/);
  expectOnly("SGC-KEY", ["--coverage", coverageModule({ ...STATIC_GATE_COVERAGE, "deploy:check:test": [] })], /deploy:check:test is not a Static_Gate/);
  expectOnly("SGC-TEST", ["--coverage", coverageModule({ ...STATIC_GATE_COVERAGE, "deploy:check": [{ test: "runtime:worker:config:test" }] })], /labeled static/);
  expectOnly("SGC-TEST", ["--coverage", coverageModule({ ...STATIC_GATE_COVERAGE, "deploy:check": [{ test: "scripts/test-missing.mjs" }] })], /does not exist/);
  expectOnly("SGC-TEST", ["--coverage", coverageModule({ ...STATIC_GATE_COVERAGE, "deploy:check": [{ test: "no-such-script" }] })], /not an npm script/);
  const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  const wired = Object.keys(STATIC_GATE_COVERAGE).filter((key) => scripts[key] !== undefined || LOCAL_CHECKS.some((check) => check.id === key));
  assert.deepEqual(new Set(wired), new Set(staticGateIds(LOCAL_CHECKS, scripts)));
  const pendingRun = runGate(["--coverage", coverageModule({ ...STATIC_GATE_COVERAGE, "not:wired:yet": [] })]);
  assert.equal(pendingRun.status, 0, pendingRun.lines.join("\n"));
  assert.ok(pendingRun.lines.some((line) => line.startsWith("NOTE SGC-KEY not:wired:yet ")), pendingRun.lines.join("\n"));
  expectOnly("SGC-TEST", ["--coverage", coverageModule({ ...STATIC_GATE_COVERAGE, "not:wired:yet": [{ test: "deploy:check:test" }] })], /not wired yet must have \[\]/);
  assert.equal(labelOfTest("scripts/test-postgres-backup-direct.sh", { localChecks: LOCAL_CHECKS, ciOnlySteps: CI_ONLY_STEPS }), "behavioral", "bash -n only parses the script; the behavioral step runs it");
});

test("an unimportable registry module exits with 2", () => {
  const run = runGate(["--registry", file("broken.mjs", "export const REGRESSIONS = [;\n")]);
  assert.equal(run.status, 2);
});

test("REG-WORKFLOW rejects unsafe regression-evidence workflows", () => {
  // The variants below edit LF text; a Windows checkout with core.autocrlf=true has CRLF line endings.
  const text = readFileSync(path.join(root, ".github", "workflows", "regression-evidence.yml"), "utf8").replace(/\r\n/g, "\n");
  const pins = JSON.parse(readFileSync(path.join(root, ".github", "action-pins.json"), "utf8"));
  const problems = (workflowText) => {
    const found = [];
    checkEvidenceWorkflow({ text: workflowText, pins, report: (code, object, message) => found.push(`${code} ${object} ${message}`) });
    return found;
  };
  assert.deepEqual(problems(text), []);
  const variants = {
    interpolation: text.replace('args=(--issue "$ISSUE" --mode "$MODE")', 'args=(--issue "${{ inputs.issue }}" --mode "$MODE")'),
    permissions: text.replace("permissions:\n  contents: read", "permissions: write-all"),
    tag: text.replace(/actions\/checkout@[0-9a-f]{40} # v\S+/, "actions/checkout@v4"),
    sha: text.replace(/actions\/checkout@[0-9a-f]{40}/, `actions/checkout@${"1".repeat(40)}`),
    push: text.replace("on:\n  workflow_dispatch:", "on:\n  push:\n  workflow_dispatch:")
  };
  for (const [name, variant] of Object.entries(variants)) {
    assert.notEqual(variant, text, `${name} variant must change the workflow`);
    const found = problems(variant);
    assert.ok(found.length > 0 && found.every((line) => line.startsWith("REG-WORKFLOW ")), `${name}: ${found.join("\n")}`);
  }
  expectOnly("REG-WORKFLOW", ["--workflow", file("workflow.yml", variants.push)], /workflow_dispatch/);
});
