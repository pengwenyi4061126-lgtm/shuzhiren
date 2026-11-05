// Behavioral tests of the documentation governance gate: the VERIFICATION_LOG
// rules of scripts/lib/verification-log.mjs and the scripts/check-governance-docs.mjs
// CLI (design part 1 §4.5; Requirement 1.12, 1.14, 1.15, 4.1-4.8, 6.8, 36.13,
// 36.14). Labels are resolved against the real LOCAL_CHECKS, CI_ONLY_STEPS and
// package.json; workflows are inline. Samples live in
// scripts/fixtures/governance-docs/vlog/; secret-like strings are assembled at
// run time so that no fixture contains one.
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

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");
const fixture = (name) => path.join(scriptsDir, "fixtures", "governance-docs", "vlog", name);
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
