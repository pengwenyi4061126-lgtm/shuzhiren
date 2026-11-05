// Behavioral tests of the documentation governance gate: the VERIFICATION_LOG
// rules of scripts/lib/verification-log.mjs, the Audit_Register rules of
// scripts/lib/audit-register.mjs, the Readiness_Matrix rules of
// scripts/lib/readiness-matrix.mjs, the Handoff_Doc rules of
// scripts/lib/handoff-docs.mjs and the scripts/check-governance-docs.mjs CLI
// (design part 1 §4.5, §5.5, §6.5, §7.5; part 8 Requirement 40 §6.4;
// Requirement 1.12, 1.14, 1.15, 4.1-4.8, 5.1-5.8, 6.1-6.8, 7.1-7.15, 32.10,
// 32.11, 36.13, 36.14, 40.1-40.7). Labels are resolved against the real
// LOCAL_CHECKS, CI_ONLY_STEPS and package.json; workflows are inline. Samples
// live in scripts/fixtures/governance-docs/{vlog,audit,matrix,handoff,d1}/;
// secret-like strings are assembled at run time so that no fixture contains one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parseWorkflow } from "./lib/workflow-model.mjs";
import { buildEvidence, renderEvidence } from "./collect-ci-run-evidence.mjs";
import {
  classifyConclusion,
  coverageCommits,
  createCheckResolver,
  ENTRY_TYPES,
  loadStaticGateCoverage,
  NOT_TRANSCRIBED,
  parseVerificationLog,
  SECRET_PATTERNS,
  scanSecrets,
  validateCommitMessage,
  validateEntry,
  validateVerificationLog
} from "./lib/verification-log.mjs";
import {
  AUDIT_REPORT,
  countByStatus,
  deriveStatus,
  initialStatus,
  isCompleteFix,
  REPORT_ISSUE_IDS,
  REPORT_LOW_ITEMS,
  REPORT_SERIES,
  REPORT_SOURCE_MARKS,
  REQUIREMENT_PRIORITIES,
  SOURCE_MARKS,
  STATUSES,
  validateAuditRegister,
  VERIFY_CONCLUSIONS
} from "./lib/audit-register.mjs";
import fc from "fast-check";
import {
  D1_ROWS,
  d1Decision,
  MATRIX_STATUSES,
  parseReadinessMatrix,
  REQUIRED_ENVIRONMENT_ROWS,
  REQUIRED_EXTERNAL_ROWS,
  rowCriterion,
  RW_STATUSES,
  splitTableRow,
  validateReadinessMatrix
} from "./lib/readiness-matrix.mjs";
import { findClaimViolations, HANDOFF_FILES, isCiClaim, runReferenceProblem, splitUnits, SYNC_STATE, validateHandoffDocs } from "./lib/handoff-docs.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");
const fixture = (name) => path.join(scriptsDir, "fixtures", "governance-docs", "vlog", name);
const auditFixture = (name) => path.join(scriptsDir, "fixtures", "governance-docs", "audit", name);
const scripts = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).scripts;
const resolver = createCheckResolver({ scripts, root: repoRoot });
const emptyCoverage = () => ({ status: "ok", mapping: {} });
const options = { resolver, coverageFor: emptyCoverage };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const CI_RUN_EVIDENCE = path.join(scriptsDir, "fixtures", "ci-run-evidence");

const temporaryDirectories = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});
function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const localSource = (overrides = {}) => ({
  类别: "本机运行",
  命令: "npm run ci:workflow:check",
  日期: "2026-11-06",
  退出码: "0",
  操作系统: "Windows 11 专业版 10.0.22631.7376",
  提交: SHA,
  检查: [{ 名称: "ci:workflow:check", 标签: "static" }],
  "未执行的 CI 检查": [{ job: "postgres-integration", 名称: "npm run db:migrate", 原因: "本机缺少 PostgreSQL" }],
  ...overrides
});
const linuxSource = (overrides = {}) => ({
  类别: "CI 或 Linux 运行",
  平台: "Linux",
  命令: "npm run ci:gates:test",
  日期: "2026-11-06",
  退出码: "0",
  操作系统: "Ubuntu 24.04.3 LTS",
  提交: SHA,
  检查: [{ 名称: "ci:gates:test", 标签: "behavioral" }],
  ...overrides
});
const step = (overrides = {}) => ({ job: "static-gates", 步骤: "Run npm run lint", 结论: "success", 标签: "static", ...overrides });
const githubSource = (overrides = {}) => ({
  类别: "CI 或 Linux 运行",
  平台: "GitHub Actions",
  "run id": "41900000000",
  提交: SHA,
  运行结论: "success",
  "runner 镜像": [{ job: "static-gates", 镜像: "ubuntu-24.04", 版本: "20261020.1.0" }],
  步骤: [step()],
  ...overrides
});
const externalSource = (overrides = {}) => ({
  类别: "需外部环境",
  环境: "4090 GPU 主机（Readiness_Matrix EP-01）",
  命令或验收步骤: "npm run runtime:acceptance:verify -- --evidence /srv/shuzhiren/evidence/runtime-acceptance.json",
  ...overrides
});
const entry = (overrides = {}) => ({
  编号: "V-20261106-01",
  类型: "结论",
  结论: "样例结论",
  判定: "静态检查",
  依据来源: [localSource()],
  静态门禁覆盖: [{ 门禁: "ci:workflow:check", 行为测试: ["无"] }],
  ...overrides
});
const typedEntries = {
  结论: () => entry(),
  "CI 根因": () => entry({
    类型: "CI 根因",
    根因: "env_file 相对路径按 infra/compose/ 解析",
    确认方式: "CI 日志摘录",
    日志或命令输出: "env file infra/compose/config/control-plane.example.env not found\n",
    修复提交: SHA,
    候选根因: "证实"
  }),
  "CI 步骤变更": () => entry({
    类型: "CI 步骤变更",
    基线提交: SHA,
    变更提交: SHA,
    变更: [{ 原命令: "npm run a:check", "原 job": "console", 变更方式: "移动", 替代命令: "npm run a:check", "替代 job": "static-gates", 理由: "命令与参数不变" }]
  }),
  "首次绿色 CI": () => entry({ 类型: "首次绿色 CI", "run id": "41900000000", 提交: SHA, "skipped 步骤数": "0", 依据来源: [githubSource({ "skipped 步骤数": "0" })], 静态门禁覆盖: undefined })
};
const problemsOf = (data, extra = {}) => validateEntry(data, { ...options, ...extra }).problems;
const describe = (problems) => problems.map((problem) => `${problem.code} ${problem.field}: ${problem.message}`).join("\n");
const classify = (sources) => classifyConclusion({ 依据来源: sources }, { resolver });

/** A log document with one heading and yaml block per entry. */
function renderLog(entries) {
  return ["# 样例", "", ...entries.flatMap((data) => [`## ${data.编号} 样例`, "", "```yaml", yaml.dump(data, { lineWidth: -1 }).trimEnd(), "```", ""])].join("\n");
}

function runGate(args, { input } = {}) {
  const result = spawnSync(process.execPath, [path.join(scriptsDir, "check-governance-docs.mjs"), ...args], { cwd: repoRoot, encoding: "utf8", input });
  if (result.error) throw result.error;
  return result;
}

test("the base samples of every source category and entry type validate without problems", () => {
  for (const [type, build] of Object.entries(typedEntries)) assert.equal(describe(problemsOf(build())), "", type);
  assert.equal(describe(problemsOf(entry({ 判定: "行为验证", 依据来源: [linuxSource()], 静态门禁覆盖: undefined }))), "");
  assert.equal(describe(problemsOf(entry({ 依据来源: [githubSource()], 静态门禁覆盖: undefined }))), "");
  assert.equal(describe(problemsOf(entry({ 判定: "未验证", 依据来源: [externalSource()], 静态门禁覆盖: undefined }))), "");
  assert.deepEqual(Object.keys(ENTRY_TYPES), ["结论", "CI 根因", "CI 步骤变更", "首次绿色 CI"]);
});

test("every required field of the entry schema and of Requirement 4.2, 4.3 and 4.4 is reported when missing", () => {
  const remove = (build, keys) => {
    const data = structuredClone(build());
    let target = data;
    for (const key of keys.slice(0, -1)) target = target[key];
    delete target[keys.at(-1)];
    return data;
  };
  const withSource = (source, extra = {}) => () => entry({ 依据来源: [source], 静态门禁覆盖: undefined, ...extra });
  const cases = [
    ...["编号", "类型", "结论", "判定", "依据来源"].map((field) => [field, entry, [field]]),
    ...["命令", "日期", "退出码", "操作系统", "提交", "检查", "未执行的 CI 检查"].map((field) => [`依据来源[0].${field}`, entry, ["依据来源", 0, field]]),
    ["依据来源[0].检查[0].名称", entry, ["依据来源", 0, "检查", 0, "名称"]],
    ["依据来源[0].检查[0].标签", entry, ["依据来源", 0, "检查", 0, "标签"]],
    ["依据来源[0].未执行的 CI 检查[0].名称", entry, ["依据来源", 0, "未执行的 CI 检查", 0, "名称"]],
    ["依据来源[0].未执行的 CI 检查[0].原因", entry, ["依据来源", 0, "未执行的 CI 检查", 0, "原因"]],
    ["依据来源[0].类别", entry, ["依据来源", 0, "类别"]],
    ...["平台", "命令", "日期", "退出码", "操作系统", "提交", "检查"].map((field) => [`依据来源[0].${field}`, withSource(linuxSource(), { 判定: "行为验证" }), ["依据来源", 0, field]]),
    ...["run id", "提交", "运行结论", "runner 镜像", "步骤"].map((field) => [`依据来源[0].${field}`, withSource(githubSource()), ["依据来源", 0, field]]),
    ...["job", "步骤", "结论"].map((field) => [`依据来源[0].步骤[0].${field}`, withSource(githubSource()), ["依据来源", 0, "步骤", 0, field]]),
    ...["job", "镜像", "版本"].map((field) => [`依据来源[0].runner 镜像[0].${field}`, withSource(githubSource()), ["依据来源", 0, "runner 镜像", 0, field]]),
    ...["环境", "命令或验收步骤"].map((field) => [`依据来源[0].${field}`, withSource(externalSource(), { 判定: "未验证" }), ["依据来源", 0, field]]),
    ...Object.entries(ENTRY_TYPES).flatMap(([type, spec]) => spec.requiredFields.map((field) => [field, typedEntries[type], [field]]))
  ];
  for (const [field, build, keys] of cases) {
    const problems = problemsOf(remove(build, keys));
    assert.ok(problems.some((problem) => problem.field === field && /缺少字段/.test(problem.message)), `${field} (${keys.join(".")}):\n${describe(problems)}`);
  }
});

test("the five failure forms of Requirement 4.6 make the conclusion 未验证", () => {
  const passing = localSource({ 命令: "npm run ci:gates:test", 检查: [{ 名称: "ci:gates:test", 标签: "behavioral" }] });
  assert.equal(classify([passing]), "行为验证");
  const failures = {
    "运行结论 failure": githubSource({ 运行结论: "failure" }),
    "步骤 skipped": githubSource({ 步骤: [step(), step({ 步骤: "Run npm run build", 结论: "skipped" })] }),
    "步骤 cancelled": githubSource({ 步骤: [step({ 结论: "cancelled" })] }),
    "步骤 failure": githubSource({ 步骤: [step({ 结论: "failure" })] }),
    "退出码 1": localSource({ 退出码: "1" })
  };
  for (const [name, source] of Object.entries(failures)) {
    assert.equal(classify([source]), "未验证", name);
    assert.equal(classify([passing, source]), "未验证", `${name} next to a passing behavioral source`);
  }
});

test("Requirement 4.7: only external sources, or no runnable source with complete fields, give 未验证", () => {
  assert.equal(classify([externalSource()]), "未验证");
  assert.equal(classify([externalSource(), externalSource({ 环境: "平台账号" })]), "未验证");
  const incomplete = {
    "runner image 待抄录": githubSource({ "runner 镜像": [{ job: "static-gates", 镜像: NOT_TRANSCRIBED, 版本: NOT_TRANSCRIBED }] }),
    "missing date": localSource({ 日期: undefined }),
    "short SHA below 7 digits": localSource({ 提交: "abc123" }),
    "only unlabeled preparation steps": githubSource({ 步骤: [step({ 步骤: "Set up job", 标签: undefined })] }),
    "only the unregistered own command": localSource({ 命令: "pwsh -NoProfile -Command Get-FileHash x", 检查: [{ 名称: "pwsh -NoProfile -Command Get-FileHash x", 标签: "static" }] })
  };
  for (const [name, source] of Object.entries(incomplete)) assert.equal(classify([source]), "未验证", name);
  const withRegistered = localSource({ 检查: [{ 名称: "npm run ci:workflow:check", 标签: "static" }, { 名称: "npm run ci:workflow:check", 标签: "static" }] });
  assert.equal(classify([withRegistered]), "静态检查");
});

test("Requirement 4.8: only static labels give 静态检查, one behavioral label gives 行为验证", () => {
  assert.equal(classify([localSource(), githubSource()]), "静态检查");
  assert.equal(classify([localSource(), githubSource(), externalSource()]), "静态检查");
  assert.equal(classify([localSource({ 检查: [{ 名称: "ci:workflow:check", 标签: "static" }, { 名称: "ci:gates:test", 标签: "behavioral" }] })]), "行为验证");
  assert.equal(classify([githubSource({ 步骤: [step(), step({ job: "node-unit", 步骤: "Run npm run ci:gates:test", 标签: "behavioral" })], "runner 镜像": [{ job: "static-gates", 镜像: "ubuntu-24.04", 版本: "1" }, { job: "node-unit", 镜像: "ubuntu-24.04", 版本: "1" }] })]), "行为验证");
  assert.equal(classifyConclusion({ 依据来源: [localSource({ 检查: [{ 名称: "anything", 标签: "behavioral" }] })] }), "行为验证", "without a resolver labels are taken at face value");
});

test("a 判定 that differs from the recomputed verdict is an error", () => {
  const problems = problemsOf(entry({ 判定: "行为验证" }));
  assert.deepEqual(problems.map((problem) => problem.field), ["判定"]);
  assert.match(problems[0].message, /应为 静态检查/);
  assert.equal(problemsOf(entry({ 判定: "已验证" }))[0].field, "判定");
});

test("check and step labels must match LOCAL_CHECKS or CI_ONLY_STEPS (VLOG-LABEL-UNKNOWN, Requirement 36.13)", () => {
  const codes = (data) => problemsOf(data).map((problem) => `${problem.code} ${problem.field}`);
  assert.deepEqual(codes(entry({ 依据来源: [localSource({ 检查: [{ 名称: "npm run not-a-check", 标签: "static" }] })], 判定: "未验证", 静态门禁覆盖: undefined })), ["VLOG-LABEL-UNKNOWN 依据来源[0].检查[0].名称"]);
  assert.deepEqual(codes(entry({ 依据来源: [localSource({ 检查: [{ 名称: "ci:gates:test", 标签: "static" }] })], 判定: "未验证", 静态门禁覆盖: undefined })), ["VLOG 依据来源[0].检查[0].标签"]);
  const ownCommand = "pwsh -NoProfile -Command Get-FileHash x";
  assert.deepEqual(codes(entry({ 依据来源: [localSource({ 命令: ownCommand, 检查: [{ 名称: ownCommand, 标签: "static" }] })], 判定: "未验证", 静态门禁覆盖: undefined })), []);
  assert.deepEqual(codes(entry({ 依据来源: [localSource({ 命令: ownCommand, 检查: [{ 名称: ownCommand, 标签: "behavioral" }] })], 判定: "未验证", 静态门禁覆盖: undefined })), ["VLOG-LABEL-UNKNOWN 依据来源[0].检查[0].名称"]);
  assert.deepEqual(codes(entry({ 依据来源: [localSource({ 检查: [{ 名称: "npm run db:migrate", 标签: "behavioral" }, { 名称: "bash -n scripts/backup-postgres.sh", 标签: "static" }] })], 判定: "行为验证", 静态门禁覆盖: undefined })), []);

  const ciSteps = (stepList) => entry({ 依据来源: [githubSource({ 步骤: stepList })], 静态门禁覆盖: undefined });
  assert.deepEqual(codes(ciSteps([step(), step({ 步骤: "Run ./custom-tool --verify", 标签: "static" })])), ["VLOG-LABEL-UNKNOWN 依据来源[0].步骤[1].步骤"]);
  assert.deepEqual(codes(ciSteps([step(), step({ 步骤: "Run npm run typecheck", 标签: undefined })])), ["VLOG 依据来源[0].步骤[1].标签"]);
  assert.deepEqual(codes(ciSteps([step({ 步骤: "Set up job", 标签: undefined }), step(), step({ 步骤: "Post Run actions/checkout@v4", 标签: undefined })])), []);

  const workflow = parseWorkflow(`jobs:
  docker-build:
    steps:
      - name: docker build runtime/cosyvoice (committed Miniforge pin)
        run: |
          url="$(jq -er '.url' runtime/cosyvoice/miniforge.json)"
          sha="$(jq -er '.sha256' runtime/cosyvoice/miniforge.json)"
          docker build --file runtime/cosyvoice/Dockerfile --build-arg MINIFORGE_URL="$url" --build-arg MINIFORGE_SHA256="$sha" --tag shuzhiren-cosyvoice-ci .
      - name: "prep: reclaim disk before CosyVoice build"
        run: docker image rm shuzhiren/livetalking:ci
`);
  const named = createCheckResolver({ scripts, root: repoRoot, workflow });
  assert.deepEqual(named.resolveStep("docker-build", "docker build runtime/cosyvoice (committed Miniforge pin)"), { name: "docker build --file runtime/cosyvoice/Dockerfile --build-arg MINIFORGE_URL=\"$url\" --build-arg MINIFORGE_SHA256=\"$sha\" --tag shuzhiren-cosyvoice-ci .", label: "static", gate: null });
  assert.equal(named.resolveStep("docker-build", "prep: reclaim disk before CosyVoice build"), null);
  assert.equal(named.resolveStep("node-unit", "docker build runtime/cosyvoice (committed Miniforge pin)"), null);
  assert.deepEqual(resolver.resolveStep("python-gateway", "Run python3 scripts/test-runtime-gateway-audio.py"), { name: "scripts/test-runtime-gateway-audio.py", label: "behavioral", gate: null });
  assert.equal(resolver.resolveName("npm run deploy:check -- --allow-placeholders").gate, "deploy:check");
  assert.equal(resolver.resolveName("policy:red-team").gate, null, "behavioral checks are not Static_Gates");
  assert.equal(resolver.resolveName("lint").gate, null, "lint does not run scripts/check-*.mjs");
});

test("静态门禁覆盖 lists every Static_Gate of the evidence with the mapping of the entry's commit (Requirement 36.14)", () => {
  const fieldsOf = (data, coverageFor = emptyCoverage) => problemsOf(data, { coverageFor }).map((problem) => problem.field);
  assert.deepEqual(fieldsOf(entry({ 静态门禁覆盖: undefined })), ["静态门禁覆盖"]);
  assert.deepEqual(fieldsOf(entry({ 静态门禁覆盖: [{ 门禁: "lint", 行为测试: ["无"] }] })), ["静态门禁覆盖[0].门禁", "静态门禁覆盖"]);
  assert.deepEqual(fieldsOf(entry({ 静态门禁覆盖: [{ 门禁: "ci:workflow:check", 行为测试: ["无", "ci:gates:test"] }] })), ["静态门禁覆盖[0].行为测试", "静态门禁覆盖"]);
  assert.deepEqual(fieldsOf(entry({ 静态门禁覆盖: [{ 门禁: "ci:workflow:check" }] })), ["静态门禁覆盖[0].行为测试", "静态门禁覆盖"]);
  const mapped = (commit) => ({ status: "ok", mapping: commit === SHA ? { "ci:workflow:check": [{ test: "ci:gates:test", case: "W1-W12 samples" }] } : {} });
  assert.deepEqual(fieldsOf(entry(), mapped), ["静态门禁覆盖"]);
  assert.match(problemsOf(entry(), { coverageFor: mapped })[0].message, /应为 ci:gates:test，此处为 \[无\]/);
  assert.deepEqual(fieldsOf(entry({ 静态门禁覆盖: [{ 门禁: "ci:workflow:check", 行为测试: ["ci:gates:test"] }] }), mapped), []);
  const unavailable = validateEntry(entry(), { resolver, coverageFor: () => ({ status: "unavailable", reason: "shallow clone" }) });
  assert.deepEqual(unavailable.problems, []);
  assert.equal(unavailable.notes[0].code, "VLOG-COVERAGE");
  assert.deepEqual(fieldsOf(entry(), () => ({ status: "error", reason: "cannot evaluate" })), ["静态门禁覆盖"]);
});

test("type-specific fields of CI 根因, CI 步骤变更 and 首次绿色 CI are checked", () => {
  const fieldsOf = (data) => problemsOf(data).map((problem) => problem.field);
  const rootCause = typedEntries["CI 根因"];
  assert.deepEqual(fieldsOf({ ...rootCause(), 确认方式: "Linux 复现" }), ["复现命令"]);
  assert.deepEqual(fieldsOf({ ...rootCause(), 确认方式: "Linux 复现", 复现命令: "docker compose … config" }), []);
  assert.deepEqual(fieldsOf({ ...rootCause(), 修复提交: SHA.slice(0, 7), 候选根因: "部分" }), ["修复提交", "候选根因"]);
  const stepChange = typedEntries["CI 步骤变更"];
  const change = (overrides) => ({ ...stepChange(), 变更: [{ ...stepChange().变更[0], ...overrides }] });
  assert.deepEqual(fieldsOf(change({ 变更方式: "待定" })), ["变更[0].变更方式"]);
  assert.deepEqual(fieldsOf(change({ 变更方式: "等价改写" })), ["变更[0].变更方式"]);
  assert.deepEqual(fieldsOf(change({ 理由: "待填写；job console → static-gates" })), ["变更[0].理由"]);
  assert.deepEqual(fieldsOf(change({ 替代命令: undefined })), ["变更[0].替代命令"]);
  assert.deepEqual(fieldsOf({ ...stepChange(), 基线提交: "dc2916e" }), ["基线提交"]);
  const green = typedEntries["首次绿色 CI"];
  assert.deepEqual(fieldsOf({ ...green(), "skipped 步骤数": "3" }), ["skipped 步骤数", "依据来源"]);
  assert.deepEqual(fieldsOf({ ...green(), "run id": "41900000099" }), ["依据来源"]);
  assert.deepEqual(fieldsOf({ ...green(), 依据来源: [githubSource({ 运行结论: "failure" })], 判定: "未验证" }), ["依据来源"]);
});

test("the ci:evidence:collect output for #491 is accepted once its verification steps carry labels", () => {
  const jobs = JSON.parse(readFileSync(path.join(CI_RUN_EVIDENCE, "run-41869137741-jobs.json"), "utf8")).jobs;
  const run = { id: 41869137741, run_number: 491, status: "completed", conclusion: "failure", head_sha: "dc2916eef45f2aebacde24598723468f23ee61a6" };
  const fragment = yaml.load(renderEvidence(buildEvidence({ run, jobs })), { schema: yaml.FAILSAFE_SCHEMA });
  const [source] = fragment.依据来源;
  assert.equal(source["runner 镜像"][0].镜像, NOT_TRANSCRIBED);
  const raw = { 编号: "V-20261104-02", 类型: "结论", 结论: "#491 失败", 判定: "未验证", 依据来源: [source] };
  const unlabeled = problemsOf(raw);
  assert.ok(unlabeled.length > 0);
  for (const problem of unlabeled) assert.ok(/^依据来源\[0\]\.步骤\[\d+\]\.标签$/.test(problem.field) || problem.field === "静态门禁覆盖", `${problem.field}: ${problem.message}`);
  const labeled = structuredClone(source);
  const gates = new Set();
  for (const item of labeled.步骤) {
    const resolved = resolver.resolveStep(item.job, item.步骤);
    if (!resolved) continue;
    item.标签 = resolved.label;
    if (resolved.gate) gates.add(resolved.gate);
  }
  const accepted = { ...raw, 依据来源: [labeled], 静态门禁覆盖: [...gates].map((gate) => ({ 门禁: gate, 行为测试: ["无"] })) };
  assert.equal(describe(problemsOf(accepted)), "");
  assert.equal(classifyConclusion(accepted, { resolver }), "未验证");
  assert.ok(gates.has("release:workflow:check"));
  assert.ok(labeled.步骤.some((item) => item.步骤 === "Set up job" && item.标签 === undefined));
});

test("log structure errors: unpaired headings and blocks, bad and duplicate ids, YAML failures", () => {
  const ok = entry();
  const text = [
    "# 样例",
    "```text",
    "## V-20990101-99 代码块中的标题不是条目",
    "```",
    "## V-20261106-01 合格",
    "",
    "```yaml",
    yaml.dump(ok).trimEnd(),
    "```",
    "## V-20261106-02 没有块",
    "正文",
    "```yaml",
    "编号: V-20261106-03",
    "```",
    "## V-2026110-04 编号格式错误",
    "## V-20261332-05 日期不存在",
    "## V-20261106-01 重复",
    "## V-20261106-06 解析失败",
    "```yaml",
    "编号: V-20261106-06",
    "编号: V-20261106-06",
    "```",
    "## V-20261106-07 编号不一致",
    "```yaml",
    "编号: V-20261106-08",
    "```",
    "## V-20261106-09",
    "```yaml",
    yaml.dump({ ...ok, 编号: "V-20261106-09" }).trimEnd(),
    "```",
    "## V-20261106-10 未结束",
    "```yaml",
    "编号: V-20261106-10"
  ].join("\r\n");
  const { entries, errors } = parseVerificationLog(text);
  assert.deepEqual(entries.map((item) => item.id), ["V-20261106-01", "V-20261106-09"]);
  const reported = errors.map((error) => `${error.id} ${error.message}`);
  for (const expected of [
    /^V-20261106-02 标题后没有紧跟 YAML 块$/,
    /^第 \d+ 行 YAML 块前没有/,
    /^第 \d+ 行 编号 V-2026110-04 不符合/,
    /^第 \d+ 行 编号 V-20261332-05 不符合/,
    /^V-20261106-01 编号重复/,
    /^V-20261106-06 YAML 解析失败：duplicated mapping key/,
    /^V-20261106-07 YAML 中的 编号 "V-20261106-08" 与标题不一致$/,
    /^V-20261106-09 标题缺少结论摘要/,
    /^V-20261106-10 代码块没有结束标记$/
  ]) assert.ok(reported.some((line) => expected.test(line)), `${expected}\n${reported.join("\n")}`);
  assert.equal(errors.every((error) => error.code === "VLOG"), true);
});

test("secret patterns of design part 1 §6.1 are reported by name without echoing the value (Requirement 6.8)", () => {
  const samples = {
    "private-key": `-----BEGIN ${"RSA PRIVATE"} KEY-----`,
    "stream-key": `STREAM${"_KEY"}=live_0123456789`,
    "rtmp-url": `rtmp${"://"}ingest.example.invalid/live/a1b2c3`,
    "registry-or-oauth-credential": `client${"_secret"}: s3cr3t-value`,
    "github-token": `gh${"p_"}${"A1b2C3d4".repeat(4)}a1b2`,
    "github-fine-grained-token": `github${"_pat_"}11AAAA`
  };
  assert.deepEqual(Object.keys(samples).sort(), SECRET_PATTERNS.map((pattern) => pattern.id).sort());
  for (const [id, line] of Object.entries(samples)) {
    assert.deepEqual(scanSecrets(`说明\n${line}\n`), [{ line: 2, pattern: id }], id);
    const { errors } = validateVerificationLog(`${renderLog([entry()])}\n${line}\n`, options);
    const secret = errors.filter((error) => error.code === "SECRET");
    assert.equal(secret.length, 1, id);
    assert.equal(secret[0].message.includes(line), false, `${id} message must not echo the value`);
  }
  assert.deepEqual(scanSecrets(`STREAM${"_KEY"}=replace-with-stream-key\nrtmp${"://"}replace-with-ingest-host/live/key\nREGISTRY${"_PASSWORD"} 由 environment secret 提供\n`), []);
  assert.deepEqual(validateVerificationLog(renderLog([entry()]), options).errors, []);
});

test("--commit-msg checks Verification-Log trailers and embedded blocks; 本提交 is valid only there", () => {
  const log = validateVerificationLog(renderLog([entry(), entry({ 编号: "V-20261106-02", 判定: "行为验证" })]), options);
  assert.deepEqual(log.errors.map((error) => `${error.id} ${error.field}`), ["V-20261106-02 判定"]);
  const thisCommit = entry({ 编号: "V-20261106-03", 依据来源: [localSource({ 提交: "本提交" })] });
  const message = (body) => `docs: sample\n\n${body}\n`;
  const check = (body) => validateCommitMessage(message(body), { ...options, entries: log.entries }).errors.map((error) => `${error.id} ${error.field}: ${error.message}`);
  assert.deepEqual(check("Verification-Log: V-20261106-01"), []);
  assert.deepEqual(check("verification-log:   V-20261106-01  "), []);
  assert.match(check("Verification-Log: V-20261106-02").join("\n"), /本身没有通过校验/);
  assert.match(check("Verification-Log: V-20261106-77").join("\n"), /中没有 V-20261106-77/);
  assert.match(check("Verification-Log: V-2026-1").join("\n"), /不是 V-YYYYMMDD-NN 编号/);
  assert.deepEqual(check(["```yaml", yaml.dump(thisCommit).trimEnd(), "```"].join("\n")), []);
  assert.match(check(["```yaml", yaml.dump({ ...thisCommit, 判定: "行为验证" }).trimEnd(), "```"].join("\n")).join("\n"), /^V-20261106-03 判定: /m);
  assert.match(check(["```yaml", `${yaml.dump(thisCommit).trimEnd()}\n说明: STREAM${"_KEY"}=live_abc`, "```"].join("\n")).join("\n"), /^commit-msg:\d+ : 命中机密模式 stream-key/m);
  assert.match(check("```yaml\n编号: [\n```").join("\n"), /YAML 解析失败/);
  assert.deepEqual(check("No verification claims in this message."), []);
  const inLog = validateVerificationLog(renderLog([thisCommit]), options).errors;
  assert.deepEqual(inLog.map((error) => error.field), ["依据来源[0].提交", "判定"]);
  assert.match(inLog[0].message, /只能写在提交说明中/);
  assert.deepEqual(coverageCommits([thisCommit, entry(), { 依据来源: [externalSource()] }]), ["本提交", SHA]);
});

test("loadStaticGateCoverage reads scripts/static-gate-coverage.mjs as of each commit", async () => {
  const repo = temporaryDirectory("vlog-coverage-");
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=governance-test", "-c", "user.email=governance-test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q");
  writeFileSync(path.join(repo, "README.md"), "sample\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "without mapping");
  const before = git("rev-parse", "HEAD");
  mkdirSync(path.join(repo, "scripts"));
  writeFileSync(path.join(repo, "scripts", "static-gate-coverage.mjs"), 'export const STATIC_GATE_COVERAGE = { "ci:workflow:check": [{ test: "ci:gates:test", case: "W1-W12" }] };\n');
  git("add", "scripts/static-gate-coverage.mjs");
  git("commit", "-q", "-m", "with mapping");
  const withMapping = git("rev-parse", "HEAD");
  writeFileSync(path.join(repo, "scripts", "static-gate-coverage.mjs"), 'import "./other.mjs";\nexport const STATIC_GATE_COVERAGE = {};\n');
  const coverage = await loadStaticGateCoverage([before, withMapping.slice(0, 12), "fedcba9876543210fedcba9876543210fedcba98", "本提交"], { root: repo });
  assert.deepEqual(coverage.get(before), { status: "ok", mapping: {} });
  assert.deepEqual(coverage.get(withMapping.slice(0, 12)), { status: "ok", mapping: { "ci:workflow:check": [{ test: "ci:gates:test", case: "W1-W12" }] } });
  assert.equal(coverage.get("fedcba9876543210fedcba9876543210fedcba98").status, "unavailable");
  assert.equal(coverage.get("本提交").status, "error");
  assert.match(coverage.get("本提交").reason, /不能导入其他模块/);
});

test("CLI: fixture logs exit 0 and 1, missing inputs exit 2, --commit-msg reads a file or stdin", () => {
  const valid = runGate(["--log", fixture("valid-log.md")]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /PASS {2}governance docs: \S+valid-log\.md has 6 valid entries/);
  assert.match(valid.stdout, /^NOTE VLOG-COVERAGE V-20261106-01 静态门禁覆盖: 未核对/m);

  const invalid = runGate(["--log", fixture("invalid-log.md")]);
  assert.equal(invalid.status, 1, invalid.stdout);
  for (const expected of [
    /^VLOG V-20261107-01 标题后没有紧跟 YAML 块$/m,
    /^VLOG 第 \d+ 行 YAML 块前没有/m,
    /^VLOG 第 \d+ 行 编号 V-2026110-01 不符合 V-YYYYMMDD-NN$/m,
    /^VLOG V-20261107-02 编号重复/m,
    /^VLOG V-20261107-02 判定: 写的是 行为验证，按 Requirement 4\.6、4\.7、4\.8 复核应为 静态检查$/m,
    /^VLOG-LABEL-UNKNOWN V-20261107-03 依据来源\[0\]\.检查\[0\]\.名称: /m,
    /^VLOG V-20261107-03 依据来源\[0\]\.提交: "本提交" 只能写在提交说明中/m,
    /^VLOG V-20261107-04 YAML 解析失败/m,
    /^FAIL {2}governance docs: /m
  ]) assert.match(invalid.stderr, expected);

  const message = runGate(["--log", fixture("valid-log.md"), "--commit-msg", fixture("commit-msg-valid.txt")]);
  assert.equal(message.status, 0, message.stderr);
  assert.match(message.stdout, /commit message verification claims are valid/);
  const stdin = runGate(["--log", fixture("valid-log.md"), "--commit-msg", "-"], { input: readFileSync(fixture("commit-msg-valid.txt"), "utf8") });
  assert.equal(stdin.status, 0, stdin.stderr);
  const bad = runGate(["--log", fixture("valid-log.md"), "--commit-msg", fixture("commit-msg-invalid.txt")]);
  assert.equal(bad.status, 1, bad.stdout);
  for (const expected of [
    /^VLOG commit-msg:\d+ Verification-Log: "V-20261399-01" 不是 V-YYYYMMDD-NN 编号$/m,
    /^VLOG commit-msg:\d+ Verification-Log: \S+valid-log\.md 中没有 V-20261106-09$/m,
    /^VLOG V-20261106-08 依据来源\[0\]\.提交: 必须是 7 至 40 位/m,
    /^VLOG V-20261106-08 判定: 写的是 静态检查，按 Requirement 4\.6、4\.7、4\.8 复核应为 未验证$/m
  ]) assert.match(bad.stderr, expected);

  const missing = runGate(["--log", path.join(temporaryDirectory("vlog-missing-"), "VERIFICATION_LOG.md")]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^ERROR missing \S*VERIFICATION_LOG\.md/m);
  assert.equal(runGate(["--log", fixture("valid-log.md"), "--commit-msg", fixture("no-such-message.txt")]).status, 2);
  assert.equal(runGate(["--unknown"]).status, 2);
});

test("the repository docs/VERIFICATION_LOG.md has no errors", async () => {
  const text = readFileSync(path.join(repoRoot, "docs", "VERIFICATION_LOG.md"), "utf8");
  const commits = coverageCommits(parseVerificationLog(text).entries.map((item) => item.data));
  const coverage = await loadStaticGateCoverage(commits, { root: repoRoot });
  const result = validateVerificationLog(text, { resolver, coverageFor: (commit) => coverage.get(commit) });
  assert.equal(result.errors.map((error) => `${error.code} ${error.id} ${error.field}: ${error.message}`).join("\n"), "");
  const verdicts = Object.fromEntries(result.entries.map((item) => [item.id, item.verdict]));
  assert.equal(verdicts["V-20261104-01"], "未验证");
  const gate = runGate([]);
  assert.equal(gate.status, 0, gate.stderr);
});

// ---------------------------------------------------------------------------
// Audit_Register (design part 1 §7.5; Requirement 6.8, 7.1-7.15). The
// properties of design Property 25-29 are checked by enumerating their small
// input spaces (source marks × verification sequences × fix variants, and all
// subsets of N1-N5).

const PARENT_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const completeFix = () => ({
  提交: SHA,
  回归测试: ["scripts/integration/example.test.mjs"],
  修复前失败: { 命令: "npm run postgres:integration", 提交: PARENT_SHA },
  修复后通过: { "run id": "41900000000" }
});

/** A minimal valid record with its initial state: report issues cite the report, other ids are new defects. */
function auditRecord(id, overrides = {}) {
  const prefix = id[0];
  const series = REPORT_SERIES[prefix];
  const data = {
    编号: id,
    标题: `样例问题 ${id}`,
    来源: series && REPORT_ISSUE_IDS.includes(id) ? `审计报告 §${series.section} ${id}` : "本规格执行期间新发现（样例）",
    来源标记: REPORT_SOURCE_MARKS[id] ?? "新发现"
  };
  if (prefix === "L" && REPORT_ISSUE_IDS.includes(id)) data.原始描述 = REPORT_LOW_ITEMS[Number(id.slice(1)) - 1];
  data.优先级 = prefix === "N" ? "P1" : "P0";
  data.位置 = [`scripts/example-${id.toLowerCase()}.mjs:1`];
  data.状态 = initialStatus(data.来源标记);
  data.对应需求 = ["7"];
  data.证据 = [data.来源];
  const merged = { ...data, ...overrides };
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  return merged;
}
const reportRecords = () => REPORT_ISSUE_IDS.map((id) => auditRecord(id));

/** A register document with one heading and yaml block per record. */
function renderRegister(records, extraLines = []) {
  return ["# 样例", "", ...records.flatMap((data) => [`### ${data.编号} ${data.标题}`, "", "```yaml", yaml.dump(data, { lineWidth: -1 }).trimEnd(), "```", ""]), ...extraLines].join("\n");
}
const auditLine = (error) => `${error.code} ${error.id}${error.field ? ` ${error.field}` : ""}: ${error.message}`;
const describeAudit = (errors) => errors.map(auditLine).join("\n");
const auditErrors = (records, options = {}) => validateAuditRegister(renderRegister(records), { resolver, ...options }).errors;
/** Errors of one record placed among the 54 report records (it replaces the record with the same id, or is added). */
function recordErrors(record, options) {
  const records = reportRecords().map((data) => (data.编号 === record.编号 ? record : data));
  if (!REPORT_ISSUE_IDS.includes(record.编号)) records.push(record);
  return auditErrors(records, options);
}
const fieldsOf = (record, options) => recordErrors(record, options).map((error) => `${error.code} ${error.field}`);
/** The record with 状态 set to the derived state, so that only the rule under test can fail. */
const consistent = (record) => ({ ...record, 状态: deriveStatus(record) });

test("the 54-record sample of C1-C4, H1-H7, M1-M25 and L1-L18 validates (Requirement 7.1)", () => {
  assert.equal(REPORT_ISSUE_IDS.length, 54);
  assert.deepEqual(Object.fromEntries(Object.entries(REPORT_SERIES).map(([prefix, series]) => [prefix, series.count])), { C: 4, H: 7, M: 25, L: 18 });
  assert.equal(REPORT_LOW_ITEMS.length, 18);
  assert.ok(Object.isFrozen(REPORT_LOW_ITEMS));
  assert.match(AUDIT_REPORT.sha256, /^[0-9a-f]{64}$/);
  const result = validateAuditRegister(renderRegister(reportRecords()), { resolver });
  assert.equal(describeAudit(result.errors), "");
  assert.equal(result.records.length, 54);
  const sample = validateAuditRegister(readFileSync(auditFixture("valid-register.md"), "utf8"), { resolver, vlog: [{ id: "V-20261106-01", verdict: "静态检查", valid: true }] });
  assert.equal(describeAudit(sample.errors), "");
  assert.deepEqual(countByStatus(sample.records), { 待复核: 30, 已确认: 21, 已否定: 1, 需环境验证: 1, 已修复: 1 });
});

test("AR-SET: deleting L18, duplicating M3, N2 without N1 and unknown ids are reported (Requirement 7.1, 7.14)", () => {
  const withoutL18 = auditErrors(reportRecords().filter((data) => data.编号 !== "L18"));
  assert.deepEqual(withoutL18.map((error) => `${error.code} ${error.id}`), ["AR-SET docs/AUDIT_REGISTER.md"]);
  assert.match(withoutL18[0].message, /^缺少 L18：审计报告 §5/);
  const duplicated = auditErrors([...reportRecords(), auditRecord("M3", { 标题: "复制的 M3" })]);
  assert.deepEqual(duplicated.map((error) => `${error.code} ${error.id}`), ["AR-SET M3"]);
  assert.match(duplicated[0].message, /重复登记（第 \d+、\d+ 行）/);
  const gap = auditErrors([...reportRecords(), auditRecord("N2")]);
  assert.deepEqual(gap.map((error) => `${error.code} ${error.id}`), ["AR-SET docs/AUDIT_REGISTER.md"]);
  assert.match(gap[0].message, /已登记到 N2，缺少 N1/);
  for (const id of ["C5", "M26", "X1", "N0", "N01"]) {
    const unknown = auditErrors([...reportRecords(), auditRecord(id)]).filter((error) => error.code === "AR-SET");
    assert.deepEqual(unknown.map((error) => error.id), [id], id);
  }
  // Property 28: for every subset S of N1-N5, AR-SET is silent iff S = {N1, …, Nk}.
  for (let mask = 0; mask < 32; mask += 1) {
    const numbers = [1, 2, 3, 4, 5].filter((number) => mask & (1 << (number - 1)));
    const errors = auditErrors([...reportRecords(), ...numbers.map((number) => auditRecord(`N${number}`))]).filter((error) => error.code === "AR-SET");
    assert.equal(errors.length === 0, numbers.every((number, index) => number === index + 1), `N set {${numbers.join(", ")}}: ${describeAudit(errors)}`);
  }
  assert.ok(auditErrors([...reportRecords(), auditRecord("N1"), auditRecord("N1")]).some((error) => error.code === "AR-SET" && error.id === "N1"));
});

test("AR-LOW-TEXT: L descriptions equal the frozen REPORT_LOW_ITEMS word for word (Requirement 7.2)", () => {
  const changed = recordErrors(auditRecord("L1", { 原始描述: "token 比较不安全" }));
  assert.deepEqual(changed.map((error) => `${error.code} ${error.id} ${error.field}`), ["AR-LOW-TEXT L1 原始描述"]);
  assert.match(changed[0].message, /"token 比较不是常量时间"/);
  assert.deepEqual(fieldsOf(auditRecord("L18", { 原始描述: undefined })), ["AR-LOW-TEXT 原始描述"]);
  assert.deepEqual(fieldsOf(auditRecord("L9", { 原始描述: "Gateway 的小问题 " })), ["AR-LOW-TEXT 原始描述"]);
  assert.deepEqual(fieldsOf(auditRecord("L9", { 报告子项: ["子项一", "子项二"] })), []);
  assert.deepEqual(fieldsOf(auditRecord("L9", { 报告子项: [] })), ["AR-FIELD 报告子项"]);
});

test("deriveStatus: the initial state of each 来源标记, then the last verification, then a complete fix (Requirement 7.4, 7.5)", () => {
  const initial = { 已核实: "已确认", 待复核: "待复核", 需环境验证: "需环境验证", 未标注: "待复核", 新发现: "待复核" };
  assert.deepEqual(Object.keys(initial), [...SOURCE_MARKS]);
  for (const mark of SOURCE_MARKS) assert.equal(deriveStatus({ 来源标记: mark }), initial[mark], mark);
  for (const record of [{}, { 来源标记: "其他" }, null, "text"]) assert.equal(deriveStatus(record), "待复核");
  // Property 25 and 26: closed over STATUSES; without verifications and fixes only 来源标记 decides.
  const verificationLists = [undefined, [], ...VERIFY_CONCLUSIONS.map((结论) => [{ 结论 }]), [{ 结论: "已确认" }, { 结论: "已否定" }], [{ 结论: "已否定" }, { 结论: "未知" }], ["not a mapping"], "not a list"];
  const fixes = [undefined, {}, { 提交: SHA }, completeFix(), "not a mapping"];
  for (const mark of [...SOURCE_MARKS, undefined, "其他"]) {
    for (const list of verificationLists) {
      for (const fix of fixes) {
        const status = deriveStatus({ 来源标记: mark, 核实: list, 修复: fix });
        const valid = Array.isArray(list) ? list.filter((item) => item !== null && typeof item === "object" && VERIFY_CONCLUSIONS.includes(item.结论)) : [];
        const expected = isCompleteFix(fix) ? "已修复" : valid.length > 0 ? valid.at(-1).结论 : initialStatus(mark);
        assert.ok(STATUSES.includes(status));
        assert.equal(status, expected, `${mark} ${JSON.stringify(list)} ${JSON.stringify(fix)}`);
      }
    }
  }
  assert.deepEqual(fieldsOf(auditRecord("M10", { 状态: "已确认" })), ["AR-STATUS 状态"]);
  assert.deepEqual(fieldsOf(auditRecord("M10", { 状态: "已验证" })), ["AR-STATUS 状态"]);
  assert.deepEqual(fieldsOf(auditRecord("M10", { 来源标记: "已核实", 状态: "已确认" })), ["AR-FIELD 来源标记"], "the report marks M10 待复核");
  assert.deepEqual(fieldsOf(auditRecord("M18", { 状态: "需环境验证" })), []);
});

test("a fix record without 修复前失败 keeps the previous state; 已修复 needs all four parts (Requirement 7.11-7.13)", () => {
  assert.equal(deriveStatus({ 来源标记: "已核实", 修复: completeFix() }), "已修复");
  // Property 27: removing any part of a complete fix returns the state to the verification or source value.
  for (const part of ["提交", "回归测试", "修复前失败", "修复后通过"]) {
    const fix = completeFix();
    delete fix[part];
    assert.equal(isCompleteFix(fix), false, part);
    assert.equal(deriveStatus({ 来源标记: "已核实", 修复: fix }), "已确认", part);
    assert.equal(deriveStatus({ 来源标记: "新发现", 核实: [{ 结论: "已确认" }], 修复: fix }), "已确认", part);
    assert.equal(deriveStatus({ 来源标记: "需环境验证", 修复: fix }), "需环境验证", part);
  }
  assert.equal(isCompleteFix({ ...completeFix(), 提交: "abc123" }), false, "a commit needs at least 7 hex digits");
  assert.equal(isCompleteFix({ ...completeFix(), 回归测试: [] }), false);
  assert.equal(isCompleteFix({ ...completeFix(), 修复前失败: { 命令: "npm run postgres:integration" } }), false);
  assert.equal(isCompleteFix({ ...completeFix(), 修复后通过: { "run id": "run-1" } }), false);
  assert.equal(isCompleteFix({ ...completeFix(), 提交: SHA.slice(0, 7), 修复后通过: { 命令: "npm run postgres:integration", 提交: SHA } }), true);

  const withoutBefore = completeFix();
  delete withoutBefore.修复前失败;
  assert.deepEqual(fieldsOf(auditRecord("C1", { 修复: withoutBefore })), []);
  const claimed = recordErrors(auditRecord("C1", { 修复: withoutBefore, 状态: "已修复" }));
  assert.deepEqual(claimed.map((error) => `${error.code} ${error.field}`), ["AR-FIX 状态"]);
  assert.match(claimed[0].message, /修复前失败.*状态保持 已确认/);
  assert.deepEqual(fieldsOf(auditRecord("C1", { 修复: completeFix(), 状态: "已修复" })), []);
  assert.deepEqual(fieldsOf(auditRecord("C1", { 修复: completeFix() })), ["AR-STATUS 状态"]);
  assert.deepEqual(fieldsOf(auditRecord("C1", { 修复: { 提交: "not-a-sha" } })), ["AR-FIX 修复.提交"]);
  assert.deepEqual(fieldsOf(auditRecord("C1", { 修复: { 提交: SHA, 修复前失败: { 命令: "npm test" } } })), ["AR-FIX 修复.修复前失败"]);
});

test("已否定 needs a behavioral or code-reading basis and a 无需修复 key; a static check alone is an error (Requirement 7.9, 7.10)", () => {
  const negated = (method, evidence, extra = {}) => auditRecord("M11", { 状态: "已否定", 对应需求: ["28"], 优先级: "P1", 核实: [{ 提交: SHA, 方法: method, 结论: "已否定", 证据: evidence }], 无需修复: [], ...extra });
  const codeReading = { 文件: "apps/console/lib/control-plane/outbox.ts", 行号范围: "125-134", 推理: "样例：markDelivered 失败时不调用 markFailed" };
  const staticLocal = recordErrors(negated("本机测试", { 测试名称: "runtime:outbox:check", 命令: "npm run runtime:outbox:check" }));
  assert.deepEqual(staticLocal.map((error) => `${error.code} ${error.field}`), ["AR-NEGATE 核实[0]"]);
  assert.match(staticLocal[0].message, /只有 static 检查（runtime:outbox:check）/);
  assert.deepEqual(fieldsOf(negated("CI_Pipeline 运行", { "run id": "41900000000", 步骤: ["Run npm run runtime:outbox:check"] })), ["AR-NEGATE 核实[0]"]);
  assert.deepEqual(fieldsOf(negated("本机测试", { 测试名称: "ci:gates:test", 命令: "npm run ci:gates:test" })), []);
  assert.deepEqual(fieldsOf(negated("CI_Pipeline 运行", { "run id": "41900000000", 步骤: ["Run npm run runtime:outbox:check", "Run npm run db:migrate"] })), []);
  assert.deepEqual(fieldsOf(negated("代码阅读", codeReading)), []);
  assert.deepEqual(fieldsOf(negated("本机测试", { 测试名称: "ci:gates:test" })), ["AR-VERIFY 核实[0].证据.命令", "AR-NEGATE 核实[0]"]);

  const unregistered = { 测试名称: "scripts/integration/example.test.mjs", 命令: "npm run postgres:integration", 记录: "V-20261106-02" };
  const log = (verdict) => [{ id: "V-20261106-02", verdict, valid: true }];
  assert.match(describeAudit(recordErrors(negated("本机测试", unregistered), { vlog: log("静态检查") })), /^AR-NEGATE M11 核实\[0\]: 无法确认否定依据是 Behavioral_Test/m);
  assert.deepEqual(fieldsOf(negated("本机测试", unregistered), { vlog: log("行为验证") }), []);
  assert.deepEqual(fieldsOf(negated("本机测试", unregistered), { vlog: [] }), ["AR-VERIFY 核实[0].证据.记录", "AR-NEGATE 核实[0]"]);
  const external = { 环境: "4090 主机", 日期: "2026-11-06", 记录: "V-20261106-02" };
  assert.deepEqual(fieldsOf(negated("外部环境测试", external), { vlog: log("行为验证") }), []);
  assert.deepEqual(fieldsOf(negated("外部环境测试", external), { vlog: log("未验证") }), ["AR-NEGATE 核实[0]"]);

  assert.deepEqual(fieldsOf(negated("代码阅读", codeReading, { 无需修复: undefined })), ["AR-NEGATE 无需修复"]);
  assert.deepEqual(fieldsOf(negated("代码阅读", codeReading, { 无需修复: ["28.12"] })), []);
  assert.deepEqual(fieldsOf(negated("代码阅读", codeReading, { 无需修复: ["25.4"] })), ["AR-NEGATE 无需修复"], "25.4 is not an acceptance criterion of Requirement 28");
  assert.deepEqual(fieldsOf(negated("代码阅读", codeReading, { 无需修复: ["28"] })), ["AR-NEGATE 无需修复"]);
  const { 推理: _reasoning, ...withoutReasoning } = codeReading;
  assert.deepEqual(fieldsOf(negated("代码阅读", withoutReasoning)), ["AR-VERIFY 核实[0].证据.推理", "AR-NEGATE 核实[0]"]);
  const confirmedLater = consistent(auditRecord("M11", { 对应需求: ["28"], 优先级: "P1", 核实: [{ 提交: SHA, 方法: "代码阅读", 结论: "已否定", 证据: codeReading }, { 提交: SHA, 方法: "代码阅读", 结论: "已确认", 证据: codeReading }] }));
  assert.equal(confirmedLater.状态, "已确认");
  assert.deepEqual(fieldsOf(confirmedLater), []);
  assert.deepEqual(fieldsOf({ ...confirmedLater, 无需修复: ["28.12"] }), ["AR-NEGATE 无需修复"]);
});

test("AR-ORDER: an unreviewed issue with a fix record needs a 已确认 verification first (Requirement 7.8)", () => {
  const reading = (结论) => ({ 提交: SHA, 方法: "代码阅读", 结论, 证据: { 文件: "apps/example.mjs", 行号范围: "1-2", 推理: "样例" } });
  // Property 29, over every source mark and verification sequences with and without 已确认.
  for (const [id, mark] of [["M10", "待复核"], ["L2", "未标注"], ["N1", "新发现"], ["C1", "已核实"], ["M18", "需环境验证"]]) {
    for (const verifications of [undefined, [reading("需环境验证")], [reading("已确认")], [reading("已确认"), reading("需环境验证")]]) {
      const record = consistent(auditRecord(id, { 核实: verifications, 修复: { 提交: SHA } }));
      const ordered = recordErrors(record).filter((error) => error.code === "AR-ORDER");
      const confirmed = (verifications ?? []).some((item) => item.结论 === "已确认");
      assert.equal(ordered.length, ["待复核", "未标注", "新发现"].includes(mark) && !confirmed ? 1 : 0, `${id} ${JSON.stringify(verifications?.map((item) => item.结论))}`);
      assert.deepEqual(recordErrors(record).filter((error) => error.code !== "AR-ORDER"), [], id);
    }
  }
});

test("AR-VERIFY: each verification records 提交, 方法, 结论 and the evidence fields of its method (Requirement 7.6, 7.7)", () => {
  const evidenceByMethod = {
    代码阅读: { 文件: "apps/example.mjs", 行号范围: "1-9", 推理: "样例" },
    本机测试: { 测试名称: "ci:gates:test", 命令: "npm run ci:gates:test" },
    "CI_Pipeline 运行": { "run id": "41900000000", 步骤: ["Run npm run ci:gates:test"] },
    外部环境测试: { 环境: "Linux 主机", 日期: "2026-11-06", 记录: "V-20261106-01" }
  };
  const vlog = [{ id: "V-20261106-01", verdict: "行为验证", valid: true }];
  const verified = (item) => fieldsOf(consistent(auditRecord("M10", { 优先级: "P1", 对应需求: ["28"], 核实: [item] })), { vlog });
  for (const [method, evidence] of Object.entries(evidenceByMethod)) {
    const base = { 提交: SHA, 方法: method, 结论: "已确认", 证据: evidence };
    assert.deepEqual(verified(base), [], method);
    assert.deepEqual(verified({ ...base, 证据: [evidence, evidence] }), [], `${method} with an evidence list`);
    for (const field of Object.keys(evidence)) {
      const reduced = { ...evidence };
      delete reduced[field];
      assert.deepEqual(verified({ ...base, 证据: reduced }), [`AR-VERIFY 核实[0].证据.${field}`], `${method} without ${field}`);
    }
  }
  for (const field of ["提交", "方法", "结论"]) {
    const item = { 提交: SHA, 方法: "代码阅读", 结论: "已确认", 证据: evidenceByMethod.代码阅读 };
    delete item[field];
    assert.deepEqual(verified(item), [`AR-VERIFY 核实[0].${field}`], field);
  }
  const reading = (evidence, extra = {}) => ({ 提交: SHA, 方法: "代码阅读", 结论: "已确认", 证据: { ...evidenceByMethod.代码阅读, ...evidence }, ...extra });
  assert.deepEqual(verified(reading({ 行号范围: "第 1 行" })), ["AR-VERIFY 核实[0].证据.行号范围"]);
  assert.deepEqual(verified(reading({ 文件: "C:\\repo\\x.mjs" })), ["AR-VERIFY 核实[0].证据.文件"]);
  assert.deepEqual(verified(reading({}, { 提交: "HEAD" })), ["AR-VERIFY 核实[0].提交"]);
  assert.deepEqual(verified(reading({}, { 方法: "人工评审" })), ["AR-VERIFY 核实[0].方法"]);
  assert.deepEqual(verified(reading({}, { 结论: "已复核" })), ["AR-VERIFY 核实[0].结论"]);
  const external = (evidence) => ({ 提交: SHA, 方法: "外部环境测试", 结论: "已确认", 证据: { ...evidenceByMethod.外部环境测试, ...evidence } });
  assert.deepEqual(verified(external({ 日期: "2026-13-01" })), ["AR-VERIFY 核实[0].证据.日期"]);
  assert.deepEqual(verified(external({ 记录: "V-20261106-09" })), ["AR-VERIFY 核实[0].证据.记录"]);
  assert.deepEqual(verified({ 提交: SHA, 方法: "CI_Pipeline 运行", 结论: "已确认", 证据: { "run id": "run-1", 步骤: [] } }), ["AR-VERIFY 核实[0].证据.run id", "AR-VERIFY 核实[0].证据.步骤"]);
});

test("AR-FIELD: the five required fields, 对应需求 \"无\" without a reason, record pairing, and the report's 来源 and 来源标记 (Requirement 7.3)", () => {
  const withoutId = validateAuditRegister(renderRegister(reportRecords()).replace("```yaml\n编号: M5\n", "```yaml\n"), { resolver }).errors;
  for (const field of ["编号", "位置", "状态", "证据", "对应需求"]) {
    const errors = field === "编号" ? withoutId : recordErrors(auditRecord("M5", { [field]: undefined }));
    assert.ok(errors.some((error) => error.code === "AR-FIELD" && error.id === "M5" && error.field === field && /缺少字段/.test(error.message)), `${field}\n${describeAudit(errors)}`);
  }
  assert.deepEqual(fieldsOf(auditRecord("N1", { 对应需求: ["无"] })), ["AR-FIELD 对应需求[0]"]);
  assert.deepEqual(fieldsOf(auditRecord("N1", { 对应需求: ["无："] })), ["AR-FIELD 对应需求[0]"]);
  assert.deepEqual(fieldsOf(auditRecord("N1", { 对应需求: ["无：不属于 Requirement 1 至 40 的验收标准"] })), []);
  assert.deepEqual(fieldsOf(auditRecord("N1", { 对应需求: ["无：样例理由", "8"] })), ["AR-FIELD 对应需求[0]"]);
  assert.deepEqual(fieldsOf(auditRecord("M5", { 对应需求: ["41"] })), ["AR-FIELD 对应需求[0]"]);
  assert.deepEqual(fieldsOf(auditRecord("M5", { 对应需求: [] })), ["AR-FIELD 对应需求"]);
  for (const location of ["C:\\repo\\x.mjs", "/srv/x.mjs", "scripts/x.mjs:第 3 行", "../outside.mjs", "scripts/x.mjs:"]) assert.deepEqual(fieldsOf(auditRecord("M5", { 位置: [location] })), ["AR-FIELD 位置[0]"], location);
  assert.deepEqual(fieldsOf(auditRecord("M5", { 位置: ["apps/console/app/api/v1/products/[productId]/versions/route.ts:8", "scripts/check-*.mjs", "infra/postgres/migrations/059_x.sql:21,25,62-64", ".github/workflows/ci.yml"] })), []);
  assert.deepEqual(fieldsOf(auditRecord("M5", { 证据: [] })), ["AR-FIELD 证据"]);
  assert.deepEqual(fieldsOf(auditRecord("M5", { 来源: "审计报告 §5 M5" })), ["AR-FIELD 来源"]);
  assert.deepEqual(fieldsOf(auditRecord("N1", { 来源标记: "待复核" })), ["AR-FIELD 来源标记"]);
  const text = renderRegister(reportRecords());
  const mismatched = validateAuditRegister(text.replace("```yaml\n编号: M5\n", "```yaml\n编号: M6\n"), { resolver }).errors;
  assert.deepEqual(mismatched.map((error) => `${error.code} ${error.id} ${error.field}`), ["AR-FIELD M5 编号"]);
  const retitled = validateAuditRegister(text.replace("### M5 样例问题 M5", "### M5 另一个标题"), { resolver }).errors;
  assert.deepEqual(retitled.map((error) => `${error.code} ${error.id} ${error.field}`), ["AR-FIELD M5 标题"]);
  const broken = validateAuditRegister(text.replace(/(### H1 [^\n]*\n\n```yaml\n)/, "$1编号: H1\n"), { resolver }).errors;
  assert.deepEqual(broken.map((error) => `${error.code} ${error.id}`), ["AR-FIELD H1"], "a record whose YAML fails still counts for AR-SET");
  assert.match(broken[0].message, /YAML 解析失败：duplicated mapping key/);
  const unpaired = validateAuditRegister(`${text}\n### N1 没有块\n\n正文\n\n\`\`\`yaml\n编号: N2\n\`\`\`\n\n### N2 未结束\n\n\`\`\`yaml\n编号: N2\n`, { resolver }).errors;
  assert.deepEqual(unpaired.map((error) => error.message.replace(/第 \d+ 行/, "第 n 行")), ["标题后没有紧跟 YAML 块", "YAML 块前没有 `### <编号> <标题>` 记录标题", "代码块没有结束标记"]);
});

test("AR-PRIORITY: new defects need a priority; report issues take the highest priority of their requirements (Requirement 7.15)", () => {
  assert.deepEqual(fieldsOf(auditRecord("N1", { 优先级: undefined })), ["AR-PRIORITY 优先级"]);
  assert.deepEqual(fieldsOf(auditRecord("N1", { 优先级: "P3" })), ["AR-PRIORITY 优先级"]);
  for (const priority of ["P0", "P1", "P2"]) assert.deepEqual(fieldsOf(auditRecord("N1", { 优先级: priority, 对应需求: ["8"] })), [], priority);
  assert.deepEqual(fieldsOf(auditRecord("L2", { 对应需求: ["37"], 优先级: "P0" })), ["AR-PRIORITY 优先级"]);
  assert.deepEqual(fieldsOf(auditRecord("L2", { 对应需求: ["37"], 优先级: "P2" })), []);
  assert.deepEqual(fieldsOf(auditRecord("L1", { 对应需求: ["17", "37"], 优先级: "P0" })), []);
  assert.deepEqual(fieldsOf(auditRecord("M2", { 优先级: undefined })), ["AR-PRIORITY 优先级"]);
  assert.deepEqual(Object.entries(REQUIREMENT_PRIORITIES).filter(([, priority]) => priority === "P2").map(([number]) => number), ["35", "37", "38", "39"]);
  assert.deepEqual(["1", "3", "7", "19", "20", "36", "40"].map((number) => REQUIREMENT_PRIORITIES[number]), ["P0", "P1", "P0", "P0", "P1", "P1", "P1"]);
});

test("the register is scanned for the secret patterns of design part 1 §6.1 (Requirement 6.8)", () => {
  const line = `STREAM${"_KEY"}=live_0123456789`;
  const errors = validateAuditRegister(renderRegister(reportRecords(), ["", line]), { resolver }).errors;
  assert.deepEqual(errors.map((error) => error.code), ["SECRET"]);
  assert.match(errors[0].id, /^docs\/AUDIT_REGISTER\.md:\d+$/);
  assert.equal(errors[0].message.includes(line), false);
  assert.deepEqual(recordErrors(auditRecord("M5", { 说明: `样例 -----BEGIN ${"OPENSSH PRIVATE"} KEY-----` })).map((error) => error.code), ["SECRET"]);
});

// The first-round registration (task 2.2) is the 54 report issues plus N1-N5. New defects found later
// are appended as N6, N7, ... (Requirement 7.14; AR-SET checks the numbering).
const FIRST_ROUND_IDS = [...REPORT_ISSUE_IDS, "N1", "N2", "N3", "N4", "N5"];
// docs/AUDIT_REGISTER.md as committed by task 2.2 (8226fa3), frozen as a fixture so that the phase 1
// assertions keep a fixed input while the live register gains verifications and fixes. The pinned value
// is the git blob id of 8226fa3:docs/AUDIT_REGISTER.md, so the fixture cannot drift from that commit.
const PHASE1_REGISTER_COMMIT = "8226fa3";
const PHASE1_REGISTER_BLOB = "0f7eb8a0c5ec910452af64d610df9c19ae589a28";
const gitBlobId = (text) => {
  const bytes = Buffer.from(text.replace(/\r\n/g, "\n"), "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};
const repositoryLog = () => validateVerificationLog(readFileSync(path.join(repoRoot, "docs", "VERIFICATION_LOG.md"), "utf8"), options);

test(`the phase 1 register snapshot (${PHASE1_REGISTER_COMMIT}:docs/AUDIT_REGISTER.md) has no errors and holds the first-round registration`, () => {
  const text = readFileSync(auditFixture("phase1-register.md"), "utf8");
  assert.equal(gitBlobId(text), PHASE1_REGISTER_BLOB, `phase1-register.md must stay byte-identical to ${PHASE1_REGISTER_COMMIT}:docs/AUDIT_REGISTER.md`);
  const log = repositoryLog();
  const result = validateAuditRegister(text, { resolver, vlog: log.entries });
  assert.equal(describeAudit(result.errors), "");
  assert.deepEqual(result.records.map((record) => record.id), FIRST_ROUND_IDS);
  assert.deepEqual(countByStatus(result.records), { 待复核: 36, 已确认: 21, 已否定: 0, 需环境验证: 2, 已修复: 0 });
  const byId = Object.fromEntries(result.records.map((record) => [record.id, record]));
  assert.equal(byId.M20.status, "已确认");
  assert.deepEqual(byId.M20.data.核实.map((item) => [item.提交.slice(0, 7), item.方法, item.结论]), [["dc2916e", "代码阅读", "已确认"]]);
  for (const id of ["N1", "N2", "N3", "N4", "N5"]) assert.equal(byId[id].status, "待复核", id);
  assert.deepEqual(["N2", "N3", "N4", "N5"].map((id) => byId[id].data.优先级), ["P1", "P2", "P2", "P1"]);
  assert.deepEqual(byId.N5.data.对应需求, ["无：不属于 Requirement 1 至 40 的验收标准"]);
  assert.ok(result.records.every((record) => record.data.修复 === undefined), "no first-round record carries a fix in phase 1");
  for (const record of result.records) assert.equal(record.data.状态, record.status, record.id);
  assert.ok(text.includes(AUDIT_REPORT.file) && text.includes("VERIFICATION_LOG.md#v-20261105-05"));
  assert.ok(log.entries.find((entry) => entry.id === "V-20261105-05")?.data.结论.includes(AUDIT_REPORT.sha256));
});

test("the repository docs/AUDIT_REGISTER.md has no errors, keeps every report issue and numbers new defects without gaps", () => {
  const text = readFileSync(path.join(repoRoot, "docs", "AUDIT_REGISTER.md"), "utf8");
  const log = repositoryLog();
  const result = validateAuditRegister(text, { resolver, vlog: log.entries });
  assert.equal(describeAudit(result.errors), "");
  const ids = result.records.map((record) => record.id);
  assert.deepEqual(ids.slice(0, FIRST_ROUND_IDS.length), FIRST_ROUND_IDS);
  const newDefects = ids.slice(FIRST_ROUND_IDS.length);
  assert.deepEqual(newDefects, newDefects.map((_, index) => `N${FIRST_ROUND_IDS.length - REPORT_ISSUE_IDS.length + index + 1}`), `new defects follow N5 without gaps: ${newDefects.join(", ")}`);
  const byId = Object.fromEntries(result.records.map((record) => [record.id, record]));
  REPORT_LOW_ITEMS.forEach((description, index) => assert.equal(byId[`L${index + 1}`].data.原始描述, description, `L${index + 1}`));
  for (const record of result.records) {
    assert.equal(record.valid, true, record.id);
    assert.equal(record.data.状态, record.status, record.id);
    assert.equal(record.status, deriveStatus(record.data), record.id);
  }
  assert.ok(text.includes(AUDIT_REPORT.file) && text.includes("VERIFICATION_LOG.md#v-20261105-05"));
});

test("CLI: --register validates a register fixture; errors exit 1, a missing register exits 2", () => {
  const valid = runGate(["--log", fixture("valid-log.md"), "--register", auditFixture("valid-register.md")]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /valid-register\.md has 54 valid records \(待复核 30, 已确认 21, 已否定 1, 需环境验证 1, 已修复 1\)/);
  const invalid = runGate(["--log", fixture("valid-log.md"), "--register", auditFixture("invalid-register.md")]);
  assert.equal(invalid.status, 1, invalid.stdout);
  for (const expected of [
    /^AR-FIELD H1 YAML 解析失败：duplicated mapping key/m,
    /^AR-SET C1 重复登记（第 \d+、\d+ 行）/m,
    /^AR-SET \S+invalid-register\.md 新缺陷编号必须从 N1 起顺序递增、不跳号：已登记到 N2，缺少 N1/m,
    /^AR-SET \S+invalid-register\.md 缺少 C2：/m,
    /^AR-FIX C1 状态: 修复记录缺少或写错 修复前失败，不能标为已修复，状态保持 已确认/m,
    /^AR-LOW-TEXT L1 原始描述: "token 比较不安全"/m,
    /^AR-ORDER M10 修复: /m,
    /^AR-NEGATE M11 无需修复: /m,
    /^AR-NEGATE M11 核实\[0\]: 否定依据只有 static 检查（runtime:outbox:check）/m,
    /^AR-VERIFY M12 核实\[0\]\.方法: 缺少字段/m,
    /^AR-STATUS M13 状态: 取值 "已验证"/m,
    /^AR-FIELD M14 对应需求\[0\]: 没有对应需求时必须写明理由/m,
    /^AR-PRIORITY N2 优先级: 新缺陷必须/m,
    /^FAIL {2}governance docs: /m
  ]) assert.match(invalid.stderr, expected);
  assert.doesNotMatch(invalid.stderr, /缺少 H1：/);
  const missing = runGate(["--register", path.join(temporaryDirectory("audit-missing-"), "AUDIT_REGISTER.md")]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^ERROR missing \S*AUDIT_REGISTER\.md/m);
  assert.equal(runGate(["--register"]).status, 2);
});

// ---------------------------------------------------------------------------
// Readiness_Matrix (design part 1 §6.5; part 8 Requirement 40 §6.4;
// Requirement 6.1-6.8, 32.10, 32.11, 40.1, 40.5-40.7). The sample matrix has D1
// pending and cites V-20261106-01; entries are built in memory.

const matrixFixture = (name) => path.join(scriptsDir, "fixtures", "governance-docs", "matrix", name);
const handoffFixture = (name) => path.join(scriptsDir, "fixtures", "governance-docs", "handoff", name);
const d1Fixture = (name) => path.join(scriptsDir, "fixtures", "governance-docs", "d1", name);
const MATRIX = readFileSync(matrixFixture("valid-matrix.md"), "utf8");
const vlogEntry = (id, verdict, sources, overrides = {}) => ({ id, verdict, valid: true, data: { 编号: id, 依据来源: sources }, ...overrides });
const matrixVlog = [
  vlogEntry("V-20261106-01", "行为验证", [localSource({ 检查: [{ 名称: "docs:governance:test", 标签: "behavioral" }] })]),
  vlogEntry("V-20261106-02", "静态检查", [localSource()]),
  vlogEntry("V-20261106-03", "行为验证", [githubSource({ 步骤: [step({ 标签: "behavioral" })] })]),
  vlogEntry("V-20261106-04", "行为验证", [linuxSource()]),
  vlogEntry("V-20261106-05", "未验证", [externalSource()])
];
const matrixErrors = (text, vlog = matrixVlog) => validateReadinessMatrix(text, { vlog });
const codesOf = (errors) => [...new Set(errors.map((error) => error.code))].sort();
const describeRows = (errors) => errors.map((error) => `${error.code} ${error.line} ${error.message}`).join("\n");
/** Replaces exactly one occurrence of `from`, so that every sample edits the line it means to. */
function edit(text, from, to) {
  const count = text.split(from).length - 1;
  assert.equal(count, 1, `sample edit must match once: ${from}`);
  return text.replace(from, to);
}
const rowLine = (text, id) => text.split("\n").find((line) => line.startsWith(`| ${id} |`));
function setCell(text, id, column, value) {
  const line = rowLine(text, id);
  assert.ok(line, id);
  const cells = splitTableRow(line);
  cells[column] = value;
  return edit(text, line, `| ${cells.join(" | ")} |`);
}
const withRow = (text, afterId, row) => edit(text, rowLine(text, afterId), `${rowLine(text, afterId)}\n${row}`);
const withoutRow = (text, id) => edit(text, `${rowLine(text, id)}\n`, "");
const decided = (text, { date = "2026-11-05", spec = "—", status = "代码未完成" } = {}) => {
  let result = edit(text, "| D1 | 首个目标直播平台 | 待用户决策 | — | — | — |", `| D1 | 首个目标直播平台 | 已决定 | 抖音 | ${date} | ${spec} |`);
  for (const id of D1_ROWS) result = setCell(result, id, 2, status);
  return result;
};
const PEM_HEADER = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");

test("the sample matrix validates, and parseReadinessMatrix reads its sections, rows and decision", () => {
  assert.equal(describeRows(matrixErrors(MATRIX)), "");
  const parsed = parseReadinessMatrix(MATRIX);
  assert.deepEqual([...parsed.sections.keys()], ["状态定义", "真实开播放行条件", "外部先决条件", "仓库交付项", "待决策事项", "发布判定"]);
  assert.equal(parsed.rows.filter((row) => row.kind === "EP").length, 14);
  assert.equal(parsed.rows.find((row) => row.id === "EP-12").condition, "已满足");
  assert.equal(d1Decision(parsed).decision, "待用户决策");
  assert.deepEqual(Object.keys(REQUIRED_EXTERNAL_ROWS), Array.from({ length: 14 }, (_, index) => `EP-${String(index + 1).padStart(2, "0")}`));
  assert.equal(MATRIX_STATUSES.length, 6);
  assert.deepEqual(splitTableRow("| a \\| b | c |"), ["a \\| b", "c"]);
  assert.equal(rowCriterion("15.14(a)：试听"), "15.14(a)");
  assert.equal(rowCriterion("14.1：推流"), "14.1");
  assert.equal(rowCriterion("13.1–13.6：输入"), null);
});

test("RM-HEADER: table headers and cell counts are fixed", () => {
  assert.deepEqual(codesOf(matrixErrors(edit(MATRIX, "| 编号 | 事项 | 状态 | 外部条件 | 证据 | 对应需求 | 说明 |", "| 编号 | 事项 | 状态 | 证据 | 对应需求 | 说明 |"))), ["RM-HEADER"]);
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "RW-002-01", 1, "失败 | 隔离"))), ["RM-HEADER"]);
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "RW-002-01", 1, "失败 \\| 隔离"))), []);
  assert.deepEqual(codesOf(matrixErrors(edit(MATRIX, "## 发布判定", "## 发布"))), ["RM-HEADER"]);
});

test("RM-ID: id format, duplicates, table placement and the 对应需求 column", () => {
  assert.match(describeRows(matrixErrors(setCell(MATRIX, "RW-002-01", 0, "RW-2-01"))), /^RM-ID \d+ 编号 RW-2-01 不符合 RW-NNN-MM$/m);
  const duplicate = withRow(MATRIX, "RW-002-01", "| RW-002-01 | 重复 | 代码未完成 | — | 2 | 样例 |");
  assert.match(describeRows(matrixErrors(duplicate)), /^RM-ID \d+ 编号 RW-002-01 重复/m);
  assert.match(describeRows(matrixErrors(withRow(MATRIX, "RW-002-01", "| EP-15 | 外部 | External_Prerequisite | — | 6 | 样例 |"))), /^RM-ID \d+ EP-15 不能写在 仓库交付项 表中$/m);
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "RW-002-01", 4, "无"))), ["RM-ID"]);
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "RW-002-01", 4, "3"))), ["RM-ID"]);
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "RW-000-01", 4, "1"))), ["RM-ID"]);
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "RW-002-01", 4, "2, 41"))), ["RM-ID"]);
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "RW-002-01", 4, "2, 36"))), []);
});

test("RM-STATUS: statuses outside the six, and prefix-status mismatches (Property 21)", () => {
  assert.match(describeRows(matrixErrors(setCell(MATRIX, "RW-002-01", 2, "已完成"))), /^RM-STATUS \d+ RW-002-01 的状态"已完成"不是六个状态之一$/m);
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "EP-03", 2, "代码未完成"))), ["RM-STATUS"]);
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "RW-002-01", 2, "External_Prerequisite"))), ["RM-STATUS"]);
  assert.deepEqual(codesOf(matrixErrors(edit(MATRIX, "- 代码未完成\n", ""))), ["RM-STATUS"]);
  fc.assert(
    fc.property(fc.constantFrom("EP-03", "RW-002-01"), fc.constantFrom(...MATRIX_STATUSES, "已完成", "代码完成", ""), (id, value) => {
      const statusErrors = matrixErrors(setCell(MATRIX, id, 2, value)).filter((error) => error.code === "RM-STATUS");
      const allowed = id.startsWith("EP-") ? value === "External_Prerequisite" : RW_STATUSES.includes(value);
      return (statusErrors.length === 0) === allowed;
    }),
    { seed: 6021, numRuns: 100 }
  );
});

test("RM-EP-REQUIRED: EP-01 to EP-14 exist with their frozen wording", () => {
  assert.match(describeRows(matrixErrors(withoutRow(MATRIX, "EP-05"))), /^RM-EP-REQUIRED \d+ 缺少外部先决条件行 EP-05/m);
  assert.match(describeRows(matrixErrors(setCell(MATRIX, "EP-03", 1, "OIDC 提供方"))), /^RM-EP-REQUIRED \d+ EP-03 的事项必须逐字为"OIDC 提供商"$/m);
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "EP-03", 1, "  OIDC 提供商  "))), []);
});

test("RM-EP-EVIDENCE: 已满足 needs 位置, 日期 and 提供方; /healthz alone only passes as 未满足 (Property 22)", () => {
  const healthz = setCell(MATRIX, "EP-01", 4, "/healthz 200");
  assert.deepEqual(codesOf(matrixErrors(healthz)), []);
  assert.deepEqual(codesOf(matrixErrors(setCell(healthz, "EP-01", 3, "已满足"))), ["RM-EP-EVIDENCE"]);
  const satisfied = (evidence) => setCell(setCell(MATRIX, "EP-01", 3, "已满足"), "EP-01", 4, evidence);
  assert.deepEqual(codesOf(matrixErrors(satisfied("位置=试播报告 R-1，日期=2026-11-20，提供方=运维负责人"))), []);
  for (const bad of ["—", "位置=Gateway /healthz 响应，日期=2026-11-20，提供方=运维", "位置=开发 fixture，日期=2026-11-20，提供方=开发", "位置=试播报告，日期=2026/11/20，提供方=运维", "位置=试播报告，日期=2026-02-30，提供方=运维", "位置=试播报告，日期=2026-11-20"]) {
    assert.deepEqual(codesOf(matrixErrors(satisfied(bad))), ["RM-EP-EVIDENCE"], bad);
  }
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "EP-02", 3, "部分满足"))), ["RM-EP-EVIDENCE"]);
  fc.assert(
    fc.property(fc.constantFrom("/healthz 200", "容器 running", "口头确认", "开发 fixture"), fc.boolean(), (weak, mark) => {
      const errors = matrixErrors(setCell(setCell(MATRIX, "EP-01", 4, weak), "EP-01", 3, mark ? "已满足" : "未满足"));
      return mark ? codesOf(errors).includes("RM-EP-EVIDENCE") : errors.length === 0;
    }),
    { seed: 6022, numRuns: 100 }
  );
});

test("RM-RW-EVIDENCE: 有验证证据 rows cite valid behavioral entries with a runnable source (Property 23)", () => {
  assert.deepEqual(codesOf(matrixErrors(MATRIX)), []);
  const cite = (evidence) => setCell(MATRIX, "RW-001-01", 3, evidence);
  assert.match(describeRows(matrixErrors(cite("V-20261106-02"))), /^RM-RW-EVIDENCE \d+ RW-001-01 引用的 V-20261106-02 不合格：该条目的判定为 静态检查/m);
  assert.deepEqual(codesOf(matrixErrors(cite("—"))), ["RM-RW-EVIDENCE"]);
  assert.deepEqual(codesOf(matrixErrors(cite("V-20261106-09"))), ["RM-RW-EVIDENCE"]);
  assert.deepEqual(codesOf(matrixErrors(cite("V-20261106-05"))), ["RM-RW-EVIDENCE"]);
  assert.deepEqual(codesOf(matrixErrors(cite("run 42040219509"))), ["RM-RW-EVIDENCE"]);
  assert.deepEqual(codesOf(matrixErrors(cite("V-20261106-01；V-20261106-03"))), []);
  assert.deepEqual(codesOf(matrixErrors(MATRIX, [vlogEntry("V-20261106-01", "行为验证", [externalSource()])])), ["RM-RW-EVIDENCE"]);
  assert.deepEqual(codesOf(matrixErrors(MATRIX, [{ ...matrixVlog[0], valid: false }])), ["RM-RW-EVIDENCE"]);
  assert.match(describeRows(matrixErrors(MATRIX, null)), /^RM-RW-EVIDENCE \d+ RW-001-01 标为代码已完成且有验证证据，但 VERIFICATION_LOG 解析失败/m);
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "RW-002-01", 3, "V-20261106-09"))), ["RM-RW-EVIDENCE"]);
  fc.assert(
    fc.property(fc.constantFrom(...matrixVlog.map((item) => item.id)), (id) => {
      const qualifies = ["V-20261106-01", "V-20261106-03", "V-20261106-04"].includes(id);
      return (matrixErrors(cite(id)).length === 0) === qualifies;
    }),
    { seed: 6023, numRuns: 100 }
  );
});

test("RM-GO-LIVE: the go-live section and its key texts are required (Requirement 6.5)", () => {
  assert.deepEqual(codesOf(matrixErrors(edit(MATRIX, "## 真实开播放行条件", "## 开播"))), ["RM-GO-LIVE"]);
  assert.match(describeRows(matrixErrors(edit(MATRIX, "，缺任一项即不放行", ""))), /^RM-GO-LIVE \d+ 真实开播放行条件一节缺少关键文本"缺任一项即不放行"/m);
  assert.deepEqual(codesOf(matrixErrors(edit(MATRIX, "并以退出码 0 结束", "并结束"))), ["RM-GO-LIVE"]);
});

test("RM-ENV-ROW: each 4090, Linux and release criterion has one row with an allowed status (Requirement 32.10, 32.11)", () => {
  assert.equal(REQUIRED_ENVIRONMENT_ROWS.length, 15);
  assert.match(describeRows(matrixErrors(withoutRow(MATRIX, "RW-031-03"))), /^RM-ENV-ROW \d+ 缺少事项以 31\.5 开头的仓库交付行/m);
  assert.match(describeRows(matrixErrors(withRow(MATRIX, "RW-032-04", "| RW-032-06 | 32.7：重复 | 代码已完成但待外部环境验证 | — | 32 | 样例 |"))), /^RM-ENV-ROW \d+ 32\.7 对应多行：RW-032-02、RW-032-06$/m);
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "RW-031-02", 2, "代码已完成但待 CI 或 Linux 验证"))), ["RM-ENV-ROW"]);
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "RW-032-04", 2, "代码已完成但待外部环境验证"))), ["RM-ENV-ROW"]);
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "RW-031-02", 2, "代码未完成"))), []);
  const verified = (id) => setCell(setCell(MATRIX, "RW-031-02", 2, "代码已完成且有验证证据"), "RW-031-02", 3, id);
  assert.deepEqual(codesOf(matrixErrors(verified("V-20261106-03"))), ["RM-ENV-ROW"]);
  assert.deepEqual(codesOf(matrixErrors(verified("V-20261106-04"))), []);
});

test("RM-D1: decision D1 and the four RW-040 rows stay consistent (Requirement 40.1, 40.5-40.7)", () => {
  assert.deepEqual(codesOf(matrixErrors(setCell(MATRIX, "RW-040-02", 2, "代码未完成"))), ["RM-D1"]);
  assert.match(describeRows(matrixErrors(withoutRow(MATRIX, "RW-040-03"))), /^RM-D1 \d+ 缺少 Requirement 40\.1 的行 RW-040-03$/m);
  assert.deepEqual(codesOf(matrixErrors(edit(MATRIX, "| D1 | 首个目标直播平台 | 待用户决策 | — | — | — |", "| D1 | 首个目标直播平台 | 待用户决策 | 抖音 | — | — |"))), ["RM-D1"]);
  assert.deepEqual(codesOf(matrixErrors(decided(MATRIX))), []);
  assert.deepEqual(codesOf(matrixErrors(decided(MATRIX, { spec: "e:\\.kiro\\specs\\douyin-adapter" }))), []);
  assert.deepEqual(codesOf(matrixErrors(decided(MATRIX, { spec: "规格 待定" }))), ["RM-D1"]);
  assert.match(describeRows(matrixErrors(decided(MATRIX, { date: "2026/11/05" }))), /^RM-D1 \d+ D1 的决策日期"2026\/11\/05"不是合法的 YYYY-MM-DD 日期/m);
  assert.deepEqual(codesOf(matrixErrors(decided(MATRIX, { status: "External_Prerequisite" }))), ["RM-D1", "RM-STATUS"]);
  assert.deepEqual(codesOf(matrixErrors(decided(MATRIX, { status: "待用户决策" }))), ["RM-D1"]);
  assert.deepEqual(codesOf(matrixErrors(edit(MATRIX, "| D1 | 首个目标直播平台 | 待用户决策 |", "| D1 | 首个目标直播平台 | 暂缓 |"))), ["RM-D1"]);
});

test("SECRET: the matrix is scanned for the secret patterns, reported by name only (Property 24)", () => {
  const pem = withRow(MATRIX, "RW-002-01", `| RW-002-02 | ${PEM_HEADER} | 代码未完成 | — | 2 | 样例 |`);
  const errors = matrixErrors(pem);
  assert.deepEqual(codesOf(errors), ["SECRET"]);
  assert.ok(!describeRows(errors).includes("BEGIN"), "the report names the pattern, not the text");
  assert.deepEqual(codesOf(matrixErrors(edit(MATRIX, "1. 样例。", `1. 样例：STREAM${"_KEY"}=abc。`))), ["SECRET"]);
  fc.assert(
    fc.property(fc.constantFrom(...SECRET_PATTERNS.map((item) => item.id)), fc.stringMatching(/^[A-Za-z0-9]{36}$/), (id, tail) => {
      const samples = {
        "private-key": PEM_HEADER,
        "stream-key": `STREAM${"_KEY"}=${tail}`,
        "rtmp-url": `rtmp${"://"}live.example.invalid/app/${tail}`,
        "registry-or-oauth-credential": `REGISTRY${"_PASSWORD"}=${tail}`,
        "github-token": `gh${"p_"}${tail}`,
        "github-fine-grained-token": `github${"_pat_"}${tail}`
      };
      return codesOf(matrixErrors(edit(MATRIX, "1. 样例。", `1. ${samples[id]}`))).includes("SECRET");
    }),
    { seed: 6024, numRuns: 100 }
  );
});

test("the repository docs/DEPLOYMENT_READINESS.md has no errors and keeps D1 decided with the four rows 代码未完成", () => {
  const text = readFileSync(path.join(repoRoot, "docs", "DEPLOYMENT_READINESS.md"), "utf8");
  const log = repositoryLog();
  assert.equal(describeRows(validateReadinessMatrix(text, { vlog: log.entries })), "");
  const parsed = parseReadinessMatrix(text);
  assert.deepEqual({ ...d1Decision(parsed), line: 0 }, { decision: "已决定", platform: "抖音", date: "2026-11-05", spec: "—", line: 0 });
  for (const id of D1_ROWS) assert.equal(parsed.rows.find((row) => row.id === id).status, "代码未完成", id);
  for (const row of parsed.rows.filter((item) => item.kind === "EP")) assert.equal(row.condition, row.id === "EP-12" ? "已满足" : "未满足", row.id);
});

// ---------------------------------------------------------------------------
// Handoff_Doc and docs/*.md rules (design part 1 §4.4, §5.5; part 8
// Requirement 40 §6.4; Requirement 4.1, 4.7, 5.1-5.8, 40.2-40.4).

const RUN_LINK = "[run 41900000000 @ 0123456](VERIFICATION_LOG.md#v-20261106-03)";
const handoffVlog = [
  ...matrixVlog,
  vlogEntry("V-20261106-06", "未验证", [githubSource({ "run id": "41900000001", 运行结论: "failure", 步骤: [step({ 结论: "failure" })] })]),
  vlogEntry("V-20261106-07", "未验证", [githubSource({ "run id": "41900000002", 步骤: [step(), step({ 步骤: "Run npm run build", 结论: "skipped" })] })])
];
const auditSample = [{ id: "C2", status: "已确认" }, { id: "M18", status: "需环境验证" }, { id: "C1", status: "已修复" }];
const RESUME_SAMPLE = [
  "# 交接",
  "",
  "## 当前检查点",
  "",
  "- 核对日期：2026-11-06",
  `- origin/master：${SHA}`,
  "- 同步状态：一致",
  `- 最新 CI 运行：run 41900000000，提交 ${SHA}，结论 success`,
  "",
  "## 审计问题状态",
  "",
  "- C2：已确认（[登记](AUDIT_REGISTER.md#c2)）",
  "- M18：需环境验证（[登记](AUDIT_REGISTER.md#m18)）",
  "",
  "## 未完成边界",
  "",
  "- EP-01：4090 试播，为未满足。",
  "- RW-001-01：代码已完成且有验证证据。",
  ""
].join("\n");
const handoffFiles = (overrides = {}) => ({ "docs/RESUME_HANDOFF.md": RESUME_SAMPLE, "docs/FRAMEWORK_STATUS.md": "# 状态\n", "docs/IMPLEMENTATION_ROADMAP.md": "# 路线图\n", "README.md": "# 说明\n", ...overrides });
const handoffErrors = (overrides = {}, context = {}) => validateHandoffDocs({ files: handoffFiles(overrides) }, { audit: auditSample, matrix: MATRIX, vlog: handoffVlog, ...context });
const describeHandoff = (errors) => errors.map((error) => `${error.code} ${error.file}:${error.line} ${error.message}`).join("\n");
const status = (text) => handoffErrors({ "docs/FRAMEWORK_STATUS.md": text });

test("splitUnits cuts table cells, list items with continuation lines and sentences, with their start lines", () => {
  const units = splitUnits(["# 标题", "", "| 甲 | 乙 |", "| --- | --- |", "| 一 | 二 |", "", "- 第一项", "  续行。", "  - 嵌套项", "", "第一句。第二", "句。", "", "```", "已验证", "```"].join("\n"));
  assert.deepEqual(units.map((unit) => [unit.kind, unit.text, unit.line]), [
    ["heading", "标题", 1],
    ["cell", "甲", 3],
    ["cell", "乙", 3],
    ["cell", "一", 5],
    ["cell", "二", 5],
    ["item", "第一项续行。", 7],
    ["item", "嵌套项", 9],
    ["sentence", "第一句。", 11],
    ["sentence", "第二\n句。", 11]
  ]);
});

test("CLAIM: claim words need a VERIFICATION_LOG link or 未验证 in the same unit (Requirement 4.1, 4.7)", () => {
  for (const word of ["已验证", "已覆盖", "已通过"]) {
    const errors = findClaimViolations({ "docs/OPEN_SOURCE_RUNTIME.md": `# 运行时\n\n第一句。这项检查${word}。\n` }, { vlog: handoffVlog });
    assert.match(describeHandoff(errors), new RegExp(`^CLAIM docs/OPEN_SOURCE_RUNTIME\\.md:3 缺少验证出处：「这项检查${word}。」`), word);
  }
  const clean = (text, file = "docs/OPEN_SOURCE_RUNTIME.md") => findClaimViolations({ [file]: text }, { vlog: handoffVlog });
  assert.deepEqual(clean("- 门禁已覆盖（[V-20261106-01](VERIFICATION_LOG.md#v-20261106-01)）。\n"), []);
  assert.deepEqual(clean("| 门禁已通过（未验证） |\n"), []);
  assert.deepEqual(clean("门禁已覆盖（[V](docs/VERIFICATION_LOG.md#v-20261106-01)）。\n", "README.md"), []);
  assert.equal(clean("门禁已覆盖（[V](VERIFICATION_LOG.md#v-20261106-01)）。\n", "README.md").length, 1, "README links need the docs/ prefix");
  assert.equal(clean("门禁已覆盖（[V](VERIFICATION_LOG.md#v-20261106-05)）。\n").length, 1, "an entry judged 未验证 is no provenance");
  assert.equal(clean("门禁已覆盖。见 [V](VERIFICATION_LOG.md#v-20261106-01)。\n").length, 1, "claim and link in two sentences");
  assert.deepEqual(findClaimViolations({ "docs/VERIFICATION_LOG.md": "已验证。\n", "docs/AUDIT_REGISTER.md": "已覆盖。\n" }), []);
});

test("CI-CLAIM and RUN-REF: CI conclusions cite a qualifying run or say 未验证 (Requirement 5.1, 5.6)", () => {
  assert.equal(isCiClaim("CI PostgreSQL 集成测试覆盖草稿改写"), true);
  assert.equal(isCiClaim("CI 配置已实现并推送"), false);
  assert.match(describeHandoff(status("- CI PostgreSQL 集成测试覆盖草稿改写。\n")), /^CI-CLAIM docs\/FRAMEWORK_STATUS\.md:1 CI 结论缺少合格的运行引用或"未验证"/m);
  assert.deepEqual(codesOf(status("- CI PostgreSQL 集成测试覆盖草稿改写（未验证）。\n")), []);
  assert.deepEqual(codesOf(status(`- CI PostgreSQL 集成测试覆盖草稿改写，见 ${RUN_LINK}。\n`)), []);
  const bad = (link) => describeHandoff(status(`- CI PostgreSQL 集成测试覆盖草稿改写，见 ${link}。\n`));
  assert.match(bad("[run 41900000001 @ 0123456](VERIFICATION_LOG.md#v-20261106-06)"), /^RUN-REF \S+ \[run 41900000001 @ 0123456\]\S+：run 41900000001 的运行结论为 failure/m);
  assert.match(bad("[run 41900000002 @ 0123456](VERIFICATION_LOG.md#v-20261106-07)"), /^RUN-REF .*结论为 skipped，不是 success/m);
  assert.match(bad("[run 41900000000 @ fedcba9](VERIFICATION_LOG.md#v-20261106-03)"), /^RUN-REF .*不以 fedcba9 开头/m);
  assert.match(bad("[run 41900000000 @ 0123456](VERIFICATION_LOG.md#v-20261106-09)"), /^RUN-REF .*VERIFICATION_LOG 中没有 V-20261106-09/m);
  assert.match(describeHandoff(handoffErrors({ "README.md": `- CI PostgreSQL 集成测试覆盖草稿改写，见 ${RUN_LINK}。\n` })), /^RUN-REF README\.md:1 .*链接路径必须是 docs\/VERIFICATION_LOG\.md/m);
  assert.equal(runReferenceProblem({ runId: "41900000000", sha: "0123456", entryId: "V-20261106-03" }, handoffVlog), null);
});

test("AUDIT-LIST: the audit status section equals the register's 已确认 and 需环境验证 ids (Requirement 5.3)", () => {
  assert.equal(describeHandoff(handoffErrors()), "");
  const resume = (text) => handoffErrors({ "docs/RESUME_HANDOFF.md": text });
  assert.match(describeHandoff(resume(edit(RESUME_SAMPLE, "- M18：需环境验证（[登记](AUDIT_REGISTER.md#m18)）\n", ""))), /^AUDIT-LIST \S+ 审计问题状态的编号集合与 Audit_Register .*缺少 M18；多出 无/m);
  assert.match(describeHandoff(resume(edit(RESUME_SAMPLE, "- C2：已确认", "- C2：已修复"))), /^AUDIT-LIST \S+ C2 写的是 已修复，Audit_Register 中为 已确认$/m);
  assert.deepEqual(codesOf(resume(`${RESUME_SAMPLE.replace("## 审计问题状态", "## 审计问题状态\n\n- C1：已修复（[登记](AUDIT_REGISTER.md#c1)）")}`)), ["AUDIT-LIST"]);
  assert.deepEqual(codesOf(resume(edit(RESUME_SAMPLE, "(AUDIT_REGISTER.md#c2)", "(AUDIT_REGISTER.md#c3)"))), ["AUDIT-LIST"]);
});

test("CHECKPOINT and STALE-SYNC: fixed checkpoint fields; sync wording elsewhere is stale (Requirement 5.4, 5.7, 5.8; Property 18)", () => {
  const resume = (text) => handoffErrors({ "docs/RESUME_HANDOFF.md": text });
  for (const value of ["领先 0 个提交", "领先 -1 个提交", "领先 1 个提交 ", "分叉"]) {
    assert.match(describeHandoff(resume(edit(RESUME_SAMPLE, "- 同步状态：一致", `- 同步状态：${value}`))), /^CHECKPOINT \S+:7 字段"同步状态"/m, JSON.stringify(value));
  }
  assert.deepEqual(codesOf(resume(edit(RESUME_SAMPLE, "- 同步状态：一致", "- 同步状态：领先 2 个提交"))), []);
  assert.match(describeHandoff(resume(edit(RESUME_SAMPLE, "结论 success", "结论 failure"))), /^CHECKPOINT \S+:8 最新 CI 运行的结论不是 success 时必须写出首个失败 job 和失败步骤序号/m);
  assert.deepEqual(codesOf(resume(edit(RESUME_SAMPLE, "结论 success", "结论 failure，首个失败 job console，失败步骤序号 31"))), []);
  assert.match(describeHandoff(resume(edit(RESUME_SAMPLE, "- 核对日期：2026-11-06\n", ""))), /^CHECKPOINT \S+ 当前检查点缺少字段"核对日期"/m);
  assert.deepEqual(codesOf(resume(edit(RESUME_SAMPLE, `- origin/master：${SHA}`, "- origin/master：a42b6c4"))), ["CHECKPOINT"]);
  assert.match(describeHandoff(resume(`${RESUME_SAMPLE}\n- 远端检查点：a42b6c4\n- 本地 master 当前领先远端。\n`)), /^STALE-SYNC docs\/RESUME_HANDOFF\.md:\d+ 检查点字段以外出现同步状态描述"远端检查点"[\s\S]*^STALE-SYNC \S+ .*"领先远端"/m);
  assert.deepEqual(codesOf(status("本地领先 3 个提交。\n")), ["STALE-SYNC"]);
  fc.assert(
    fc.property(fc.oneof(fc.constant("一致"), fc.integer({ min: -3, max: 50 }).map((n) => `领先 ${n} 个提交`), fc.integer({ min: -3, max: 50 }).map((n) => `落后 ${n} 个提交`), fc.string()), (value) => {
      const accepted = value === "一致" || /^(领先|落后) [1-9]\d* 个提交$/.test(value);
      return SYNC_STATE.test(value) === accepted;
    }),
    { seed: 6018, numRuns: 100 }
  );
});

test("the dc2916e RESUME_HANDOFF.md reports CI-CLAIM and STALE-SYNC for the remote checkpoint and 领先远端", () => {
  const text = readFileSync(handoffFixture("dc2916e-RESUME_HANDOFF.md"), "utf8");
  const errors = validateHandoffDocs({ files: { "docs/RESUME_HANDOFF.md": text } }, { audit: auditSample, matrix: MATRIX, vlog: handoffVlog });
  assert.ok(errors.some((error) => error.code === "CI-CLAIM"), "at least one CI-CLAIM");
  const stale = errors.filter((error) => error.code === "STALE-SYNC").map((error) => error.message);
  assert.ok(stale.some((message) => message.includes("远端检查点")) && stale.some((message) => message.includes("领先远端")), stale.join("\n"));
  assert.ok(errors.some((error) => error.code === "CHECKPOINT"));
});

test("MATRIX-STATUS: statuses next to EP and RW ids equal the matrix (Requirement 5.5)", () => {
  assert.deepEqual(codesOf(status("- RW-040-01 至 RW-040-04：待用户决策。\n")), []);
  assert.match(describeHandoff(status("- RW-040-01 至 RW-040-04：代码未完成。\n")), /^MATRIX-STATUS docs\/FRAMEWORK_STATUS\.md:1 RW-040-01 写的是"代码未完成"，Readiness_Matrix 中为"待用户决策"/m);
  assert.deepEqual(codesOf(status("- 代码已完成但待外部环境验证：RW-014-02 至 RW-014-05、RW-031-02。\n")), []);
  assert.deepEqual(codesOf(status("- 代码未完成：RW-014-02。\n")), ["MATRIX-STATUS"]);
  assert.deepEqual(codesOf(status("- EP-12 已满足；EP-01 未满足。\n")), []);
  assert.deepEqual(codesOf(status("- EP-01 已满足。\n")), ["MATRIX-STATUS"]);
  assert.match(describeHandoff(status("- RW-099-01：代码未完成。\n")), /RW-099-01 不在 Readiness_Matrix 中/);
  assert.match(describeHandoff(status("- RW-001-01 的 CI 结论（未验证）。\n")), /RW-001-01 在矩阵中为代码已完成且有验证证据，同一单元不能标"未验证"/);
});

test("D1-MENTION, D1-STATUS, D1-DEFAULT apply only while D1 is 待用户决策 (Requirement 40.2-40.4)", () => {
  const { samples } = JSON.parse(readFileSync(d1Fixture("dc2916e-samples.json"), "utf8"));
  const check = (text, matrix = MATRIX) => validateHandoffDocs({ files: { "docs/FRAMEWORK_STATUS.md": `${text}\n` } }, { matrix, vlog: handoffVlog }).filter((error) => error.code.startsWith("D1-"));
  for (const key of ["README.md:65", "docs/RESUME_HANDOFF.md:110", "docs/FRAMEWORK_STATUS.md:20", "docs/FRAMEWORK_STATUS.md:68"]) {
    const codes = codesOf(check(samples[key]));
    assert.ok(codes.includes("D1-MENTION") || codes.includes("D1-STATUS"), `${key}: ${codes.join(",")}`);
    assert.deepEqual(check(samples[key], decided(MATRIX)), [], `${key} with D1 decided`);
  }
  assert.deepEqual(codesOf(check(samples["README.md:65"])), ["D1-MENTION", "D1-STATUS"]);
  assert.deepEqual(check(samples["docs/RESUME_HANDOFF.md:111"]), []);
  assert.deepEqual(check("- 选定平台的 OAuth/Webhook/商品同步/账单 Adapter：待用户决策（D1）。平台账号、应用审核和真实数据是外部前置条件。"), []);
  const mention = check(samples["docs/FRAMEWORK_STATUS.md:68"]).find((error) => error.code === "D1-MENTION");
  assert.ok(mention.message.length < 160 && /「[^」]{1,80}」/.test(mention.message), mention.message);
  assert.deepEqual(codesOf(check("首个目标平台为抖音。")), ["D1-DEFAULT"]);
  assert.deepEqual(codesOf(check("抖音作为首个平台。")), ["D1-DEFAULT"]);
  assert.deepEqual(check("抖音、淘宝、视频号等实际 API 仍是外部平台前置条件。"), []);
  assert.deepEqual(check("首个目标平台为抖音。", decided(MATRIX)), []);
});

test("the repository Handoff_Doc files and docs/*.md pass the claim and handoff rules", () => {
  const log = repositoryLog();
  const register = validateAuditRegister(readFileSync(path.join(repoRoot, "docs", "AUDIT_REGISTER.md"), "utf8"), { resolver, vlog: log.entries });
  const matrix = readFileSync(path.join(repoRoot, "docs", "DEPLOYMENT_READINESS.md"), "utf8");
  const files = Object.fromEntries(HANDOFF_FILES.map((file) => [file, readFileSync(path.join(repoRoot, file), "utf8")]));
  for (const name of ["OPEN_SOURCE_RUNTIME.md", "DEPLOYMENT_READINESS.md", "ARCHITECTURE.md", "PRODUCT_BLUEPRINT.md"]) files[`docs/${name}`] = readFileSync(path.join(repoRoot, "docs", name), "utf8");
  assert.equal(describeHandoff(validateHandoffDocs({ files }, { audit: register.records, matrix, vlog: log.entries })), "");
});

test("CLI: --docs-root checks a matrix and Handoff_Doc set; a broken log also voids matrix evidence; a missing file exits 2", () => {
  const docsRoot = temporaryDirectory("handoff-docs-");
  mkdirSync(path.join(docsRoot, "docs"));
  const files = handoffFiles({ "docs/DEPLOYMENT_READINESS.md": MATRIX.replaceAll("V-20261106-01", "V-20261106-99"), "docs/RESUME_HANDOFF.md": RESUME_SAMPLE.replace(/## 审计问题状态[\s\S]*?## 未完成边界/, "## 审计问题状态\n\n## 未完成边界").replace("- RW-001-01：代码已完成且有验证证据。\n", "") });
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(docsRoot, file), text);
  const valid = runGate(["--log", fixture("valid-log.md"), "--register", auditFixture("valid-register.md"), "--docs-root", docsRoot]);
  assert.match(valid.stderr, /^RM-RW-EVIDENCE docs\/DEPLOYMENT_READINESS\.md:\d+ RW-001-01 引用的 V-20261106-99 不合格：VERIFICATION_LOG 中没有该条目/m);
  assert.match(valid.stderr, /^AUDIT-LIST docs\/RESUME_HANDOFF\.md:\d+ /m);
  const broken = runGate(["--log", fixture("invalid-log.md"), "--register", auditFixture("valid-register.md"), "--docs-root", docsRoot]);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /^VLOG V-20261107-01 /m);
  assert.match(broken.stderr, /^RM-RW-EVIDENCE docs\/DEPLOYMENT_READINESS\.md:\d+ RW-001-01 标为代码已完成且有验证证据，但 VERIFICATION_LOG 解析失败/m);
  rmSync(path.join(docsRoot, "docs", "FRAMEWORK_STATUS.md"));
  const missing = runGate(["--log", fixture("valid-log.md"), "--register", auditFixture("valid-register.md"), "--docs-root", docsRoot]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^ERROR missing docs\/FRAMEWORK_STATUS\.md/m);
});
