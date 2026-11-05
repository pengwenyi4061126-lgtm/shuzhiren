// Behavioral tests of the documentation governance gate: the VERIFICATION_LOG
// rules of scripts/lib/verification-log.mjs, the Audit_Register rules of
// scripts/lib/audit-register.mjs and the scripts/check-governance-docs.mjs CLI
// (design part 1 §4.5, §7.5; Requirement 1.12, 1.14, 1.15, 4.1-4.8, 6.8,
// 7.1-7.15, 36.13, 36.14). Labels are resolved against the real LOCAL_CHECKS,
// CI_ONLY_STEPS and package.json; workflows are inline. Samples live in
// scripts/fixtures/governance-docs/vlog/ and scripts/fixtures/governance-docs/audit/;
// secret-like strings are assembled at run time so that no fixture contains one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("the repository docs/AUDIT_REGISTER.md has no errors and holds the first-round registration", () => {
  const text = readFileSync(path.join(repoRoot, "docs", "AUDIT_REGISTER.md"), "utf8");
  const log = validateVerificationLog(readFileSync(path.join(repoRoot, "docs", "VERIFICATION_LOG.md"), "utf8"), options);
  const result = validateAuditRegister(text, { resolver, vlog: log.entries });
  assert.equal(describeAudit(result.errors), "");
  // The first-round registration (task 2.2) is the 54 report issues plus N1-N5. New defects found later
  // are appended as N6, N7, ... (Requirement 7.14; AR-SET checks the numbering), so the first-round
  // assertions below apply to the first-round records only.
  const firstRoundIds = [...REPORT_ISSUE_IDS, "N1", "N2", "N3", "N4", "N5"];
  const ids = result.records.map((record) => record.id);
  assert.deepEqual(ids.slice(0, firstRoundIds.length), firstRoundIds);
  assert.ok(ids.slice(firstRoundIds.length).every((id) => /^N[1-9][0-9]*$/.test(id)), `only new defects follow the first round: ${ids.slice(firstRoundIds.length).join(", ")}`);
  const firstRound = result.records.filter((record) => firstRoundIds.includes(record.id));
  assert.deepEqual(countByStatus(firstRound), { 待复核: 36, 已确认: 21, 已否定: 0, 需环境验证: 2, 已修复: 0 });
  const byId = Object.fromEntries(result.records.map((record) => [record.id, record]));
  assert.equal(byId.M20.status, "已确认");
  assert.deepEqual(byId.M20.data.核实.map((item) => [item.提交.slice(0, 7), item.方法, item.结论]), [["dc2916e", "代码阅读", "已确认"]]);
  for (const id of ["N1", "N2", "N3", "N4", "N5"]) assert.equal(byId[id].status, "待复核", id);
  assert.deepEqual(["N2", "N3", "N4", "N5"].map((id) => byId[id].data.优先级), ["P1", "P2", "P2", "P1"]);
  assert.deepEqual(byId.N5.data.对应需求, ["无：不属于 Requirement 1 至 40 的验收标准"]);
  assert.ok(firstRound.every((record) => record.data.修复 === undefined), "no first-round record carries a fix in phase 1");
  assert.ok(text.includes(AUDIT_REPORT.file) && text.includes("VERIFICATION_LOG.md#v-20261105-05"));
  assert.ok(log.entries.find((entry) => entry.id === "V-20261105-05")?.data.结论.includes(AUDIT_REPORT.sha256));
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
