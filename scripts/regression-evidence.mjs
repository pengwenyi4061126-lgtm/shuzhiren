#!/usr/bin/env node
// Fix-parent evidence for a registered regression test (Requirement 7.12,
// 36.2, 36.3; design part 8 §2.1 "修复前失败的证据").
//
//   node scripts/regression-evidence.mjs --issue <ID> --mode parent|fix
//        [--fix <40-hex SHA>] [--target <test path>] [--keep-worktree] [--json]
//        [--registry <file>] [--repo <dir>] [--python <exe>] [--timeout-ms <n>]
//
// For every REGRESSIONS entry of the issue (narrowed by --fix / --target):
//   1. resolves the commit to test: the first parent of fixCommit (parent) or fixCommit (fix);
//   2. `git worktree add --detach` a temporary tree at that commit; in parent mode
//      `git checkout <fixCommit> -- <files…>` overlays the regression test and its fixtures;
//   3. links node_modules: the main checkout's when its package-lock.json equals the
//      commit's, otherwise a cached `npm ci` keyed by the lock file's SHA-256
//      (junctions on Windows); links submodules whose main-checkout HEAD equals the gitlink;
//   4. runs the test (node:test files with scripts/lib/regression-reporter.mjs); entries of
//      kind "integration" need DATABASE_URL and end as invalid/database_unavailable without it;
//   5. classifies the run with scripts/lib/regression-classify.mjs, prints one JSON line,
//      a readable summary and the YAML line for docs/AUDIT_REGISTER.md;
//   6. removes the links and the worktree in `finally` (unless --keep-worktree).
//
// The registry is read from the fix commit when that commit has
// scripts/regression-registry.mjs listing the issue, otherwise from the working tree
// (fix commits that predate the registry).
//
// Exit codes: 0 every selected entry met the expectation of the mode (parent →
// assertion-failure whose failing case contains `assertion`; fix → pass); 1 some
// entry did not (including invalid); 2 argument, registry or git errors.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyRun, assertionMatched, meetsExpectation } from "./lib/regression-classify.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = "scripts/regression-registry.mjs";
const ISSUE_PATTERN = /^[CHMLN][1-9][0-9]*$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const NODE_TEST_IMPORT = /(?:from\s*["']node:test["']|require\(\s*["']node:test["']\s*\)|import\(\s*["']node:test["']\s*\))/;
const TAIL_BYTES = 1 << 20;
const LF_CHECKOUT = Object.freeze(["-c", "core.autocrlf=false", "-c", "core.eol=lf"]);

class UsageError extends Error {}

export function parseArguments(argv) {
  const options = { keepWorktree: false, json: false, timeoutMs: 30 * 60 * 1000 };
  const valued = { "--issue": "issue", "--mode": "mode", "--fix": "fix", "--target": "target", "--registry": "registry", "--repo": "repo", "--python": "python", "--timeout-ms": "timeoutMs", "--modules-cache": "modulesCache" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--keep-worktree") options.keepWorktree = true;
    else if (argument === "--json") options.json = true;
    else if (Object.hasOwn(valued, argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${argument} needs a value`);
      options[valued[argument]] = value;
      index += 1;
    } else throw new UsageError(`unknown argument ${argument}`);
  }
  if (!options.issue || !ISSUE_PATTERN.test(options.issue)) throw new UsageError("--issue must match ^[CHMLN][1-9][0-9]*$");
  if (options.mode !== "parent" && options.mode !== "fix") throw new UsageError("--mode must be parent or fix");
  if (options.fix !== undefined && !SHA_PATTERN.test(options.fix)) throw new UsageError("--fix must be a 40-character lowercase hexadecimal SHA");
  const timeout = Number(options.timeoutMs);
  if (!Number.isInteger(timeout) || timeout <= 0) throw new UsageError("--timeout-ms must be a positive integer");
  options.timeoutMs = timeout;
  return options;
}

function git(repo, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const error = new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
    error.gitFailure = true;
    throw error;
  }
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function commitExists(repo, sha) {
  return git(repo, ["cat-file", "-e", `${sha}^{commit}`], { allowFailure: true }).ok;
}

async function importModuleFromText(source, directory, name) {
  const file = path.join(directory, name);
  writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

async function loadRegistry(repo, registryFile, scratch) {
  const file = path.resolve(repo, registryFile ?? REGISTRY_PATH);
  if (!existsSync(file)) throw new UsageError(`registry ${file} does not exist`);
  const module = await import(pathToFileURL(file).href);
  if (!Array.isArray(module.REGRESSIONS)) throw new UsageError(`${file} does not export a REGRESSIONS array`);
  return { entries: module.REGRESSIONS, source: path.relative(repo, file).replace(/\\/g, "/") || file };
}

async function registryAtCommit(repo, commit, scratch) {
  const shown = git(repo, ["show", `${commit}:${REGISTRY_PATH}`], { allowFailure: true });
  if (!shown.ok) return null;
  try {
    const module = await importModuleFromText(shown.stdout, scratch, `registry-${commit.slice(0, 12)}.mjs`);
    return Array.isArray(module.REGRESSIONS) ? module.REGRESSIONS : null;
  } catch {
    return null;
  }
}

function normalizedLock(text) {
  return text.replace(/\r\n/g, "\n");
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function isLink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function linkDirectory(target, link) {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function quoteForCmd(argument) {
  return /^[A-Za-z0-9_\-+=:,./\\@]+$/.test(argument) ? argument : `"${argument.replace(/"/g, '""')}"`;
}

/** npm on Windows is a .cmd shim that Node only starts through a shell. */
function npmInvocation(args) {
  if (process.platform === "win32") return { command: ["npm", ...args].map(quoteForCmd).join(" "), args: [], shell: true };
  return { command: "npm", args, shell: false };
}

function runProcess(command, args, { cwd, env, timeoutMs, shell = false, logFile }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const log = [];
    const keep = (current, chunk) => {
      const next = current + chunk;
      return next.length > TAIL_BYTES ? next.slice(next.length - TAIL_BYTES) : next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = keep(stdout, chunk.toString("utf8"));
      if (logFile) log.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = keep(stderr, chunk.toString("utf8"));
      if (logFile) log.push(chunk);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, stdout, stderr: `${stderr}\n${error.stack ?? error}`, timedOut, durationMs: Date.now() - started, spawnError: error.code ?? error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (logFile) writeFileSync(logFile, Buffer.concat(log));
      resolve({ exitCode: code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

function workspacePackageFiles(repo, commit) {
  const rootPackage = JSON.parse(git(repo, ["show", `${commit}:package.json`]).stdout);
  const patterns = (Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : rootPackage.workspaces?.packages ?? []).map((pattern) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^$()|[\]{}\\]/g, "\\$&")).join("[^/]+")}/package\\.json$`));
  return git(repo, ["ls-tree", "-r", "--name-only", commit]).stdout.split("\n").filter((file) => patterns.some((pattern) => pattern.test(file)));
}

/** node_modules for the tree: the main checkout's when the lock files match, otherwise a cached `npm ci`. */
async function provideNodeModules({ repo, tree, commit, cacheRoot, timeoutMs, notes, install = false }) {
  const shown = git(repo, ["show", `${commit}:package-lock.json`], { allowFailure: true });
  if (!shown.ok) return { mode: "none", links: [] };
  if (install) {
    // Entries that build the console (next build) get a real install: bundlers refuse
    // a node_modules link that points outside the project root.
    const npm = npmInvocation(["ci", "--no-audit", "--no-fund"]);
    const installed = await runProcess(npm.command, npm.args, { cwd: tree, env: process.env, timeoutMs, shell: npm.shell });
    if (installed.exitCode !== 0) {
      notes.push(`npm ci in the worktree failed: ${installed.stderr.trim().split(/\r?\n/).slice(-3).join(" | ")}`);
      return { mode: "worktree-install", links: [], failed: `npm ci exited ${installed.exitCode}` };
    }
    return { mode: "worktree-install", links: [] };
  }
  const lock = normalizedLock(shown.stdout);
  const mainLock = path.join(repo, "package-lock.json");
  const mainModules = path.join(repo, "node_modules");
  const link = path.join(tree, "node_modules");
  if (existsSync(mainLock) && normalizedLock(readFileSync(mainLock, "utf8")) === lock) {
    if (!existsSync(mainModules)) return { mode: "none", links: [] };
    linkDirectory(mainModules, link);
    return { mode: "main-checkout", links: [link] };
  }
  const key = sha256(lock).slice(0, 16);
  const cache = path.join(cacheRoot, key);
  const marker = path.join(cache, ".regression-evidence-complete");
  if (!existsSync(marker)) {
    rmSync(cache, { recursive: true, force: true });
    mkdirSync(cache, { recursive: true });
    for (const file of ["package.json", "package-lock.json", ...workspacePackageFiles(repo, commit)]) {
      const target = path.join(cache, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, git(repo, ["show", `${commit}:${file}`]).stdout);
    }
    const npm = npmInvocation(["ci", "--no-audit", "--no-fund"]);
    const installed = await runProcess(npm.command, npm.args, { cwd: cache, env: process.env, timeoutMs, shell: npm.shell });
    if (installed.exitCode !== 0) {
      notes.push(`npm ci for lock ${key} failed: ${installed.stderr.trim().split(/\r?\n/).slice(-3).join(" | ")}`);
      return { mode: `cache:${key}`, links: [], failed: `npm ci exited ${installed.exitCode}` };
    }
    writeFileSync(marker, `${new Date().toISOString()}\n`);
  }
  linkDirectory(path.join(cache, "node_modules"), link);
  return { mode: `cache:${key}`, links: [link] };
}

function linkSubmodules({ repo, tree, commit, notes }) {
  const links = [];
  const listing = git(repo, ["ls-tree", "-r", commit]).stdout.split("\n").filter((line) => line.startsWith("160000 "));
  for (const line of listing) {
    const [meta, file] = line.split("\t");
    const sha = meta.split(" ")[2];
    const source = path.join(repo, file);
    const head = git(source, ["rev-parse", "HEAD"], { allowFailure: true });
    if (!existsSync(source) || !head.ok || head.stdout.trim() !== sha) {
      notes.push(`submodule ${file} not linked: main checkout is at ${head.ok ? head.stdout.trim().slice(0, 12) : "no checkout"}, commit needs ${sha.slice(0, 12)}`);
      continue;
    }
    const target = path.join(tree, file);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(path.dirname(target), { recursive: true });
    linkDirectory(source, target);
    links.push(target);
  }
  return links;
}

function defaultPython(options) {
  return options.python ?? process.env.REGRESSION_PYTHON ?? process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
}

/** Builds the command for an entry; `runner` selects the classification rules. */
export function planRun(entry, { tree, reporterUrl, eventsFile, python }) {
  const run = entry.run;
  const args = Array.isArray(run.args) ? run.args : [];
  if (run.kind === "node" || run.kind === "integration") {
    const source = readFileSync(path.join(tree, run.target), "utf8");
    if (NODE_TEST_IMPORT.test(source)) {
      return { runner: "node-test", command: process.execPath, args: ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout", `--test-reporter=${reporterUrl}`, `--test-reporter-destination=${eventsFile}`, run.target], display: `node --test ${run.target}` };
    }
    return { runner: "script", command: process.execPath, args: [run.target, ...args], display: ["node", run.target, ...args].join(" ") };
  }
  if (run.kind === "python") return { runner: "python", command: python, args: [run.target, ...args], display: ["python3", run.target, ...args].join(" ") };
  if (run.kind === "npm") {
    const npm = npmInvocation(["run", run.target, ...(args.length ? ["--", ...args] : [])]);
    return { runner: "script", command: npm.command, args: npm.args, shell: npm.shell, display: ["npm", "run", run.target, ...(args.length ? ["--", ...args] : [])].join(" ") };
  }
  throw new UsageError(`entry ${entry.issue} has unknown run.kind ${run.kind}`);
}

function readEvents(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function removeWorktree(repo, tree, links) {
  for (const link of links.reverse()) if (isLink(link)) unlinkSync(link);
  git(repo, ["worktree", "remove", "--force", "--force", tree], { allowFailure: true });
  if (existsSync(tree)) {
    // Never recurse through a link that survived: unlink first, then remove the tree.
    for (const link of links) if (isLink(link)) unlinkSync(link);
    rmSync(tree, { recursive: true, force: true });
  }
  git(repo, ["worktree", "prune"], { allowFailure: true });
  return !existsSync(tree);
}

function runLocation() {
  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_RUN_ID) return `GitHub Actions ${process.env.GITHUB_WORKFLOW ?? "workflow"} run ${process.env.GITHUB_RUN_ID}`;
  return `${os.type()} ${os.release()} ${os.arch()}, Node ${process.version}`;
}

async function evaluateEntry(entry, { repo, options, registrySource }) {
  const fixCommit = entry.fixCommit;
  const parentCommit = git(repo, ["rev-parse", `${fixCommit}^1`]).stdout.trim();
  const targetCommit = options.mode === "parent" ? parentCommit : fixCommit;
  const notes = [];
  const base = {
    issue: entry.issue,
    requirement: entry.requirement,
    mode: options.mode,
    fixCommit,
    parentCommit,
    targetCommit,
    kind: entry.run.kind,
    target: entry.run.target,
    registerTest: entry.registerTest ?? null,
    assertion: entry.assertion ?? null,
    expected: options.mode === "parent" ? "assertion-failure" : "pass",
    evidenceCommand: `node scripts/regression-evidence.mjs --issue ${entry.issue} --mode ${options.mode} --target ${entry.run.target}`,
    registrySource,
    runLocation: runLocation(),
    date: new Date().toISOString().slice(0, 10)
  };
  const finish = (fields) => {
    const result = { outcome: fields.outcome, reason: fields.reason, failing: (fields.failing ?? []).slice(0, 20).map((item) => (item.detail ? { ...item, detail: entry.run.kind === "python" ? item.detail.slice(-800) : item.detail.slice(0, 800) } : item)) };
    const matched = assertionMatched(result, entry.assertion);
    return { ...base, ...fields, failing: result.failing, assertionMatched: options.mode === "parent" ? matched : null, meetsExpectation: meetsExpectation(options.mode, result, entry.assertion), notes };
  };
  if (entry.run.kind === "integration" && !process.env.DATABASE_URL) {
    return finish({ command: entry.run.target, outcome: "invalid", reason: "database_unavailable", exitCode: null, durationMs: 0, worktree: null, worktreeRemoved: true });
  }
  const scratch = mkdtempSync(path.join(os.tmpdir(), "regression-evidence-"));
  const tree = path.join(scratch, "tree");
  const links = [];
  let removed = false;
  const cleanup = () => {
    if (options.keepWorktree || removed) return;
    removed = removeWorktree(repo, tree, links);
    rmSync(scratch, { recursive: true, force: true });
  };
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let result;
  try {
    result = await runInTree();
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    cleanup();
  }
  return { ...result, worktreeRemoved: options.keepWorktree ? false : removed };

  async function runInTree() {
    // Check out the blobs as committed (LF), as CI does, whatever core.autocrlf says:
    // patch series and checksummed files must keep their bytes.
    git(repo, [...LF_CHECKOUT, "worktree", "add", "--detach", tree, targetCommit]);
    if (options.mode === "parent") git(tree, [...LF_CHECKOUT, "checkout", fixCommit, "--", ...entry.files]);
    const modules = await provideNodeModules({ repo, tree, commit: targetCommit, cacheRoot: options.modulesCache ?? path.join(os.tmpdir(), "shuzhiren-regression-modules"), timeoutMs: options.timeoutMs, notes, install: entry.run.nodeModules === "install" });
    links.push(...modules.links);
    links.push(...linkSubmodules({ repo, tree, commit: targetCommit, notes }));
    const env = { ...process.env, ...(entry.run.env ?? {}), PYTHONDONTWRITEBYTECODE: "1" };
    // Inside another node:test run the child would report to that parent instead of our reporter.
    delete env.NODE_TEST_CONTEXT;
    if (modules.failed) return finish({ command: entry.run.target, nodeModules: modules.mode, ...classifyRun({ prepareFailed: modules.failed }), exitCode: null, durationMs: 0, worktree: tree });
    for (const step of entry.run.prepare ?? []) {
      const npm = step[0] === "npm" ? npmInvocation(step.slice(1)) : { command: step[0] === "node" ? process.execPath : step[0], args: step.slice(1), shell: false };
      const prepared = await runProcess(npm.command, npm.args, { cwd: tree, env, timeoutMs: options.timeoutMs, shell: npm.shell });
      if (prepared.exitCode !== 0) {
        notes.push(`prepare ${step.join(" ")}: ${prepared.stderr.trim().split(/\r?\n/).slice(-5).join(" | ")}`);
        return finish({ command: entry.run.target, nodeModules: modules.mode, ...classifyRun({ prepareFailed: `${step.join(" ")} exited ${prepared.exitCode}` }), exitCode: null, durationMs: prepared.durationMs, worktree: tree });
      }
    }
    const eventsFile = path.join(scratch, "events.jsonl");
    const plan = planRun(entry, { tree, reporterUrl: pathToFileURL(path.join(scriptRoot, "scripts", "lib", "regression-reporter.mjs")).href, eventsFile, python: defaultPython(options) });
    const outcome = await runProcess(plan.command, plan.args, { cwd: tree, env, timeoutMs: options.timeoutMs, shell: plan.shell ?? false, logFile: options.keepWorktree ? path.join(scratch, "output.log") : null });
    const classified = classifyRun({ runner: plan.runner, exitCode: outcome.exitCode, reporterEvents: readEvents(eventsFile), stderr: plan.runner === "node-test" ? outcome.stderr : outcome.stderr, timedOut: outcome.timedOut, unavailable: outcome.spawnError ? `could not start ${plan.display}: ${outcome.spawnError}` : null });
    return finish({ command: plan.display, nodeModules: modules.mode, ...classified, exitCode: outcome.exitCode, durationMs: outcome.durationMs, worktree: tree, outputTail: tail(outcome) });
  }
}

function tail({ stdout, stderr }) {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.slice(-12).map((line) => line.slice(0, 300));
}

function summary(result) {
  const lines = [];
  const ok = result.meetsExpectation ? "符合期望" : "不符合期望";
  lines.push(`${result.issue} ${result.mode} ${result.target}: ${result.outcome}（期望 ${result.expected}，${ok}）`);
  lines.push(`  测试提交 ${result.targetCommit}${result.mode === "parent" ? `（${result.fixCommit.slice(0, 7)} 的父提交，覆盖了登记的 files）` : "（修复提交）"}`);
  lines.push(`  命令 ${result.command}；原因 ${result.reason}`);
  for (const item of result.failing.slice(0, 5)) lines.push(`  失败用例 ${item.name}${item.code ? ` [${item.code}]` : ""}`);
  if (result.assertion) lines.push(`  登记的断言 ${JSON.stringify(result.assertion)}${result.assertionMatched === null ? "" : result.assertionMatched ? " 出现在失败用例中" : " 未出现在失败用例中"}`);
  else if (result.mode === "parent") lines.push("  条目没有登记 assertion：断言失败不能作为该问题的修复前失败证据，先核对失败用例并登记 assertion");
  for (const note of result.notes) lines.push(`  注 ${note}`);
  if (result.meetsExpectation) {
    const key = result.mode === "parent" ? "修复前失败" : "修复后通过";
    lines.push("  可粘贴到 docs/AUDIT_REGISTER.md 的记录：");
    lines.push(`  ${key}: { 命令: "${result.evidenceCommand}", 提交: ${result.targetCommit} }`);
    lines.push(`  # 结果 ${result.outcome}；失败用例 ${result.failing.map((item) => item.name).slice(0, 3).join("；") || "无"}；日期 ${result.date}；运行位置 ${result.runLocation}`);
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\nusage: node scripts/regression-evidence.mjs --issue <ID> --mode parent|fix [--fix <sha>] [--target <file>] [--keep-worktree] [--json]\n`);
    return 2;
  }
  const repo = path.resolve(options.repo ?? scriptRoot);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "regression-registry-"));
  try {
    const registry = await loadRegistry(repo, options.registry, scratch);
    let entries = registry.entries.filter((entry) => entry.issue === options.issue);
    if (options.fix) entries = entries.filter((entry) => entry.fixCommit === options.fix);
    if (options.target) entries = entries.filter((entry) => entry.run?.target === options.target);
    if (entries.length === 0) {
      process.stderr.write(`no REGRESSIONS entry for ${options.issue}${options.fix ? ` at ${options.fix}` : ""}${options.target ? ` with target ${options.target}` : ""} in ${registry.source}\n`);
      return 2;
    }
    const results = [];
    for (let entry of entries) {
      if (!SHA_PATTERN.test(entry.fixCommit ?? "") || !commitExists(repo, entry.fixCommit)) {
        process.stderr.write(`fix commit ${entry.fixCommit} of ${entry.issue} does not exist in ${repo} (a full clone is needed)\n`);
        return 2;
      }
      let registrySource = registry.source;
      const atFix = await registryAtCommit(repo, entry.fixCommit, scratch);
      const fromFix = atFix?.find((candidate) => candidate.issue === entry.issue && candidate.run?.target === entry.run.target);
      if (fromFix) {
        entry = fromFix;
        registrySource = `${entry.fixCommit.slice(0, 12)}:${REGISTRY_PATH}`;
      }
      const result = await evaluateEntry(entry, { repo, options, registrySource });
      results.push(result);
      const { outputTail, ...line } = result;
      process.stdout.write(`${JSON.stringify(line)}\n`);
      if (!options.json) process.stdout.write(`${summary(result)}\n`);
      if (!options.json && result.outcome !== "pass" && outputTail) process.stdout.write(`${outputTail.map((text) => `  | ${text}`).join("\n")}\n`);
      if (options.keepWorktree && result.worktree) process.stdout.write(`kept worktree ${result.worktree}\n`);
    }
    return results.every((result) => result.meetsExpectation) ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    return error instanceof UsageError || error.gitFailure ? 2 : 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
