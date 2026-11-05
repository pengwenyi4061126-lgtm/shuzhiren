// Behavioral tests for the CI run evidence tools: scripts/collect-ci-run-evidence.mjs
// (Requirement 1.15, 3.3, 3.8), the tag and runtime parsing of
// scripts/verify-action-pins.mjs (Requirement 3.4, 3.5, 3.8) and the step
// comparison of scripts/diff-ci-steps.mjs (Requirement 1.14). Inputs are the
// #491 API responses downloaded unchanged into scripts/fixtures/ci-run-evidence/,
// the constructed "Set up job" log sample next to them, and inline workflows.
// No test accesses the network: the collector CLI is pointed at a loopback
// HTTP server that serves the fixtures.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parseWorkflow } from "./lib/workflow-model.mjs";
import { buildEvidence, countNode20DeprecationWarnings, countSkippedSteps, extractRunnerImage, failedSteps, IMAGE_NOT_COLLECTED, renderEvidence } from "./collect-ci-run-evidence.mjs";
import { classifyRuntime, resolveTagCommit } from "./verify-action-pins.mjs";
import { diffWorkflowSteps, renderDraft } from "./diff-ci-steps.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(scriptsDir, "fixtures", "ci-run-evidence", name);
const jobsResponse = JSON.parse(readFileSync(fixture("run-41869137741-jobs.json"), "utf8"));
const annotations = JSON.parse(readFileSync(fixture("run-41869137741-annotations.json"), "utf8"));
const setupJobLog = readFileSync(fixture("setup-job-log.txt"), "utf8");
const REPO = "pengwenyi4061126-lgtm/shuzhiren";
const JOB_ID = 126711085025;
const STEP_31 = "Run docker compose --env-file config/control-plane-compose.example.env -f infra/compose/docker-compose.control-plane.yml config";
// Run-level fields of run 41869137741 (#491) that the two job-level samples do
// not contain (design part 1 §0.1); head_sha also appears in the jobs sample.
const RUN_491 = Object.freeze({ id: 41869137741, run_number: 491, status: "completed", conclusion: "failure", head_sha: "dc2916eef45f2aebacde24598723468f23ee61a6", html_url: `https://github.com/${REPO}/actions/runs/41869137741` });

const temporaryDirectories = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

test("#491 jobs sample has 72 skipped steps", () => {
  assert.equal(countSkippedSteps(jobsResponse.jobs), 72);
});

test("#491 annotations contain exactly one Node.js 20 deprecation warning", () => {
  assert.equal(annotations.length, 3);
  assert.equal(countNode20DeprecationWarnings(annotations), 1);
  const inline = (message) => countNode20DeprecationWarnings([{ title: "", message }]);
  assert.equal(inline("Node.js 16 actions are deprecated. Please update the following actions to use Node.js 20: actions/checkout@v3."), 1);
  assert.equal(inline("Node.js 24 is deprecated."), 0);
  assert.equal(inline("Node.js 20 is the default runtime."), 0);
});

test("the only failing step of #491 is console step 31", () => {
  assert.deepEqual(failedSteps(jobsResponse.jobs), [{ job: "console", number: 31, name: STEP_31 }]);
});

test("runner image name and version come from the Runner Image group of the Set up job log", () => {
  const expected = { image: "ubuntu-24.04", version: "20261020.1.0" };
  assert.deepEqual(extractRunnerImage(setupJobLog), expected);
  assert.deepEqual(extractRunnerImage(`\uFEFF${setupJobLog.replace(/\r?\n/g, "\r\n")}`), expected);
  assert.deepEqual(extractRunnerImage("2026-11-05T02:10:41.4021733Z Current runner version: '2.329.0'\n"), { image: null, version: null });
});

test("#491 evidence renders as a VERIFICATION_LOG source fragment that parses back with FAILSAFE_SCHEMA", () => {
  const annotationsByJob = new Map([[JOB_ID, annotations]]);
  const read = (logsByJob) => yaml.load(renderEvidence(buildEvidence({ run: RUN_491, jobs: jobsResponse.jobs, annotationsByJob, logsByJob }), { repo: REPO }), { schema: yaml.FAILSAFE_SCHEMA });
  const [source] = read(new Map()).依据来源;
  assert.equal(source.类别, "CI 或 Linux 运行");
  assert.equal(source.平台, "GitHub Actions");
  assert.equal(source["run id"], "41869137741");
  assert.equal(source.提交, RUN_491.head_sha);
  assert.equal(source.运行结论, "failure");
  assert.equal(source["skipped 步骤数"], "72");
  assert.equal(source["node20 弃用告警数"], "1");
  assert.equal(source.步骤.length, jobsResponse.jobs[0].steps.length);
  assert.deepEqual(source.步骤.find((step) => step.序号 === "31"), { job: "console", 序号: "31", 步骤: STEP_31, 结论: "failure" });
  assert.deepEqual(source["runner 镜像"], [{ job: "console", 镜像: IMAGE_NOT_COLLECTED, 版本: IMAGE_NOT_COLLECTED }]);
  assert.deepEqual(read(new Map([[JOB_ID, setupJobLog]])).依据来源[0]["runner 镜像"], [{ job: "console", 镜像: "ubuntu-24.04", 版本: "20261020.1.0" }]);
  assert.throws(() => buildEvidence({ run: { ...RUN_491, head_sha: "0".repeat(40) }, jobs: jobsResponse.jobs }), /head_sha/);
});

/** Serves the #491 fixtures like the GitHub REST API and records the Authorization header of each request. */
async function startFixtureApi({ rateLimited = false } = {}) {
  const seen = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    seen.push({ path: url.pathname, authorization: request.headers.authorization ?? null });
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(body);
    };
    const prefix = `/repos/${REPO}`;
    if (rateLimited) return send(403, JSON.stringify({ message: "API rate limit exceeded for 127.0.0.1." }), { "x-ratelimit-remaining": "0" });
    switch (url.pathname) {
      case `${prefix}/actions/runs/41869137741`:
        return send(200, JSON.stringify(RUN_491));
      case `${prefix}/actions/runs/41869137741/jobs`:
        return send(200, readFileSync(fixture("run-41869137741-jobs.json")));
      case `${prefix}/check-runs/${JOB_ID}/annotations`:
        return send(200, readFileSync(fixture("run-41869137741-annotations.json")));
      case `${prefix}/actions/jobs/${JOB_ID}/logs`:
        return send(302, "", { location: `/storage/${JOB_ID}.log` });
      case `/storage/${JOB_ID}.log`:
        return send(200, readFileSync(fixture("setup-job-log.txt")), { "content-type": "text/plain" });
      default:
        return send(404, JSON.stringify({ message: "Not Found" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Runs the collector CLI asynchronously (the fixture server shares this event loop) in an empty working directory. */
function runCollector(apiUrl, env) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "ci-run-evidence-"));
  temporaryDirectories.push(cwd);
  const childEnv = { ...process.env, ...env };
  if (env.GITHUB_TOKEN === undefined) delete childEnv.GITHUB_TOKEN;
  const child = spawn(process.execPath, [path.join(scriptsDir, "collect-ci-run-evidence.mjs"), "--repo", REPO, "--run-id", "41869137741", "--api-url", apiUrl], { cwd, env: childEnv });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, files: readdirSync(cwd) }));
  });
}

test("collector CLI sends GITHUB_TOKEN only to the API and never prints or writes it", async () => {
  const token = `test-${randomBytes(16).toString("hex")}`;
  const api = await startFixtureApi();
  try {
    const result = await runCollector(api.url, { GITHUB_TOKEN: token });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
    assert.deepEqual(result.files, []);
    const [source] = yaml.load(result.stdout, { schema: yaml.FAILSAFE_SCHEMA }).依据来源;
    assert.equal(source["skipped 步骤数"], "72");
    assert.equal(source["node20 弃用告警数"], "1");
    assert.deepEqual(source["runner 镜像"], [{ job: "console", 镜像: "ubuntu-24.04", 版本: "20261020.1.0" }]);
    const apiRequests = api.seen.filter((request) => request.path.startsWith("/repos/"));
    assert.equal(apiRequests.length, 4);
    for (const request of apiRequests) assert.equal(request.authorization, `Bearer ${token}`, request.path);
    assert.deepEqual(api.seen.filter((request) => request.path.startsWith("/storage/")), [{ path: `/storage/${JOB_ID}.log`, authorization: null }]);
  } finally {
    await api.close();
  }
});

test("collector CLI exits 2 and asks for GITHUB_TOKEN on an API rate limit", async () => {
  const api = await startFixtureApi({ rateLimited: true });
  try {
    const result = await runCollector(api.url, { GITHUB_TOKEN: undefined });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^ERROR http status=403 url=\S+\/actions\/runs\/41869137741 message=API rate limit exceeded/m);
    assert.match(result.stderr, /GITHUB_TOKEN/);
  } finally {
    await api.close();
  }
});

test("ls-remote parsing takes the peeled commit of an annotated tag and the ref of a lightweight tag", () => {
  const [tagObject, commit, other] = ["a", "b", "c"].map((digit) => digit.repeat(40));
  assert.equal(resolveTagCommit(`${tagObject}\trefs/tags/v1.0.0\n${commit}\trefs/tags/v1.0.0^{}\n`, "v1.0.0"), commit);
  assert.equal(resolveTagCommit(`${commit}\trefs/tags/v7.0.1\r\n`, "v7.0.1"), commit);
  assert.equal(resolveTagCommit(`${other}\trefs/tags/v2.1\n`, "v2"), null);
  assert.equal(resolveTagCommit("", "v2"), null);
  assert.deepEqual(["node24", "node26", "node20", "node16", "docker", "composite", "python"].map(classifyRuntime), ["node-ok", "node-ok", "node-outdated", "node-outdated", "docker", "composite", "unknown"]);
});

test("steps diff classifies moved, deleted, skipped, relaxed, strengthened and changed steps", () => {
  const base = parseWorkflow(`jobs:
  console:
    env:
      DATABASE_URL: postgresql://localhost/x
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run a:check
      - run: npm run b:check
      - run: npm run c:test
      - run: python3 -m py_compile runtime/gateway/app.py
      - run: docker compose -f infra/x.yml config
        env:
          X: one
      - run: npm run gone:check
      - run: npm run d:test
      - run: npm run e:test
`);
  const head = parseWorkflow(`jobs:
  console:
    steps:
      - run: npm run a:check
      - run: npm run c:test
        continue-on-error: true
      - run: npm run e:test || true
  static:
    steps:
      - run: npm run b:check
      - run: python3 -m py_compile runtime/gateway/*.py scripts/t.py
      - run: npm run d:test
        if: false
  compose:
    steps:
      - run: docker compose -f infra/x.yml config
        env:
          X: two
      - run: npm run new:check
`);
  const result = diffWorkflowSteps(base, head, { baseFiles: ["runtime/gateway/app.py"], headFiles: ["runtime/gateway/app.py", "runtime/gateway/audio.py", "scripts/t.py"] });
  const summary = Object.fromEntries(result.changes.map((change) => [change.原命令, [change.变更方式, change["替代 job"]]]));
  assert.deepEqual(summary, {
    "npm run b:check": ["移动", "static"],
    "npm run c:test": ["放宽", "console"],
    "python3 -m py_compile runtime/gateway/app.py": ["加强", "static"],
    "docker compose -f infra/x.yml config": ["待定", "compose"],
    "npm run gone:check": ["删除", "无"],
    "npm run d:test": ["跳过", "static"],
    "npm run e:test": ["放宽", "console"]
  });
  assert.equal(result.unchanged, 1);
  assert.deepEqual(result.added.map((step) => step.command), ["npm run new:check"]);
  assert.ok(result.jobEnvNotes.some((note) => note.startsWith("console → static：job env DATABASE_URL 不再设置")), result.jobEnvNotes.join("\n"));
  const draft = yaml.load(renderDraft(result, { base: { rev: "base" }, head: { rev: "head" } }), { schema: yaml.FAILSAFE_SCHEMA });
  assert.equal(draft.变更.length, 7);
  for (const change of draft.变更) assert.deepEqual(Object.keys(change), ["原命令", "原 job", "变更方式", "替代命令", "替代 job", "理由"]);
});
