import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "apps", "console", "lib", "control-plane", "store.ts"), "utf8");
const preflightSection = source.slice(source.indexOf("export async function evaluateRunPreflight"), source.indexOf("export async function degradeRunFromRuntime"));

if (!preflightSection.includes("outputReady: runtime.passed")) throw new Error("Preflight must use fresh runtime telemetry as the output readiness source");
if (preflightSection.includes("run.outputReady && runtime.passed")) throw new Error("Legacy output_ready flag must not permanently block a healthy runtime");
if (!preflightSection.includes("overlayReady: overlay.passed") || !preflightSection.includes("evaluateOverlayReadinessForRun(client, run.id)")) throw new Error("Preflight must evaluate overlay readiness on the caller's existing connection");

console.log("PASS  preflight output readiness derives from fresh runtime telemetry");

// Behavioral checks of the console's connection handling, loaded from the
// TypeScript sources. The DATABASE_URL is unreachable; no test opens a socket.
register("./lib/console-ts-loader.mjs", import.meta.url);
const databaseUrl = "postgresql://probe:pa%40ss%3Aword%2Fx@127.0.0.1:1/probe";
process.env.DATABASE_URL = databaseUrl;
process.env.CONTROL_PLANE_DEMO_MODE = "false";
const database = await import("../apps/console/lib/database.ts");

async function captureConsoleErrors(action) {
  const lines = [];
  const original = console.error;
  console.error = (...values) => { lines.push(values.join(" ")); };
  try { await action(); } finally { console.error = original; }
  return lines;
}

function fakeClient({ rollbackError } = {}) {
  const client = new EventEmitter();
  client.released = [];
  client.query = async (sql) => {
    if (sql === "rollback" && rollbackError) throw rollbackError;
    return { rows: [] };
  };
  client.release = (error) => { client.released.push(error); };
  return client;
}

async function withFakePool(client, action) {
  const previous = globalThis.shuzhirenDatabasePool;
  globalThis.shuzhirenDatabasePool = { connect: async () => client };
  try { return await action(); } finally { globalThis.shuzhirenDatabasePool = previous; }
}

{
  const pool = database.createDatabasePool({ connectionString: databaseUrl, timeoutMs: 200 });
  assert.ok(pool.listenerCount("error") >= 1, "the control-plane pool must register an error listener before any connect");
  const idleError = Object.assign(new Error(`terminating connection to ${databaseUrl} for probe:pa@ss:word/x@127.0.0.1`), { code: "57P01" });
  const lines = await captureConsoleErrors(() => pool.emit("error", idleError));
  assert.equal(lines.length, 1, "an idle connection error must be logged exactly once");
  assert.match(lines[0], /"event":"database\.pool_error"/);
  assert.match(lines[0], /"code":"57P01"/);
  for (const secret of [databaseUrl, "pa%40ss%3Aword%2Fx", "pa@ss:word/x"]) assert.ok(!lines[0].includes(secret), `pool error logs must not contain ${secret}`);
  await pool.end();
}

{
  const operationError = new Error("operation failed");
  const client = fakeClient({ rollbackError: new Error("rollback failed: connection terminated") });
  const lines = await captureConsoleErrors(() => withFakePool(client, () => assert.rejects(
    database.withTenantTransaction("00000000-0000-4000-8000-000000000001", async () => {
      client.emit("error", new Error("connection terminated between queries"));
      throw operationError;
    }),
    (error) => error === operationError,
    "a failed rollback must not replace the error that aborted the transaction"
  )));
  assert.equal(client.released.length, 1);
  assert.ok(client.released[0] instanceof Error, "a broken transaction connection must be released with an error so the pool destroys it");
  assert.equal(client.listenerCount("error"), 0, "the transaction must detach its client error listener before release");
  assert.ok(lines.some((line) => line.includes('"event":"database.rollback_failed"')));
}

{
  const client = fakeClient();
  await withFakePool(client, () => database.withTenantTransaction("00000000-0000-4000-8000-000000000001", async () => "ok"));
  assert.deepEqual(client.released, [undefined], "a healthy transaction connection must return to the pool");
}

console.log("PASS  console database pool logs idle connection errors, keeps the original transaction error, and destroys broken connections");

// The node-postgres default parser turns a PostgreSQL `date` into local midnight, which toISOString() moves to the
// previous day east of UTC. A child process per time zone builds the console pool and parses a `date` value with
// the parser the pool hands its clients; the result must be the stored day in every zone.
{
  const probe = `
    import { register } from "node:module";
    register(${JSON.stringify(pathToFileURL(path.join(root, "scripts", "lib", "console-ts-loader.mjs")).href)});
    const pg = (await import("pg")).default;
    const database = await import(${JSON.stringify(pathToFileURL(path.join(root, "apps", "console", "lib", "database.ts")).href)});
    const pool = database.createDatabasePool({ connectionString: process.env.DATABASE_URL, timeoutMs: 200 });
    const parse = (types) => types.getTypeParser(1082, "text")("2027-03-31");
    const day = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : value;
    const observed = { defaultDay: day(parse(pg.types)), poolValue: day(parse(pool.options.types ?? pg.types)), poolValueType: typeof parse(pool.options.types ?? pg.types) };
    await pool.end();
    process.stdout.write(JSON.stringify(observed));
  `;
  for (const [timeZone, defaultDay] of [["Asia/Shanghai", "2027-03-30"], ["UTC", "2027-03-31"]]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: root, encoding: "utf8", env: { ...process.env, TZ: timeZone, DATABASE_URL: databaseUrl, CONTROL_PLANE_DEMO_MODE: "false" } });
    assert.equal(result.status, 0, `the ${timeZone} date probe failed: ${result.stderr}`);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.defaultDay, defaultDay, `the ${timeZone} probe must see the node-postgres default date parser in that zone`);
    assert.deepEqual({ poolValue: observed.poolValue, poolValueType: observed.poolValueType }, { poolValue: "2027-03-31", poolValueType: "string" }, `the console pool must return a PostgreSQL date as its YYYY-MM-DD text under TZ=${timeZone}`);
  }
}

console.log("PASS  console database pool returns PostgreSQL dates as YYYY-MM-DD text under TZ=Asia/Shanghai and TZ=UTC");

// Lifecycle arm and START read their preflight inputs on the transaction that
// already holds the locked run. A fake pool counts checkouts; a fake client
// serves the locked run and rejects overlapping queries on one connection.
const store = await import("../apps/console/lib/control-plane/store.ts");
const tenantId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const operatorContext = { tenantId, actorId: "preflight-check", actorName: "Preflight Check", role: "operator", accessScope: "tenant" };

function preflightClient(state, { failOn } = {}) {
  const client = fakeClient();
  client.statements = [];
  let inFlight = 0;
  client.query = async (sql) => {
    if (inFlight > 0) throw new Error("preflight issued concurrent queries on one connection");
    inFlight += 1;
    try {
      client.statements.push(sql);
      await new Promise((resolve) => setImmediate(resolve));
      if (failOn && sql.includes(failOn)) throw new Error(`injected failure for ${failOn}`);
      if (sql.includes("from live_runs r left join show_revision_overlays")) return { rows: [{ tenant_id: tenantId, run_revision_id: "00000000-0000-4000-8000-000000000003", show_revision_id: "00000000-0000-4000-8000-000000000003", background_mode: null, scene_json: null, scene_sha256: null, background_approval: null, background_expires_at: null, price_valid_until: null }] };
      if (sql.includes("for update of r")) return { rows: [{ id: runId, tenant_id: tenantId, show_revision_id: "00000000-0000-4000-8000-000000000003", show_name: "Preflight check", state, trace_id: "trace", channel_connection_id: "00000000-0000-4000-8000-000000000004", product_version_id: "00000000-0000-4000-8000-000000000005", has_operator: true, rights_approved: true, has_approved_sku_version: true, has_fallback_program: true, channel_ready: true, output_ready: true, ai_disclosure_enabled: true, runtime_session_id: "session-preflight-check", scheduled_at: null, active_program_segment_id: null, active_insert_source_segment_id: null, active_insert_program_segment_id: null, pending_program_transition_event_id: null }] };
      if (sql.includes("select id from live_runs where id = $1::uuid")) return { rows: [{ id: runId }] };
      return { rows: [] };
    } finally {
      inFlight -= 1;
    }
  };
  return client;
}

async function withCountingPool(client, action) {
  const previous = globalThis.shuzhirenDatabasePool;
  let connects = 0;
  globalThis.shuzhirenDatabasePool = { connect: async () => { connects += 1; if (connects > 1) throw new Error("preflight took a second pooled connection"); return client; } };
  try { await action(); } finally { globalThis.shuzhirenDatabasePool = previous; }
  return connects;
}

const rejectedPreflight = (error) => error instanceof Response && error.status === 409;
{
  const client = preflightClient("PREFLIGHT");
  const connects = await withCountingPool(client, () => assert.rejects(store.advanceRunLifecycle(operatorContext, runId, "arm"), rejectedPreflight));
  assert.equal(connects, 1, "arm must evaluate preflight on its own transaction connection");
  assert.ok(client.statements.some((sql) => sql.includes("from runtime_health_samples")), "arm must read runtime readiness inside its transaction");
  assert.ok(client.statements.some((sql) => sql.includes("from interaction_rules where default_key = 'ai_disclosure'")), "arm must read the AI disclosure rule inside its transaction");
  assert.ok(client.statements.includes("rollback"), "a failed arm preflight must roll back");
}
{
  const client = preflightClient("ARMED");
  const connects = await withCountingPool(client, () => assert.rejects(store.issueCommand(operatorContext, runId, { action: "START", expectedState: "ARMED", idempotencyKey: "preflight-check-start" }), rejectedPreflight));
  assert.equal(connects, 1, "START must evaluate preflight on its own transaction connection");
  assert.ok(client.statements.some((sql) => sql.includes("from show_revision_model_releases")), "START must read frozen releases inside its transaction");
  assert.ok(client.statements.some((sql) => sql.includes("from interaction_rules where default_key = 'ai_disclosure'")), "START must read the AI disclosure rule inside its transaction");
}

console.log("PASS  lifecycle arm and START evaluate preflight on their transaction connection without nested pool checkouts");

// AIGC explicit label (人工智能生成合成内容标识办法): preflight blocks arm and START unless the Runtime Gateway health
// reports LiveTalking's label enabled with the run's text; every other answer is fail closed.
if (!preflightSection.includes("aiDisclosureRuleReady: aiDisclosureRule.passed") || !preflightSection.includes("aiDisclosureRuleStatusInTransaction(client)")) throw new Error("Preflight must read the AI disclosure rule on the caller's transaction client and feed aiDisclosureRuleReady");
if (!preflightSection.includes("aigcLabelReady: aigcLabel.passed") || !preflightSection.includes("evaluateAigcLabelReadiness(await frozenAigcLabelTextInTransaction(client, run.id) ?? aigcLabelText())")) throw new Error("Preflight must evaluate the AIGC label against the run's sealed label text");
{
  const { evaluatePreflight } = await import("../apps/console/lib/control-plane/preflight.ts");
  const aigc = await import("../apps/console/lib/aigc-label.ts");
  const expected = { text: "本直播由AI数字人生成", contentProducer: "Fixture Operator" };
  const health = (label) => ({ status: "ok", dependencies: { livetalking: { available: true, ...(label === undefined ? {} : { aigc_label: label }) } } });
  const enabled = { enabled: true, reported: true, text: expected.text, position: "top-right", frames_labelled: 250, last_error: null };
  assert.deepEqual(aigc.evaluateAigcLabelReport(health(enabled), expected), { passed: true, detail: "画面标识「本直播由AI数字人生成」已启用 · top-right · 已标识 250 帧" });
  for (const [name, report, detail] of [
    ["disabled", health({ ...enabled, enabled: false, last_error: "font_missing" }), /未启用 AIGC 画面标识（font_missing）/],
    ["enabled as a string", health({ ...enabled, enabled: "true" }), /未启用 AIGC 画面标识/],
    ["no label report (image without the patch)", health(undefined), /运行时未报告 AIGC 标识状态/],
    ["different text", health({ ...enabled, text: "AI生成" }), /文字与场次登记的 AIGC 标识文字不一致/],
    ["no health body", null, /运行时未报告 AIGC 标识状态/],
    ["status demo from a Gateway", { status: "demo" }, /运行时未报告 AIGC 标识状态/]
  ]) {
    const result = aigc.evaluateAigcLabelReport(report, expected);
    assert.equal(result.passed, false, `${name} must block preflight`);
    assert.match(result.detail, detail, name);
  }
  assert.match(aigc.evaluateAigcLabelReport(health(enabled), { ...expected, contentProducer: null }).detail, /未配置 AIGC_CONTENT_PRODUCER/);
  assert.equal(aigc.evaluateAigcLabelReport(health({ ...enabled, text: "欢迎" }), { ...expected, text: "欢迎" }).passed, false, "a label text that does not say AI blocks");
  const base = { hasApprovedRights: true, rightsDetail: "", hasApprovedModelReleases: true, modelReleaseDetail: "", hasApprovedPolicyProfile: true, policyProfileDetail: "", hasOperator: true, hasApprovedSkuVersion: true, skuDetail: "", hasFallbackProgram: true, channelReady: true, channelDetail: "", outputReady: true, outputDetail: "", runtimeSessionReady: true, runtimeSessionDetail: "", aiDisclosureEnabled: true, aiDisclosureRuleReady: true, aiDisclosureRuleDetail: "ok", overlayReady: true, overlayDetail: "未启用画面层" };
  assert.equal(evaluatePreflight({ ...base, aigcLabelReady: true, aigcLabelDetail: "ok" }).passed, true);
  const blocked = evaluatePreflight({ ...base, aigcLabelReady: false, aigcLabelDetail: "LiveTalking 未启用 AIGC 画面标识" });
  assert.equal(blocked.passed, false, "a disabled AIGC label must block arm and START");
  assert.deepEqual(blocked.checks.find((check) => check.id === "aigc_label"), { id: "aigc_label", label: "AIGC 标识已启用", status: "blocked", detail: "LiveTalking 未启用 AIGC 画面标识" });
  const overlayBlocked = evaluatePreflight({ ...base, aigcLabelReady: true, aigcLabelDetail: "ok", overlayReady: false, overlayDetail: "画面层配置未冻结或已损坏" });
  assert.deepEqual(overlayBlocked.checks.find((check) => check.id === "overlay"), { id: "overlay", label: "画面层", status: "blocked", detail: "画面层配置未冻结或已损坏" });
  assert.equal(aigc.aigcLabelMetadata("00000000-0000-4000-8000-000000000002").contentId, "live-run:00000000-0000-4000-8000-000000000002");

  // Through a Gateway: 200 and 503 (degraded) bodies are evaluated, anything else or no answer blocks.
  const answers = [];
  const gateway = http.createServer((request, response) => {
    const [status, body] = answers.shift() ?? [500, {}];
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const saved = { url: process.env.RUNTIME_GATEWAY_URL, demo: process.env.RUNTIME_GATEWAY_DEMO_MODE, producer: process.env.AIGC_CONTENT_PRODUCER };
  process.env.RUNTIME_GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
  process.env.RUNTIME_GATEWAY_DEMO_MODE = "false";
  process.env.AIGC_CONTENT_PRODUCER = expected.contentProducer;
  try {
    answers.push([200, health(enabled)]);
    assert.equal((await aigc.evaluateAigcLabelReadiness(expected.text)).passed, true, "an enabled label with the run's text passes");
    answers.push([503, { ...health(enabled), status: "degraded" }]);
    assert.equal((await aigc.evaluateAigcLabelReadiness(expected.text)).passed, true, "a degraded Gateway still reports the label");
    answers.push([503, { ...health({ ...enabled, enabled: false }), status: "degraded" }]);
    assert.equal((await aigc.evaluateAigcLabelReadiness(expected.text)).passed, false);
    answers.push([500, health(enabled)]);
    assert.match((await aigc.evaluateAigcLabelReadiness(expected.text)).detail, /无法读取 Runtime Gateway 健康状态/, "a failing Gateway blocks");
    await new Promise((resolve) => gateway.close(resolve));
    assert.equal((await aigc.evaluateAigcLabelReadiness(expected.text)).passed, false, "an unreachable Gateway blocks");
  } finally {
    if (gateway.listening) await new Promise((resolve) => gateway.close(resolve));
    for (const [key, value] of [["RUNTIME_GATEWAY_URL", saved.url], ["RUNTIME_GATEWAY_DEMO_MODE", saved.demo], ["AIGC_CONTENT_PRODUCER", saved.producer]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

console.log("PASS  preflight blocks arm and START unless the Gateway reports the AIGC label enabled with the run's sealed text (fail closed)");

// AI identity disclosure rule (interaction rule default_key ai_disclosure): arm and START need an enabled, approved,
// correctly shaped rule; a missing rule or a failed read never counts as passed.
{
  const { evaluatePreflight } = await import("../apps/console/lib/control-plane/preflight.ts");
  const rules = await import("../apps/console/lib/interaction-rules.ts");
  const valid = { enabled: true, approval_status: "approved", trigger_type: "timed", action: "speak", live_run_id: null, interval_seconds: 600 };
  assert.deepEqual(rules.evaluateAiDisclosureRule(valid), { passed: true, detail: "已批准，每 600 秒口播一次" });
  for (const [name, row, detail] of [
    ["no rule", null, "未创建 AI 身份提示规则（在\"互动规则\"页一键创建默认规则并审批）"],
    ["disabled", { ...valid, enabled: false }, "AI 身份提示规则未启用"],
    ["pending approval", { ...valid, approval_status: "pending" }, "AI 身份提示规则待审批"],
    ["bound to one run", { ...valid, live_run_id: "00000000-0000-4000-8000-000000000002" }, "AI 身份提示规则形状无效"],
    ["not timed", { ...valid, trigger_type: "idle_comment" }, "AI 身份提示规则形状无效"],
    ["not speak", { ...valid, action: "reply_draft" }, "AI 身份提示规则形状无效"],
    ["interval below 60", { ...valid, interval_seconds: 59 }, "AI 身份提示规则形状无效"],
    ["interval above 1800", { ...valid, interval_seconds: 1801 }, "AI 身份提示规则形状无效"],
    ["interval missing", { ...valid, interval_seconds: null }, "AI 身份提示规则形状无效"]
  ]) assert.deepEqual(rules.evaluateAiDisclosureRule(row), { passed: false, detail }, name);

  const base = { hasApprovedRights: true, rightsDetail: "", hasApprovedModelReleases: true, modelReleaseDetail: "", hasApprovedPolicyProfile: true, policyProfileDetail: "", hasOperator: true, hasApprovedSkuVersion: true, skuDetail: "", hasFallbackProgram: true, channelReady: true, channelDetail: "", outputReady: true, outputDetail: "", runtimeSessionReady: true, runtimeSessionDetail: "", aiDisclosureEnabled: true, aigcLabelReady: true, aigcLabelDetail: "ok", overlayReady: true, overlayDetail: "未启用画面层" };
  const blocked = evaluatePreflight({ ...base, aiDisclosureRuleReady: false, aiDisclosureRuleDetail: "AI 身份提示规则待审批" });
  assert.equal(blocked.passed, false, "an unready AI disclosure rule must block arm and START");
  assert.deepEqual(blocked.checks.find((check) => check.id === "ai_disclosure_rule"), { id: "ai_disclosure_rule", label: "AI 身份口播规则", status: "blocked", detail: "AI 身份提示规则待审批" });
  const ids = blocked.checks.map((check) => check.id);
  assert.equal(ids.indexOf("ai_disclosure_rule"), ids.indexOf("disclosure") + 1, "the check follows disclosure");
  assert.equal(ids.indexOf("aigc_label"), ids.indexOf("ai_disclosure_rule") + 1, "the check precedes aigc_label");
  assert.equal(ids.indexOf("overlay"), ids.indexOf("aigc_label") + 1, "overlay follows the AIGC label check");
  const passed = evaluatePreflight({ ...base, aiDisclosureRuleReady: true, aiDisclosureRuleDetail: "已批准，每 600 秒口播一次" });
  assert.equal(passed.checks.find((check) => check.id === "ai_disclosure_rule").status, "passed");

  // A failing read throws out of arm and START (the transaction rolls back); it is never reported as passed or as a 409.
  for (const [action, state] of [["arm", "PREFLIGHT"], ["START", "ARMED"]]) {
    const client = preflightClient(state, { failOn: "from interaction_rules where default_key = 'ai_disclosure'" });
    const connects = await withCountingPool(client, () => assert.rejects(
      action === "arm" ? store.advanceRunLifecycle(operatorContext, runId, "arm") : store.issueCommand(operatorContext, runId, { action: "START", expectedState: "ARMED", idempotencyKey: `preflight-check-rule-read-${action}` }),
      (error) => error instanceof Error && !(error instanceof Response) && /injected failure/.test(error.message),
      `${action} must surface the failed AI disclosure rule read`
    ));
    assert.equal(connects, 1);
    assert.ok(client.statements.includes("rollback"), `a failed rule read must roll back ${action}`);
  }
}

console.log("PASS  preflight blocks arm and START without an approved AI disclosure rule and fails closed when it cannot be read");
