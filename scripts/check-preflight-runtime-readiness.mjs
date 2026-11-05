import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
