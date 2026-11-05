// Draft of the `变更` list of a VERIFICATION_LOG `CI 步骤变更` entry
// (design part 1 §1.3.4; Requirement 1.13, 1.14): compares the verification
// steps of a workflow at two git revisions and lists every step that was
// deleted, skipped, relaxed, strengthened, moved or otherwise changed.
//
// Usage: node scripts/diff-ci-steps.mjs <base> <head> [--workflow <path>]
//   <base>, <head>  git revisions (SHA, branch or tag), read with `git show <rev>:<path>`.
//   --workflow      repository path of the workflow, default .github/workflows/ci.yml.
// Prints YAML: `#` comment lines with the resolved commits, counts and job-level
// env differences, then `变更:` with one item per changed step (原命令, 原 job,
// 变更方式, 替代命令, 替代 job, 理由), then the added steps as comments. Exit
// codes: 0 draft printed (also when nothing changed); 2 usage error, git
// failure or YAML parse failure (`ERROR ...`).
//
// Steps follow scripts/lib/workflow-model.mjs: preparation steps (`uses:`, a
// bare `npm ci`, names starting with `prep:`) are ignored. A head step is the
// counterpart of a base step when its command lines are identical (same job
// preferred), otherwise when it runs the same thing: the same npm script,
// Dockerfile and target, compose files, `python -m` module, or otherwise the
// same command line. 变更方式 is derived from the differences:
//   跳过   the head step or its job adds an `if:` condition;
//   放宽   it adds a true continue-on-error, or its run text adds `|| true`-style
//          exit-code suppression;
//   加强   py_compile now compiles a strict superset of the files (globs expanded
//          against each revision's tree), or an `if:`/continue-on-error was removed;
//   待定   any other command or step env change: the maintainer replaces 待定 with
//          one of 删除、跳过、放宽、加强、移动 and writes the 理由;
//   移动   identical command, step env and conditions in another job;
//   删除   no counterpart in head.
// 理由 holds the detected differences as a starting point; it is a draft.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { commands, jobs, parseWorkflow, steps, tokenize, UnparsableCommand, WorkflowLoadError } from "./lib/workflow-model.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WORKFLOW = ".github/workflows/ci.yml";
const PYTHON = new Set(["python3", "python"]);
const FALSE_SPELLINGS = new Set(["false", "False", "FALSE"]);
const IGNORED_EXIT_CODE = Object.freeze([/\|\|\s*(true|:|exit 0|echo)/, /;\s*true\s*$/m, /\bset\s+\+e\b/]);
const DOCKER_BUILD_VALUE_OPTIONS = new Set(["--file", "-f", "--target", "--build-arg", "--tag", "-t", "--platform", "--label", "--cache-from", "--cache-to", "--secret", "--ssh", "--network", "--progress", "--output", "-o", "--build-context", "--iidfile", "--metadata-file", "--attest", "--add-host", "--shm-size", "--ulimit", "--allow"]);
const COMPOSE_VALUE_OPTIONS = new Set(["--env-file", "-f", "--file", "--profile", "-p", "--project-name", "--project-directory"]);

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isTrue = (value) => value !== undefined && !(typeof value === "string" && FALSE_SPELLINGS.has(value));
const sameList = (left, right) => left.length === right.length && left.every((item, index) => item === right[index]);
const quote = (value) => JSON.stringify(value);

function safeTokenize(line) {
  try {
    return tokenize(line);
  } catch (error) {
    if (error instanceof UnparsableCommand) return null;
    throw error;
  }
}

function optionValue(tokens, index, names) {
  const token = tokens[index];
  const equals = token.indexOf("=");
  const name = token.startsWith("--") && equals > 0 ? token.slice(0, equals) : token;
  if (!names.has(name)) return null;
  return name === token ? { name, value: tokens[index + 1], width: 2 } : { name, value: token.slice(equals + 1), width: 1 };
}

/** What a command line runs, used to pair a changed base step with its head step. */
export function commandIdentity(line) {
  const tokens = safeTokenize(line);
  if (!tokens || tokens.length === 0) return line;
  if (tokens[0] === "npm" && (tokens[1] === "run" || tokens[1] === "run-script") && tokens[2]) return `npm run ${tokens[2]}`;
  const dockerBuild = tokens[0] === "docker" && tokens[1] === "build" ? 2 : tokens[0] === "docker" && tokens[1] === "buildx" && tokens[2] === "build" ? 3 : -1;
  if (dockerBuild > 0) {
    let file;
    let target;
    const positionals = [];
    for (let i = dockerBuild; i < tokens.length; i += 1) {
      if (["&&", "||", ";", "|"].includes(tokens[i])) break;
      if (!tokens[i].startsWith("-") || tokens[i] === "-") {
        positionals.push(tokens[i]);
        continue;
      }
      const option = optionValue(tokens, i, DOCKER_BUILD_VALUE_OPTIONS);
      if (!option) continue;
      if (option.name === "--file" || option.name === "-f") file = option.value;
      if (option.name === "--target") target = option.value;
      i += option.width - 1;
    }
    file ??= positionals.length > 0 ? path.posix.join(positionals.at(-1), "Dockerfile") : "Dockerfile";
    return `docker build ${path.posix.normalize(file)}${target ? ` --target ${target}` : ""}`;
  }
  if (tokens[0] === "docker" && tokens[1] === "compose") {
    const files = [];
    let subcommand = "";
    for (let i = 2; i < tokens.length; i += 1) {
      if (!tokens[i].startsWith("-")) {
        subcommand = tokens[i];
        break;
      }
      const option = optionValue(tokens, i, COMPOSE_VALUE_OPTIONS);
      if (!option) continue;
      if (option.name === "-f" || option.name === "--file") files.push(option.value);
      i += option.width - 1;
    }
    return `docker compose ${files.join(" ")} ${subcommand}`.trim();
  }
  if (PYTHON.has(tokens[0]) && tokens[1] === "-m" && tokens[2]) return `python -m ${tokens[2]}`;
  return [PYTHON.has(tokens[0]) ? "python" : tokens[0], ...tokens.slice(1)].join(" ");
}

/** Verification steps of a parsed workflow with what the comparison needs. */
export function verificationSteps(workflow) {
  return jobs(workflow).flatMap((job) => {
    const definition = isMapping(job.definition) ? job.definition : {};
    return steps(job)
      .filter((step) => !step.isPreparation)
      .map((step) => {
        const lines = commands(step);
        return {
          job: job.id,
          index: step.index,
          lines,
          command: lines.join("\n"),
          identity: lines.map(commandIdentity).join(" ; "),
          run: step.run ?? "",
          env: step.env ?? {},
          conditions: [definition.if, step.raw.if].filter((value) => value !== undefined).map(String),
          continueOnError: isTrue(definition["continue-on-error"]) || isTrue(step.raw["continue-on-error"])
        };
      })
      .filter((step) => step.lines.length > 0);
  });
}

function jobEnv(workflow, jobId) {
  const definition = jobs(workflow).find((job) => job.id === jobId)?.definition;
  return { ...(isMapping(workflow.doc?.env) ? workflow.doc.env : {}), ...(isMapping(definition?.env) ? definition.env : {}) };
}

function envDifferences(before, after, scope) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((key) => {
    if (!(key in after)) return [`${scope} env ${key} 不再设置（原值 ${quote(before[key])}）`];
    if (!(key in before)) return [`${scope} env ${key} 新增 ${quote(after[key])}`];
    return before[key] === after[key] ? [] : [`${scope} env ${key}: ${quote(before[key])} → ${quote(after[key])}`];
  });
}

function globPattern(segment) {
  return new RegExp(`^${segment.split("*").map((part) => part.replace(/[.+?^$()|[\]{}\\]/g, "\\$&")).join("[^/]*")}$`);
}

/** Expands `*` in a repository path against a revision's file list, as bash would. */
function expandAgainst(files, argument) {
  const normalized = argument.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (!normalized.includes("*")) return [normalized];
  const segments = normalized.split("/").map((segment) => (segment.includes("*") ? globPattern(segment) : segment));
  return files.filter((file) => {
    const parts = file.split("/");
    return parts.length === segments.length && segments.every((segment, i) => (typeof segment === "string" ? parts[i] === segment : segment.test(parts[i]) && !parts[i].startsWith(".")));
  });
}

function pyCompileFiles(step, files) {
  const compiled = new Set();
  let found = false;
  for (const line of step.lines) {
    const tokens = safeTokenize(line);
    if (!tokens || !PYTHON.has(tokens[0]) || tokens[1] !== "-m" || tokens[2] !== "py_compile") continue;
    found = true;
    for (const argument of tokens.slice(3)) for (const file of expandAgainst(files, argument)) compiled.add(file);
  }
  return found ? compiled : null;
}

function classify(base, head, context) {
  const differences = [];
  const commandChanged = !sameList(base.lines, head.lines);
  if (commandChanged) differences.push("命令改变");
  const envNotes = envDifferences(base.env, head.env, "step");
  differences.push(...envNotes);
  const addedConditions = head.conditions.filter((condition) => !base.conditions.includes(condition));
  const removedConditions = base.conditions.filter((condition) => !head.conditions.includes(condition));
  for (const condition of addedConditions) differences.push(`新增 if: ${condition}`);
  for (const condition of removedConditions) differences.push(`去掉 if: ${condition}`);
  if (head.continueOnError && !base.continueOnError) differences.push("新增 continue-on-error");
  if (base.continueOnError && !head.continueOnError) differences.push("去掉 continue-on-error");
  const suppressed = IGNORED_EXIT_CODE.filter((pattern) => pattern.test(head.run) && !pattern.test(base.run));
  if (suppressed.length > 0) differences.push("run 文本新增忽略退出码的写法");

  let superset = null;
  if (commandChanged) {
    const before = pyCompileFiles(base, context.baseFiles);
    const after = pyCompileFiles(head, context.headFiles);
    if (before && after && [...before].every((file) => after.has(file)) && after.size > before.size) superset = { before: [...before].sort(), after: [...after].sort() };
  }
  const moved = base.job !== head.job;
  const where = moved ? `job ${base.job} → ${head.job}` : `job ${base.job} 不变`;
  if (addedConditions.length > 0) return { kind: "跳过", reason: `待填写；${where}；${differences.join("；")}` };
  if ((head.continueOnError && !base.continueOnError) || suppressed.length > 0) return { kind: "放宽", reason: `待填写；${where}；${differences.join("；")}` };
  const otherChange = (commandChanged && !superset) || envNotes.length > 0;
  if (otherChange) return { kind: "待定", reason: `待填写；${where}；${differences.join("；")}` };
  if (superset || removedConditions.length > 0 || (base.continueOnError && !head.continueOnError)) {
    const detail = superset ? `py_compile 编译的文件集合是原集合的超集：原 ${superset.before.join(", ")}；现 ${superset.after.join(", ")}` : differences.join("；");
    return { kind: "加强", reason: `${detail}；${where}` };
  }
  if (moved) return { kind: "移动", reason: `命令与参数不变，只把步骤从 job ${base.job} 移到 ${head.job}（Requirement 1.13 不视为删除）` };
  return null;
}

/**
 * Compares the verification steps of two parsed workflows.
 * @param {{ baseFiles?: string[], headFiles?: string[] }} context file lists of
 *   each revision, used to expand py_compile globs.
 * @returns {{ changes: object[], added: object[], unchanged: number, jobEnvNotes: string[] }}
 */
export function diffWorkflowSteps(baseWorkflow, headWorkflow, { baseFiles = [], headFiles = [] } = {}) {
  const baseSteps = verificationSteps(baseWorkflow);
  const headSteps = verificationSteps(headWorkflow);
  const consumed = new Set();
  const pairs = new Map();
  const pick = (base, matches) => {
    const candidates = headSteps.filter((head) => !consumed.has(head) && matches(head));
    const chosen = candidates.find((head) => head.job === base.job) ?? candidates[0];
    if (chosen) {
      consumed.add(chosen);
      pairs.set(base, chosen);
    }
  };
  for (const base of baseSteps) pick(base, (head) => sameList(head.lines, base.lines));
  for (const base of baseSteps) if (!pairs.has(base)) pick(base, (head) => head.identity === base.identity);

  const context = { baseFiles, headFiles };
  const changes = [];
  let unchanged = 0;
  const jobPairs = new Map();
  for (const base of baseSteps) {
    const head = pairs.get(base);
    if (!head) {
      changes.push({ 原命令: base.command, "原 job": base.job, 变更方式: "删除", 替代命令: "无", "替代 job": "无", 理由: "待填写；新版本中没有执行该命令的验证步骤" });
      continue;
    }
    jobPairs.set(`${base.job}\u0000${head.job}`, [base.job, head.job]);
    const verdict = classify(base, head, context);
    if (!verdict) {
      unchanged += 1;
      continue;
    }
    changes.push({ 原命令: base.command, "原 job": base.job, 变更方式: verdict.kind, 替代命令: head.command, "替代 job": head.job, 理由: verdict.reason });
  }
  const jobEnvNotes = [...jobPairs.values()].flatMap(([from, to]) =>
    envDifferences(jobEnv(baseWorkflow, from), jobEnv(headWorkflow, to), "job").map((note) => `${from} → ${to}：${note}`)
  );
  const added = headSteps.filter((head) => !consumed.has(head)).map((head) => ({ job: head.job, index: head.index, command: head.command }));
  return { changes, added, unchanged, jobEnvNotes };
}

/** YAML draft: header comments, the `变更` list, then the added steps as comments. */
export function renderDraft(result, { base, head, workflow = DEFAULT_WORKFLOW } = {}) {
  const count = (kind) => result.changes.filter((change) => change.变更方式 === kind).length;
  const header = [
    `# ci:steps:diff ${base?.rev ?? "<base>"} ${head?.rev ?? "<head>"}（${workflow}）`,
    `# base ${base?.sha ?? "?"} → head ${head?.sha ?? "?"}`,
    "# 草稿：变更方式为\"待定\"的条目须改为 删除、跳过、放宽、加强、移动 之一；\"待填写\"的理由须由维护者写明。",
    `# 统计：未变 ${result.unchanged}，移动 ${count("移动")}，加强 ${count("加强")}，待定 ${count("待定")}，放宽 ${count("放宽")}，跳过 ${count("跳过")}，删除 ${count("删除")}，新增 ${result.added.length}`,
    ...result.jobEnvNotes.map((note) => `# job 级 env 差异（${note}）`)
  ];
  const body = yaml.dump({ 变更: result.changes }, { lineWidth: -1, noRefs: true, quotingType: "\"" });
  const footer = result.added.length === 0 ? [] : ["# 新增验证步骤（不属于 Requirement 1.14 的记录范围，仅供核对）：", ...result.added.map((step) => `#   ${step.job}/${step.index}: ${step.command.replace(/\n/g, " ; ")}`)];
  return `${[...header, body.trimEnd(), ...footer].join("\n")}\n`;
}

function fail(message) {
  console.error(`ERROR ${message}`);
  process.exit(2);
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) fail(`git ${args.join(" ")} failed (${result.error.code ?? result.error.message})`);
  if (result.status !== 0) fail(`git ${args.join(" ")} exited ${result.status}: ${(result.stderr ?? "").trim().replace(/\s+/g, " ")}`);
  return result.stdout;
}

function parseArguments(argv) {
  const revisions = [];
  let workflow = DEFAULT_WORKFLOW;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--workflow") {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith("-")) fail("usage: --workflow requires a repository path");
      workflow = argv[i + 1].replace(/\\/g, "/");
      i += 1;
    } else if (argv[i].startsWith("-")) {
      fail(`usage: unknown option ${argv[i]}; expected <base> <head> [--workflow <path>]`);
    } else {
      revisions.push(argv[i]);
    }
  }
  if (revisions.length !== 2) fail("usage: node scripts/diff-ci-steps.mjs <base> <head> [--workflow <path>]");
  for (const revision of revisions) if (!/^[^\s:-][^\s:]*$/.test(revision)) fail(`usage: invalid revision ${JSON.stringify(revision)}`);
  return { revisions, workflow };
}

function loadRevision(revision, workflow) {
  const sha = git(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]).trim();
  let parsed;
  try {
    parsed = parseWorkflow(git(["show", `${sha}:${workflow}`]), `${revision}:${workflow}`);
  } catch (error) {
    if (!(error instanceof WorkflowLoadError)) throw error;
    fail(error.message);
  }
  const files = git(["ls-tree", "-r", "--name-only", sha]).split("\n").filter(Boolean);
  return { rev: revision, sha, workflow: parsed, files };
}

function main(argv) {
  const { revisions, workflow } = parseArguments(argv);
  const [base, head] = revisions.map((revision) => loadRevision(revision, workflow));
  const result = diffWorkflowSteps(base.workflow, head.workflow, { baseFiles: base.files, headFiles: head.files });
  process.stdout.write(renderDraft(result, { base, head, workflow }));
  return 0;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = path.resolve(process.argv[1]);
  return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry;
}

if (isMainModule()) process.exitCode = main(process.argv.slice(2));
