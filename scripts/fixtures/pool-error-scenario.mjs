// M3 regression scenario shared by the runtime worker, channel adapter and alert notifier tests.
//
// The service runs with the real `pg` package against scripts/fixtures/fake-postgres-server.mjs. Once it has
// served a healthy /healthz (so pg-pool holds an idle connection), the fake server terminates every connection
// the way pg_terminate_backend does. pg-pool then emits "error"; without a listener the process exits. The
// service must log database.pool_error, keep running, and answer the next /healthz from a new connection.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { startFakePostgres } from "./fake-postgres-server.mjs";

export async function assertSurvivesIdleConnectionTermination({ name, entry, cwd, env, portVariable }) {
  const database = await startFakePostgres();
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, ...env, DATABASE_URL: database.url, [portVariable]: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const running = () => child.exitCode === null && child.signalCode === null;
  try {
    await waitFor(async () => running() && (await health(port)) === 200, 10_000, `${name} to report healthy against the fake database`);
    await waitFor(() => database.openConnections > 0, 5_000, `${name} to keep an idle database connection`);
    assert.ok(database.terminateAll() > 0, "the scenario must terminate at least one idle connection");
    await waitFor(() => output.includes('"event":"database.pool_error"') || !running(), 10_000, `${name} to log database.pool_error`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(running(), true, `${name} must survive the termination of an idle database connection`);
    assert.match(output, /"event":"database\.pool_error".*"code":"57P01"/, `${name} must log the pool error with its SQLSTATE`);
    assert.doesNotMatch(output, /fake-password/, `${name} must not log the database password`);
    const before = database.totalConnections;
    await waitFor(async () => (await health(port)) === 200, 10_000, `${name} to report healthy again after the termination`);
    assert.ok(database.totalConnections > before, `${name} must open a new database connection after the old one was terminated`);
    assert.equal(running(), true);
  } catch (error) {
    console.error(`${name} ${running() ? "still running" : `exited with code ${child.exitCode}`}; output:\n${output.slice(-3_000) || "(none)"}`);
    throw error;
  } finally {
    if (running()) child.kill("SIGKILL");
    await exited;
    await database.close();
  }
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return null;
  }
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
