import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "apps", "console", "lib", "control-plane", "store.ts"), "utf8");
const preflightSection = source.slice(source.indexOf("export async function evaluateRunPreflight"), source.indexOf("export async function degradeRunFromRuntime"));

if (!preflightSection.includes("outputReady: runtime.passed")) throw new Error("Preflight must use fresh runtime telemetry as the output readiness source");
if (preflightSection.includes("run.outputReady && runtime.passed")) throw new Error("Legacy output_ready flag must not permanently block a healthy runtime");

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

function preflightClient(state) {
  const client = fakeClient();
  client.statements = [];
  let inFlight = 0;
  client.query = async (sql) => {
    if (inFlight > 0) throw new Error("preflight issued concurrent queries on one connection");
    inFlight += 1;
    try {
      client.statements.push(sql);
      await new Promise((resolve) => setImmediate(resolve));
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
  assert.ok(client.statements.includes("rollback"), "a failed arm preflight must roll back");
}
{
  const client = preflightClient("ARMED");
  const connects = await withCountingPool(client, () => assert.rejects(store.issueCommand(operatorContext, runId, { action: "START", expectedState: "ARMED", idempotencyKey: "preflight-check-start" }), rejectedPreflight));
  assert.equal(connects, 1, "START must evaluate preflight on its own transaction connection");
  assert.ok(client.statements.some((sql) => sql.includes("from show_revision_model_releases")), "START must read frozen releases inside its transaction");
}

console.log("PASS  lifecycle arm and START evaluate preflight on their transaction connection without nested pool checkouts");
