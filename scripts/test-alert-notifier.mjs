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

function readStatements(logFile) {
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
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
