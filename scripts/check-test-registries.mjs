#!/usr/bin/env node
// Gate for the regression registry, the static gate coverage map and the manual
// regression-evidence workflow (Requirement 36.1–36.4, 36.13, 36.14; design part
// 8 §2.3 error codes). One line `<code> <object> <message>` per problem; exit 1
// when there is any, 2 when a registry module cannot be imported.
//
//   REG-FIELD     an entry lacks a field or a field has the wrong form
//   REG-COMMIT    fixCommit is not a commit of the repository
//   REG-FILE      run.target is missing from the working tree, or a `files` item from fixCommit
//   REG-ISSUE     the issue is not in docs/AUDIT_REGISTER.md, its 修复.提交 is a different
//                 commit, or registerTest is not one of its 修复.回归测试
//   REG-DUP       the same (issue, run.target, run.args) is registered twice
//   REG-CI        `job` is not a ci.yml job, or no run: line of that job is registerTest
//   REG-WORKFLOW  .github/workflows/regression-evidence.yml is not manual-only, read-only,
//                 injection-safe and pinned to .github/action-pins.json
//   SGC-KEY       a Static_Gate has no STATIC_GATE_COVERAGE key, or a key is not a Static_Gate
//                 (a key with no package.json script and no LOCAL_CHECKS entry yet, i.e. a
//                 check not wired yet, is a NOTE and must have [])
//   SGC-TEST      a coverage item is not an existing behavioral check or test file
//
// In a shallow clone fixCommit may be absent; REG-COMMIT and the fixCommit side of
// REG-FILE are then reported as NOTE lines and do not fail the gate.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { parseAuditRegister } from "./lib/audit-register.mjs";
import { LOCAL_CHECKS } from "./verify-local-checks.mjs";
import { CI_ONLY_STEPS } from "./ci-required-steps.mjs";

export const ERROR_CODES = Object.freeze(["REG-FIELD", "REG-COMMIT", "REG-FILE", "REG-ISSUE", "REG-DUP", "REG-CI", "REG-WORKFLOW", "SGC-KEY", "SGC-TEST"]);
export const RUN_KINDS = Object.freeze(["node", "integration", "python", "npm"]);
export const JOBS = Object.freeze(["static-gates", "node-unit", "python-gateway", "postgres-integration", "compose-render", "docker-build"]);
const ISSUE = /^[CHMLN][1-9][0-9]*$/;
const SHA = /^[0-9a-f]{40}$/;
const STATIC_GATE_SCRIPT = /^node scripts\/check-[^\s/]+\.mjs(?:\s|$)/;
const USES_LINE = /^\s*(?:-\s+)?uses:\s*([^\s@#]+)@([^\s#]+)\s*(?:#\s*(\S+))?\s*$/;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function collapse(text) {
  return String(text).trim().replace(/\s+/g, " ");
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? "" };
}

/** Static_Gate ids: npm checks labeled static whose script runs `node scripts/check-*.mjs`. */
export function staticGateIds(localChecks, scripts) {
  return localChecks.filter((check) => check.kind === "npm" && check.label === "static" && STATIC_GATE_SCRIPT.test(scripts[check.script] ?? "")).map((check) => check.id);
}

/** Label of a coverage test name: a LOCAL_CHECKS id, an npm script run by a CI_ONLY_STEPS command, or a file named by one. */
export function labelOfTest(test, { localChecks, ciOnlySteps }) {
  const local = localChecks.find((check) => check.id === test || (check.kind === "npm" && check.script === test) || (check.kind === "python" && check.file === test));
  if (local) return local.label;
  const step = ciOnlySteps.find((candidate) => {
    const tokens = collapse(candidate.command).split(" ");
    // `npm run <test> …`, or an interpreter running the file itself (`bash -n <file>` only parses it).
    return (tokens[0] === "npm" && tokens[1] === "run" && tokens[2] === test) || (tokens.length === 2 && ["bash", "sh", "node", "python3", "python"].includes(tokens[0]) && tokens[1] === test);
  });
  return step ? step.label : null;
}

function registerIndex(text) {
  const { records } = parseAuditRegister(text);
  const index = new Map();
  for (const record of records) {
    const data = record.data ?? record;
    if (data && typeof data === "object" && typeof data.编号 === "string") index.set(data.编号, data);
  }
  return index;
}

function jobRunLines(workflow) {
  const result = new Map();
  for (const [id, job] of Object.entries(workflow?.jobs ?? {})) {
    const lines = [];
    for (const step of job?.steps ?? []) if (typeof step?.run === "string") for (const line of step.run.split("\n")) if (line.trim()) lines.push(collapse(line));
    result.set(id, lines);
  }
  return result;
}

function checkEntryFields(entry, where, report) {
  if (entry === null || typeof entry !== "object") return report("REG-FIELD", where, "entry is not an object"), false;
  let ok = true;
  const bad = (field, message) => {
    ok = false;
    report("REG-FIELD", where, `${field} ${message}`);
  };
  if (typeof entry.issue !== "string" || !ISSUE.test(entry.issue)) bad("issue", "must match ^[CHMLN][1-9][0-9]*$");
  if (typeof entry.requirement !== "string" || entry.requirement.trim() === "") bad("requirement", "must be a non-empty string");
  if (typeof entry.fixCommit !== "string" || !SHA.test(entry.fixCommit)) bad("fixCommit", "must be a 40-character lowercase SHA");
  if (typeof entry.registerTest !== "string" || entry.registerTest.trim() === "") bad("registerTest", "must name the 修复.回归测试 item it runs");
  if (entry.label !== "static" && entry.label !== "behavioral") bad("label", "must be static or behavioral");
  if (!JOBS.includes(entry.job)) bad("job", `must be one of ${JOBS.join(", ")}`);
  if (entry.assertion !== null && (typeof entry.assertion !== "string" || entry.assertion.trim() === "")) bad("assertion", "must be a non-empty string or null");
  const run = entry.run;
  if (run === null || typeof run !== "object") bad("run", "must be an object");
  else {
    if (!RUN_KINDS.includes(run.kind)) bad("run.kind", `must be one of ${RUN_KINDS.join(", ")}`);
    if (typeof run.target !== "string" || run.target.trim() === "") bad("run.target", "must be a test path or npm script name");
    if (run.args !== undefined && !(Array.isArray(run.args) && run.args.every((item) => typeof item === "string"))) bad("run.args", "must be an array of strings");
    if (run.prepare !== undefined && !(Array.isArray(run.prepare) && run.prepare.every((step) => Array.isArray(step) && step.length > 0 && step.every((item) => typeof item === "string")))) bad("run.prepare", "must be an array of argv arrays");
    if (run.env !== undefined && (run.env === null || typeof run.env !== "object" || !Object.values(run.env).every((value) => typeof value === "string"))) bad("run.env", "must map names to strings");
    if (run.nodeModules !== undefined && run.nodeModules !== "install") bad("run.nodeModules", "must be \"install\" when present");
    if (run.kind === "integration" && entry.job !== "postgres-integration") bad("job", "of an integration entry must be postgres-integration");
  }
  if (!Array.isArray(entry.files) || entry.files.length === 0 || !entry.files.every((file) => typeof file === "string" && file && !path.isAbsolute(file) && !file.split("/").includes(".."))) bad("files", "must be a non-empty array of repository-relative paths");
  else if (run && run.kind !== "npm" && entry.files[0] !== run.target) bad("files", "must start with run.target");
  return ok;
}

/** Which `<rev>` / `<rev>:<path>` objects exist, with one `git cat-file --batch-check`. */
function existingObjects(root, names) {
  const unique = [...new Set(names)];
  if (unique.length === 0) return new Set();
  const result = spawnSync("git", ["cat-file", "--batch-check"], { cwd: root, input: `${unique.join("\n")}\n`, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const lines = (result.stdout ?? "").split("\n");
  return new Set(unique.filter((name, index) => lines[index] !== undefined && !lines[index].endsWith(" missing") && !lines[index].endsWith(" ambiguous")));
}

export function checkRegistry({ entries, root, registerText, workflow, report, note }) {
  const register = registerIndex(registerText);
  const jobs = jobRunLines(workflow);
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true";
  const wellFormed = entries.filter((entry) => entry && typeof entry.fixCommit === "string" && SHA.test(entry.fixCommit) && Array.isArray(entry.files));
  const known = existingObjects(root, wellFormed.flatMap((entry) => [`${entry.fixCommit}^{commit}`, ...entry.files.filter((item) => typeof item === "string").map((item) => `${entry.fixCommit}:${item}`)]));
  const seen = new Set();
  entries.forEach((entry, index) => {
    const where = `REGRESSIONS[${index}]${entry?.issue ? ` (${entry.issue} ${entry?.run?.target ?? ""})`.trimEnd() : ""}`;
    if (!checkEntryFields(entry, where, report)) return;
    const key = JSON.stringify([entry.issue, entry.run.target, entry.run.args ?? []]);
    if (seen.has(key)) report("REG-DUP", where, `${entry.issue} with ${entry.run.target} is already registered`);
    seen.add(key);
    const commitKnown = known.has(`${entry.fixCommit}^{commit}`);
    if (!commitKnown) (shallow ? note : (code, object, message) => report(code, object, message))("REG-COMMIT", where, `fixCommit ${entry.fixCommit} is not a commit of this repository${shallow ? " (shallow clone; not checked)" : ""}`);
    if (entry.run.kind !== "npm" && !existsSync(path.join(root, entry.run.target))) report("REG-FILE", where, `run.target ${entry.run.target} does not exist in the working tree, so CI cannot run it (Requirement 36.4)`);
    if (commitKnown) for (const file of entry.files) if (!known.has(`${entry.fixCommit}:${file}`)) report("REG-FILE", where, `${file} does not exist in fixCommit ${entry.fixCommit.slice(0, 12)}`);
    const record = register.get(entry.issue);
    if (!record) report("REG-ISSUE", where, `${entry.issue} is not a record of docs/AUDIT_REGISTER.md`);
    else {
      const fix = record.修复;
      const sha = typeof fix?.提交 === "string" ? fix.提交 : "";
      if (!sha || !entry.fixCommit.startsWith(sha)) report("REG-ISSUE", where, `fixCommit ${entry.fixCommit.slice(0, 12)} is not the register's 修复.提交 ${sha || "（无）"}`);
      const tests = Array.isArray(fix?.回归测试) ? fix.回归测试 : [];
      if (!tests.includes(entry.registerTest)) report("REG-ISSUE", where, `registerTest "${entry.registerTest}" is not one of the register's 修复.回归测试`);
    }
    const lines = jobs.get(entry.job);
    if (!lines) report("REG-CI", where, `job ${entry.job} is not a job of .github/workflows/ci.yml`);
    else if (!lines.includes(collapse(entry.registerTest))) report("REG-CI", where, `no run: line of ci.yml job ${entry.job} is "${entry.registerTest}" (Requirement 36.4)`);
  });
}

export function checkCoverage({ coverage, localChecks, ciOnlySteps, scripts, root, report, note = () => {} }) {
  const gates = new Set(staticGateIds(localChecks, scripts));
  const known = new Set(localChecks.map((check) => check.id));
  for (const gate of gates) if (!Object.hasOwn(coverage, gate)) report("SGC-KEY", gate, "is a Static_Gate without a STATIC_GATE_COVERAGE key (write [] when no behavioral test covers it)");
  for (const [gate, items] of Object.entries(coverage)) {
    // A key may be committed before its check is wired: no package.json script and no
    // LOCAL_CHECKS entry of that name yet. It is reported as a NOTE until the wiring lands.
    const pending = !gates.has(gate) && scripts[gate] === undefined && !known.has(gate);
    if (pending) note("SGC-KEY", gate, "is not wired yet (no package.json script and no LOCAL_CHECKS entry); it must become a Static_Gate");
    else if (!gates.has(gate)) report("SGC-KEY", gate, "is not a Static_Gate (an npm check labeled static whose script runs node scripts/check-*.mjs)");
    if (pending && Array.isArray(items) && items.length > 0) {
      report("SGC-TEST", gate, "a key that is not wired yet must have [] (its tests are checked once it is a Static_Gate)");
      continue;
    }
    if (!Array.isArray(items)) {
      report("SGC-TEST", gate, "coverage must be an array");
      continue;
    }
    items.forEach((item, index) => {
      const where = `${gate}[${index}]`;
      const test = typeof item === "string" ? item : item?.test;
      if (typeof test !== "string" || test.trim() === "") return report("SGC-TEST", where, "has no test");
      if (typeof item === "object" && item.case !== undefined && (typeof item.case !== "string" || item.case.trim() === "")) report("SGC-TEST", where, "case must be a non-empty string");
      const isFile = test.includes("/");
      if (isFile && !existsSync(path.join(root, test))) return report("SGC-TEST", where, `${test} does not exist`);
      if (!isFile && typeof scripts[test] !== "string") return report("SGC-TEST", where, `${test} is not an npm script of package.json`);
      const label = labelOfTest(test, { localChecks, ciOnlySteps });
      if (label === null) report("SGC-TEST", where, `${test} is not a check of LOCAL_CHECKS or CI_ONLY_STEPS`);
      else if (label !== "behavioral") report("SGC-TEST", where, `${test} is labeled ${label}, not behavioral`);
    });
  }
}

/** Structure of the manual regression-evidence workflow (task 7.4). */
export function checkEvidenceWorkflow({ text, pins, report, file = ".github/workflows/regression-evidence.yml" }) {
  let workflow;
  try {
    workflow = yaml.load(text);
  } catch (error) {
    return report("REG-WORKFLOW", file, `is not valid YAML: ${error.message.split("\n")[0]}`);
  }
  if (!workflow || typeof workflow !== "object") return report("REG-WORKFLOW", file, "is empty");
  const triggers = workflow.on;
  const names = typeof triggers === "string" ? [triggers] : Array.isArray(triggers) ? triggers : Object.keys(triggers ?? {});
  if (names.length !== 1 || names[0] !== "workflow_dispatch") report("REG-WORKFLOW", file, `must trigger only on workflow_dispatch, found ${names.join(", ") || "none"}`);
  const permissions = workflow.permissions;
  if (!permissions || typeof permissions !== "object" || Object.keys(permissions).length !== 1 || permissions.contents !== "read") report("REG-WORKFLOW", file, "top-level permissions must be exactly contents: read");
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    if (job?.permissions !== undefined) report("REG-WORKFLOW", `${file} jobs.${jobId}`, "must not widen permissions");
    for (const [index, step] of (job?.steps ?? []).entries()) {
      if (typeof step?.run === "string" && /\$\{\{\s*(?:inputs|github\.event\.inputs)\./.test(step.run)) report("REG-WORKFLOW", `${file} jobs.${jobId}.steps[${index}]`, "run: interpolates a workflow input; pass it through step env");
    }
  }
  if (/\$\{\{\s*secrets\./.test(text)) report("REG-WORKFLOW", file, "must not use secrets");
  const actions = pins?.actions ?? {};
  text.split(/\r?\n/).forEach((line, index) => {
    if (!/^\s*(?:-\s+)?uses:/.test(line)) return;
    const match = USES_LINE.exec(line);
    const where = `${file}:${index + 1}`;
    if (!match) return report("REG-WORKFLOW", where, "uses: must be <action>@<40-hex SHA> # <tag>");
    const [, action, ref, tag] = match;
    const pin = actions[action];
    if (!SHA.test(ref)) report("REG-WORKFLOW", where, `${action}@${ref} is not pinned to a commit SHA`);
    else if (!pin) report("REG-WORKFLOW", where, `${action} is not in .github/action-pins.json`);
    else if (pin.commit !== ref || pin.tag !== tag) report("REG-WORKFLOW", where, `${action} must be ${pin.commit} # ${pin.tag}`);
  });
}

function parseArguments(argv) {
  const options = {};
  const names = { "--root": "root", "--registry": "registry", "--coverage": "coverage", "--register": "register", "--ci": "ci", "--workflow": "workflow", "--pins": "pins", "--package": "package" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = names[argv[index]];
    if (!key || argv[index + 1] === undefined) throw new Error(`unknown or incomplete argument ${argv[index]}`);
    options[key] = argv[index + 1];
    index += 1;
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const root = path.resolve(options.root ?? repoRoot);
  const at = (value, fallback) => path.resolve(root, value ?? fallback);
  let registry;
  let coverage;
  try {
    registry = await import(pathToFileURL(at(options.registry, "scripts/regression-registry.mjs")).href);
    coverage = await import(pathToFileURL(at(options.coverage, "scripts/static-gate-coverage.mjs")).href);
  } catch (error) {
    process.stderr.write(`cannot import a registry module: ${error.message}\n`);
    return 2;
  }
  if (!Array.isArray(registry.REGRESSIONS) || !coverage.STATIC_GATE_COVERAGE || typeof coverage.STATIC_GATE_COVERAGE !== "object") {
    process.stderr.write("registry modules must export REGRESSIONS (array) and STATIC_GATE_COVERAGE (object)\n");
    return 2;
  }
  const errors = [];
  const notes = [];
  const report = (code, object, message) => errors.push(`${code} ${object} ${message}`);
  const note = (code, object, message) => notes.push(`NOTE ${code} ${object} ${message}`);
  const scripts = JSON.parse(readFileSync(at(options.package, "package.json"), "utf8")).scripts ?? {};
  checkRegistry({ entries: registry.REGRESSIONS, root, registerText: readFileSync(at(options.register, "docs/AUDIT_REGISTER.md"), "utf8"), workflow: yaml.load(readFileSync(at(options.ci, ".github/workflows/ci.yml"), "utf8")), report, note });
  checkCoverage({ coverage: coverage.STATIC_GATE_COVERAGE, localChecks: LOCAL_CHECKS, ciOnlySteps: CI_ONLY_STEPS, scripts, root, report, note });
  const workflowFile = at(options.workflow, ".github/workflows/regression-evidence.yml");
  if (!existsSync(workflowFile)) report("REG-WORKFLOW", path.relative(root, workflowFile).replace(/\\/g, "/"), "does not exist");
  else checkEvidenceWorkflow({ text: readFileSync(workflowFile, "utf8"), pins: JSON.parse(readFileSync(at(options.pins, ".github/action-pins.json"), "utf8")), report, file: path.relative(root, workflowFile).replace(/\\/g, "/") });
  for (const line of notes) process.stdout.write(`${line}\n`);
  for (const line of errors) process.stdout.write(`${line}\n`);
  if (errors.length > 0) return 1;
  process.stdout.write(`PASS  ${registry.REGRESSIONS.length} regression entries, ${Object.keys(coverage.STATIC_GATE_COVERAGE).length} static gate coverage keys and the regression-evidence workflow are consistent\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
