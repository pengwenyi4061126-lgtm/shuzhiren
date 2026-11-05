import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { alertPayload, matchingSeverities, parseTargets, retryDelayMs, signWebhook, verifyWebhook } from "../apps/alert-notifier/lib.mjs";

const tenantId = "b783df8e-8456-44fa-9f04-e50429eac7a3";
const targets = parseTargets(JSON.stringify([{ id: "oncall-critical", tenantId, webhookUrl: "https://alerts.example.com/hook", signingSecret: "notification-signing-secret-at-least-32-chars", minimumSeverity: "critical" }]));
assert.equal(targets.length, 1);
assert.throws(() => parseTargets(JSON.stringify([{ id: "oncall", tenantId, webhookUrl: "http://alerts.example.com/hook", signingSecret: "notification-signing-secret-at-least-32-chars" }])), /HTTPS/);
const payload = alertPayload({ id: "delivery-1", alert_id: "alert-1", live_run_id: "run-1", severity: "critical", code: "stream_disconnected", message: "Output disconnected", opened_at: "2026-11-02T00:00:00.000Z" });
assert.equal(payload.eventType, "runtime_alert.opened");
assert.equal(payload.alert.severity, "critical");
const raw = JSON.stringify(payload);
const signed = signWebhook(raw, targets[0].signingSecret, "1793577600");
assert.equal(verifyWebhook(raw, targets[0].signingSecret, signed.timestamp, signed.signature), true);
assert.equal(verifyWebhook(`${raw}x`, targets[0].signingSecret, signed.timestamp, signed.signature), false);
assert.equal(retryDelayMs(1, 1000, 60_000), 1000);
assert.equal(retryDelayMs(3, 1000, 60_000), 4000);
assert.equal(retryDelayMs(20, 1000, 60_000), 60_000);
assert.deepEqual(matchingSeverities("critical"), ["critical"]);
assert.deepEqual(matchingSeverities("warning"), ["warning", "critical"]);
console.log("PASS  alert notifier validates targets, signs payloads, and bounds retry delay");

// The scenarios below run apps/alert-notifier/index.mjs as a child process. `pg` resolves to
// scripts/fixtures/alert-notifier/fake-pg.mjs, which reproduces the PostgreSQL behavior each scenario needs
// and logs every statement the notifier sends.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const notifier = path.join(root, "apps", "alert-notifier", "index.mjs");
const registerFakePg = pathToFileURL(path.join(root, "scripts", "fixtures", "alert-notifier", "register-fake-pg.mjs")).href;
const signingSecret = "notification-signing-secret-at-least-32-chars";
const exitTimeoutMs = 5_000;
const outputTailChars = 2_000;

// C3: the enqueue statement passed the tenant id as $1 without referencing it, and PostgreSQL rejects such a
// statement with 42P18, so every polling cycle failed before any delivery. A cycle must now complete without a
// database error, the enqueue must filter by the target's tenant, and every parameter must carry an explicit type.
await withNotifier({ targetId: "oncall-warning", minimumSeverity: "warning" }, async (run) => {
  let health = null;
  await waitFor(async () => {
    health = await getHealth(run.port);
    return health.status === 200;
  }, 5_000, () => `/healthz to return 200 after a polling cycle; last response: ${JSON.stringify(health)}`);
  assert.equal(health.body.ok, true);
  assert.equal(typeof health.body.lastSuccessfulTickAt, "string");
  assert.equal(health.body.lastError, null);
  const statements = readStatements(run.logFile);
  assert.deepEqual(statements.filter((statement) => statement.error), [], "no statement of a polling cycle may fail");
  const enqueue = statements.find((statement) => statement.sql.startsWith("insert into alert_notification_deliveries"));
  assert.ok(enqueue, "a polling cycle must run the enqueue statement");
  assert.deepEqual(enqueue.values, [tenantId, "oncall-warning", ["warning", "critical"]]);
  assert.match(enqueue.sql, /\bwhere a\.tenant_id = \$1::uuid and /, "enqueue must select only alerts of the target's tenant");
  assert.match(enqueue.sql, /\bselect a\.tenant_id, a\.id, \$2::text from runtime_alerts a\b/);
  assert.match(enqueue.sql, /\ba\.severity = any\(\$3::alert_severity\[\]\)/);
  for (const statement of statements) {
    for (let index = 1; index <= statement.values.length; index += 1) {
      assert.match(statement.sql, new RegExp(`\\$${index}::`), `parameter $${index} must have an explicit type: ${statement.sql}`);
    }
  }
});
console.log("PASS  alert notifier completes a polling cycle with tenant-filtered, explicitly typed SQL (C3)");

// N3: pg times the wait for a connection and the query separately, each up to DATABASE_QUERY_TIMEOUT_MS, so the
// /healthz connectivity check could take almost twice that long. The whole check must now end within one timeout.
await withNotifier({ env: { DATABASE_QUERY_TIMEOUT_MS: "1000" }, scenario: { poolQuery: { connectDelayMs: 900, queryDelayMs: null } } }, async (run) => {
  const started = Date.now();
  const health = await getHealth(run.port);
  const elapsed = Date.now() - started;
  assert.equal(health.status, 503);
  assert.equal(health.body.ok, false);
  assert.ok(elapsed < 1_500, `/healthz must answer within DATABASE_QUERY_TIMEOUT_MS (1000 ms) plus scheduling slack, but took ${elapsed} ms`);
});
await withNotifier({ env: { DATABASE_QUERY_TIMEOUT_MS: "1000" }, scenario: { poolQuery: { connectDelayMs: 300, queryDelayMs: 300 } } }, async (run) => {
  let health = null;
  await waitFor(async () => {
    health = await getHealth(run.port);
    return health.status === 200;
  }, 5_000, () => `/healthz to return 200 when the database answers within the timeout; last response: ${JSON.stringify(health)}`);
});
const lib = await import("../apps/alert-notifier/lib.mjs");
assert.equal(typeof lib.withDeadline, "function", "lib.mjs must export withDeadline");
{
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const started = Date.now();
  await assert.rejects(lib.withDeadline(new Promise(() => {}), 50), { message: "deadline_exceeded" });
  assert.ok(Date.now() - started < 1_000, "withDeadline must reject a promise that never settles once the deadline passes");
  assert.equal(await lib.withDeadline(Promise.resolve("value"), 50), "value");
  await assert.rejects(lib.withDeadline(Promise.reject(new Error("query failed")), 50), { message: "query failed" });
  const late = new Promise((_, reject) => setTimeout(() => reject(new Error("late failure")), 30));
  await assert.rejects(lib.withDeadline(late, 5), { message: "deadline_exceeded" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, [], "a rejection after the deadline must not be left unhandled");
}
console.log("PASS  alert notifier bounds the whole /healthz connectivity check by DATABASE_QUERY_TIMEOUT_MS (N3)");

// N4: claim only takes deliveries with attempts below ALERT_NOTIFIER_MAX_ATTEMPTS and sets them to delivering. When
// the process stopped after claiming the final attempt, the delivery stayed delivering forever. The claim transaction
// must first mark such deliveries failed once their lease has expired, and leave every other delivery alone.
{
  const otherTenantId = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const delivering = { tenant_id: tenantId, target_id: "oncall-critical", state: "delivering", attempts: 3, leaseOffsetMs: -60_000 };
  const deliveries = [
    { ...delivering, id: "final-attempt-lease-expired" },
    { ...delivering, id: "final-attempt-lease-active", leaseOffsetMs: 60_000 },
    { ...delivering, id: "earlier-attempt-lease-expired", attempts: 2 },
    { ...delivering, id: "other-target", target_id: "oncall-other" },
    { ...delivering, id: "other-tenant", tenant_id: otherTenantId }
  ];
  await withNotifier({ env: { ALERT_NOTIFIER_MAX_ATTEMPTS: "3" }, scenario: { deliveries } }, async (run) => {
    // Every polling cycle commits the enqueue transaction and then the claim transaction.
    await waitFor(() => readCommits(run.logFile).length >= 2, 5_000, () => "the first polling cycle to commit its claim transaction");
    const statements = readStatements(run.logFile);
    assert.deepEqual(statements.filter((statement) => statement.error), [], "no statement of a polling cycle may fail");
    const rows = new Map(readCommits(run.logFile).at(-1).committed.map((row) => [row.id, row]));
    const swept = rows.get("final-attempt-lease-expired");
    assert.equal(swept.state, "failed", "a delivery whose final attempt's lease expired must not stay delivering");
    assert.equal(swept.last_error, "lease expired after final attempt");
    assert.equal(swept.lease_expires_at, null);
    assert.equal(swept.attempts, 3);
    for (const id of ["final-attempt-lease-active", "earlier-attempt-lease-expired", "other-target", "other-tenant"]) {
      const row = rows.get(id);
      const seeded = deliveries.find((delivery) => delivery.id === id);
      assert.deepEqual({ state: row.state, attempts: row.attempts, last_error: row.last_error }, { state: "delivering", attempts: seeded.attempts, last_error: null }, `delivery ${id} must be left alone`);
    }
    const claim = statements.find((statement) => statement.sql.startsWith("select d.id,"));
    const transaction = statements.filter((statement) => statement.client === claim.client);
    assert.deepEqual(transaction.map((statement) => statement.sql.split(" ").slice(0, 2).join(" ")), ["begin", "select set_config('app.tenant_id',", "update alert_notification_deliveries", "select d.id,", "commit"], "the sweep must run inside the claim transaction, before the claim");
    assert.deepEqual(transaction[2].values, [tenantId, "oncall-critical", 3]);
  });
}
console.log("PASS  alert notifier fails deliveries whose final attempt's lease expired (N4)");

// M3: pg-pool emits "error" when an idle connection is terminated; without a listener the notifier exited.
// This scenario runs the real `pg` package against a fake PostgreSQL server instead of fake-pg.mjs.
{
  const { assertSurvivesIdleConnectionTermination } = await import("./fixtures/pool-error-scenario.mjs");
  await assertSurvivesIdleConnectionTermination({
    name: "alert notifier",
    entry: notifier,
    cwd: root,
    portVariable: "ALERT_NOTIFIER_PORT",
    env: {
      ALERT_NOTIFIER_POLL_MS: "60000",
      DATABASE_QUERY_TIMEOUT_MS: "2000",
      ALERT_NOTIFIER_TARGETS: JSON.stringify([{ id: "oncall-critical", tenantId, webhookUrl: "https://alerts.example.com/hook", signingSecret, minimumSeverity: "critical" }])
    }
  });
}
console.log("PASS  alert notifier survives the termination of idle database connections and logs the pool error (M3)");

async function withNotifier({ targetId = "oncall-critical", minimumSeverity = "critical", env = {}, scenario = {} }, body) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "alert-notifier-test-"));
  const logFile = path.join(directory, "statements.jsonl");
  const port = await availablePort();
  const child = spawn(process.execPath, ["--import", registerFakePg, notifier], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://alert_notifier:unused@127.0.0.1:1/shuzhiren",
      ALERT_NOTIFIER_PORT: String(port),
      ALERT_NOTIFIER_POLL_MS: "50",
      ALERT_NOTIFIER_TARGETS: JSON.stringify([{ id: targetId, tenantId, webhookUrl: "https://alerts.example.com/hook", signingSecret, minimumSeverity }]),
      FAKE_PG_LOG: logFile,
      FAKE_PG_SCENARIO: JSON.stringify(scenario),
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const run = { child, port, logFile, output: "", exited: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))) };
  const keep = (chunk) => { run.output = (run.output + chunk.toString("utf8")).slice(-outputTailChars); };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  try {
    await waitFor(() => run.output.includes(`alert-notifier listening on ${port}`) || hasExited(child), 5_000, () => "the notifier to listen");
    if (hasExited(child)) throw new Error("alert notifier exited during startup");
    assert.ok(existsSync(logFile), "the notifier must load the fake pg module");
    return await body(run);
  } catch (error) {
    console.error(`alert notifier ${hasExited(child) ? `exited with code ${child.exitCode}` : "still running"}; last output:\n${run.output || "(none)"}`);
    throw error;
  } finally {
    await stopNotifier(run);
    await rm(directory, { recursive: true, force: true });
  }
}

async function stopNotifier(run) {
  if (!hasExited(run.child)) run.child.kill("SIGTERM");
  let timer;
  const exit = await Promise.race([run.exited, new Promise((resolve) => { timer = setTimeout(() => resolve(null), exitTimeoutMs); })]);
  clearTimeout(timer);
  if (exit) return;
  run.child.kill("SIGKILL");
  await run.exited;
  throw new Error(`alert notifier did not exit within ${exitTimeoutMs} ms after SIGTERM`);
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function getHealth(port) {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
}

// Entries of the fake pg log. The text after the last newline may be a line the notifier is still writing.
function readLog(logFile) {
  return readFileSync(logFile, "utf8").split("\n").slice(0, -1).map((line) => JSON.parse(line));
}

function readStatements(logFile) {
  return readLog(logFile).filter((entry) => "sql" in entry);
}

function readCommits(logFile) {
  return readLog(logFile).filter((entry) => "committed" in entry);
}

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve alert notifier port");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitFor(predicate, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
