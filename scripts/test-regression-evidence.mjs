// Behavioral tests for scripts/regression-evidence.mjs, scripts/lib/regression-classify.mjs
// and scripts/lib/regression-reporter.mjs (Requirement 36.2, 36.3; design part 8 §2.3, §2.5).
// The evidence runner is exercised on a throw-away git repository: a fix commit whose
// regression test fails with an assertion on the parent (node:test and plain node:assert
// variants), a fix whose test imports a module that only the fix adds (invalid), and an
// integration entry without DATABASE_URL (invalid, database_unavailable). Every run must
// leave no worktree behind.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyRun, lastErrorBlock, meetsExpectation } from "./lib/regression-classify.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "scripts", "regression-evidence.mjs");
const reporter = pathToFileURL(path.join(root, "scripts", "lib", "regression-reporter.mjs")).href;
const temporary = [];
test.after(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function scratch(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

function write(base, file, text) {
  const target = path.join(base, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}

const IDENTITY = ["-c", "user.name=Regression Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"];

function git(repo, ...args) {
  const result = spawnSync("git", [...IDENTITY, ...args], { cwd: repo, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commitAll(repo, message) {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

/** A repository with base → fix (value 1 → 2, adds the tests) → fix2 (adds a module and a test importing it). */
function fixtureRepository() {
  const repo = scratch("regression-fixture-");
  git(repo, "init", "-q", "-b", "main");
  write(repo, "package.json", `${JSON.stringify({ name: "regression-fixture", version: "1.0.0", private: true, type: "module" }, null, 2)}\n`);
  write(repo, "package-lock.json", `${JSON.stringify({ name: "regression-fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "regression-fixture", version: "1.0.0" } } }, null, 2)}\n`);
  write(repo, "lib/value.mjs", "export const value = 1;\n");
  const base = commitAll(repo, "base: value is 1");
  write(repo, "lib/value.mjs", "export const value = 2;\n");
  write(repo, "test/value.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { value } from "../lib/value.mjs";\ntest("value is two", () => {\n  assert.equal(value, 2);\n});\n');
  write(repo, "test/plain.mjs", 'import assert from "node:assert/strict";\nimport { value } from "../lib/value.mjs";\nassert.equal(value, 2, "plain value must be two");\nconsole.log("PASS plain");\n');
  const fix = commitAll(repo, "fix: value is 2");
  write(repo, "lib/extra.mjs", "export const extra = true;\n");
  write(repo, "test/extra.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { extra } from "../lib/extra.mjs";\ntest("extra exists", () => {\n  assert.equal(extra, true);\n});\n');
  const fixWithModule = commitAll(repo, "fix: add extra");
  const entry = (issue, fixCommit, run, files, assertion = null) => ({ issue, requirement: "36", fixCommit, registerTest: `node ${run.target}`, label: "behavioral", job: "node-unit", run, assertion, files });
  const registry = [
    entry("C1", fix, { kind: "node", target: "test/value.test.mjs" }, ["test/value.test.mjs"], "value is two"),
    entry("C2", fix, { kind: "node", target: "test/plain.mjs" }, ["test/plain.mjs"], "plain value must be two"),
    entry("C3", fixWithModule, { kind: "node", target: "test/extra.test.mjs" }, ["test/extra.test.mjs"]),
    entry("C4", fix, { kind: "integration", target: "test/value.test.mjs" }, ["test/value.test.mjs"])
  ];
  const registryFile = path.join(scratch("regression-registry-"), "registry.mjs");
  writeFileSync(registryFile, `export const REGRESSIONS = ${JSON.stringify(registry, null, 2)};\n`);
  return { repo, base, fix, fixWithModule, registryFile };
}

function evidence(fixture, ...args) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const result = spawnSync(process.execPath, [runner, "--repo", fixture.repo, "--registry", fixture.registryFile, "--modules-cache", scratch("regression-modules-"), "--json", ...args], { cwd: root, encoding: "utf8", env, windowsHide: true, timeout: 120_000 });
  const line = result.stdout.split(/\r?\n/).find((text) => text.startsWith("{"));
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, result: line ? JSON.parse(line) : null };
}

function assertNoWorktree(fixture, run) {
  const list = git(fixture.repo, "worktree", "list", "--porcelain").split(/\r?\n/).filter((line) => line.startsWith("worktree "));
  assert.equal(list.length, 1, `only the main worktree must remain: ${list.join(", ")}`);
  if (run.result?.worktree) assert.equal(existsSync(run.result.worktree), false, "the temporary worktree directory must be deleted");
}

test("regression-evidence classifies the three outcomes on a temporary repository and removes its worktrees", async (t) => {
  const fixture = fixtureRepository();

  await t.test("parent of a node:test fix fails with an assertion on the registered case", () => {
    const run = evidence(fixture, "--issue", "C1", "--mode", "parent");
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(run.result.outcome, "assertion-failure");
    assert.equal(run.result.parentCommit, fixture.base);
    assert.equal(run.result.targetCommit, fixture.base);
    assert.equal(run.result.assertionMatched, true);
    assert.deepEqual(run.result.failing.map((item) => [item.name, item.code]), [["value is two", "ERR_ASSERTION"]]);
    assert.equal(run.result.worktreeRemoved, true);
    assertNoWorktree(fixture, run);
  });

  await t.test("the same test passes on the fix commit", () => {
    const run = evidence(fixture, "--issue", "C1", "--mode", "fix");
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(run.result.outcome, "pass");
    assert.equal(run.result.targetCommit, fixture.fix);
    assertNoWorktree(fixture, run);
  });

  await t.test("a plain node:assert script fails with AssertionError on the parent and passes on the fix", () => {
    const parent = evidence(fixture, "--issue", "C2", "--mode", "parent");
    assert.equal(parent.status, 0, parent.stderr || parent.stdout);
    assert.equal(parent.result.outcome, "assertion-failure");
    assert.equal(parent.result.assertionMatched, true);
    assertNoWorktree(fixture, parent);
    const fix = evidence(fixture, "--issue", "C2", "--mode", "fix");
    assert.equal(fix.status, 0, fix.stderr || fix.stdout);
    assert.equal(fix.result.outcome, "pass");
    assertNoWorktree(fixture, fix);
  });

  await t.test("a test that imports a module only the fix adds is invalid on the parent", () => {
    const run = evidence(fixture, "--issue", "C3", "--mode", "parent");
    assert.equal(run.status, 1);
    assert.equal(run.result.outcome, "invalid");
    assert.equal(run.result.parentCommit, fixture.fix);
    assert.match(run.result.reason, /ERR_MODULE_NOT_FOUND|no ERR_ASSERTION/);
    assertNoWorktree(fixture, run);
  });

  await t.test("an integration entry without DATABASE_URL is invalid with database_unavailable", () => {
    const run = evidence(fixture, "--issue", "C4", "--mode", "parent");
    assert.equal(run.status, 1);
    assert.equal(run.result.outcome, "invalid");
    assert.equal(run.result.reason, "database_unavailable");
    assertNoWorktree(fixture, run);
  });

  await t.test("--keep-worktree keeps the tree and reports its path", () => {
    const run = evidence(fixture, "--issue", "C1", "--mode", "parent", "--keep-worktree");
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(run.result.worktreeRemoved, false);
    assert.equal(existsSync(path.join(run.result.worktree, "test", "value.test.mjs")), true);
    git(fixture.repo, "worktree", "remove", "--force", run.result.worktree);
    // The kept worktree lives in the runner's scratch directory (with events.jsonl and output.log).
    rmSync(path.dirname(run.result.worktree), { recursive: true, force: true });
  });

  await t.test("argument and lookup errors exit with 2", () => {
    for (const args of [["--issue", "X1", "--mode", "parent"], ["--issue", "C1", "--mode", "both"], ["--issue", "C1", "--mode", "parent", "--fix", "abc"], ["--issue", "C1", "--mode", "parent", "--fix", "0".repeat(40)], ["--issue", "H9", "--mode", "fix"]]) {
      const run = evidence(fixture, ...args);
      assert.equal(run.status, 2, `${args.join(" ")} must exit 2: ${run.stdout}${run.stderr}`);
    }
    assertNoWorktree(fixture, { result: null });
  });
});

test("regression-reporter writes the fields classifyRun needs", () => {
  const directory = scratch("regression-reporter-");
  write(directory, "sample.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("fails", () => assert.equal(1, 2));\ntest("passes", () => {});\ntest.describe("prepared", () => { test.before(() => { throw new Error("before failed"); }); test("inner", () => {}); });\n');
  const events = path.join(directory, "events.jsonl");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", `--test-reporter=${reporter}`, `--test-reporter-destination=${events}`, "sample.test.mjs"], { cwd: directory, encoding: "utf8", env, windowsHide: true });
  assert.equal(run.status, 1);
  const lines = readFileSync(events, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const failure = lines.find((line) => line.type === "test:fail" && line.name === "fails");
  assert.equal(failure.causeCode, "ERR_ASSERTION");
  assert.equal(failure.causeName, "AssertionError");
  assert.equal(failure.failureType, "testCodeFailure");
  assert.ok(lines.some((line) => line.type === "test:pass" && line.name === "passes"));
  assert.ok(lines.some((line) => line.type === "test:fail" && line.failureType === "hookFailed"));
  assert.equal(classifyRun({ runner: "node-test", exitCode: run.status, reporterEvents: lines }).outcome, "invalid", "a failed before hook is a preparation failure");
});

test("classifyRun follows the design's rules", () => {
  const fail = (fields) => ({ type: "test:fail", name: "case", failureType: "testCodeFailure", ...fields });
  const nodeTest = (events, exitCode = 1) => classifyRun({ runner: "node-test", exitCode, reporterEvents: events }).outcome;
  assert.equal(nodeTest([fail({ causeCode: "ERR_ASSERTION", causeName: "AssertionError" })]), "assertion-failure");
  assert.equal(nodeTest([fail({ causeCode: "ERR_ASSERTION" }), fail({ failureType: "hookFailed", causeName: "Error" })]), "invalid");
  assert.equal(nodeTest([fail({ causeCode: "ERR_ASSERTION" }), fail({ causeCode: "ERR_MODULE_NOT_FOUND" })]), "invalid");
  assert.equal(nodeTest([fail({ causeName: "SyntaxError" })]), "invalid");
  assert.equal(nodeTest([fail({ causeCode: "ERR_ASSERTION" }), fail({ causeCode: "ECONNREFUSED" })]), "invalid");
  assert.equal(nodeTest([fail({ causeCode: "ERR_ASSERTION" }), fail({ causeName: "HarnessPrerequisiteError" })]), "invalid");
  assert.equal(nodeTest([fail({ causeCode: "ERR_ASSERTION" }), fail({ failureType: "cancelledByParent" })]), "assertion-failure", "cancelled subtests carry no failure of their own");
  assert.equal(nodeTest([fail({ causeName: "Error" })]), "invalid", "a plain Error is not an assertion failure");
  assert.equal(nodeTest([], 0), "pass");
  assert.equal(nodeTest([], 1), "invalid");

  const python = (stderr, exitCode = 1) => classifyRun({ runner: "python", exitCode, stderr }).outcome;
  assert.equal(python('Traceback (most recent call last):\n  File "t.py", line 3, in <module>\n    assert value == 2, "value"\n           ^^^^^^^^^^\nAssertionError: value\n'), "assertion-failure");
  assert.equal(python("Traceback (most recent call last):\n  File \"t.py\", line 1, in <module>\n    import httpx\nModuleNotFoundError: No module named 'httpx'\n"), "invalid");
  assert.equal(python("", 0), "pass");
  assert.equal(python("RuntimeError without traceback"), "invalid");

  const script = (stderr, exitCode = 1) => classifyRun({ runner: "script", exitCode, stderr }).outcome;
  assert.equal(script("node:internal/process/esm_loader:40\nAssertionError [ERR_ASSERTION]: plain value must be two\n    at file:///t.mjs:3:8 {\n  code: 'ERR_ASSERTION'\n}\n\nNode.js v24\n"), "assertion-failure");
  assert.equal(script("Error: timed out waiting for /healthz\n    at waitFor (file:///t.mjs:1:1)\n"), "invalid");
  assert.equal(script("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x.mjs' imported from /t.mjs\n"), "invalid");
  assert.equal(script("SyntaxError: The requested module './lib.mjs' does not provide an export named 'x'\n"), "invalid");
  assert.equal(script("AssertionError [ERR_ASSERTION]: Got unwanted rejection.\n  actual: Error: nested header inside the block\n      at x\n  code: 'ERR_ASSERTION'\n}\n"), "assertion-failure", "an indented nested error does not start a new block");
  assert.equal(lastErrorBlock("x\nTypeError: boom\n  at y\n").name, "TypeError");
  assert.equal(classifyRun({ runner: "script", exitCode: null, timedOut: true }).outcome, "invalid");
  assert.equal(classifyRun({ runner: "script", unavailable: "database_unavailable" }).reason, "database_unavailable");

  assert.equal(meetsExpectation("parent", { outcome: "assertion-failure", failing: [{ name: "value is two" }] }, "value is two"), true);
  assert.equal(meetsExpectation("parent", { outcome: "assertion-failure", failing: [{ name: "another case" }] }, "value is two"), false);
  assert.equal(meetsExpectation("parent", { outcome: "pass", failing: [] }, null), false);
  assert.equal(meetsExpectation("parent", { outcome: "assertion-failure", failing: [{ name: "baseline" }] }, null), false, "an unpinned assertion is not evidence");
  assert.equal(meetsExpectation("parent", { outcome: "assertion-failure", failing: [{ name: "AssertionError: Got unwanted rejection.", detail: "actual: Error: preflight took a second pooled connection" }] }, "second pooled connection"), true, "the assertion may match the error block of a plain script");
  assert.equal(meetsExpectation("fix", { outcome: "pass", failing: [] }, "value is two"), true);
});
