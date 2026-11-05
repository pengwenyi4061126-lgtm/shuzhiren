// L7 regression scenarios shared by the channel adapter and output probe tests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";

// installGracefulShutdown against a real HTTP server, with an emitter standing in for `process` so the scenario
// also runs on Windows, where sending SIGTERM to a child process terminates it without running handlers.
export async function assertGracefulShutdownBehaviour(installGracefulShutdown, name) {
  {
    const run = await start(installGracefulShutdown, (request, response) => response.end("ok"));
    assert.equal((await fetch(run.url)).status, 200);
    run.emitter.emit("SIGTERM");
    run.emitter.emit("SIGTERM");
    await waitFor(() => run.exits.length > 0, 2_000, `${name} to exit when idle`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(run.exits, [0], `${name} must exit 0 once, even after a repeated signal`);
    assert.deepEqual(run.events(), ["shutdown_started", "cleanup", "shutdown_complete"]);
    await assert.rejects(fetch(run.url, { signal: AbortSignal.timeout(1_000) }), `${name} must stop accepting connections`);
  }
  {
    let shutdown;
    let downstreamAborted = false;
    const run = await start(installGracefulShutdown, async (request, response) => {
      await new Promise((resolve) => shutdown.signal.addEventListener("abort", resolve, { once: true }));
      downstreamAborted = true;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "shutting_down" }));
    }, (handle) => { shutdown = handle; });
    const inFlight = fetch(run.url).then(async (response) => ({ status: response.status, body: await response.json() }), (error) => ({ error }));
    await waitFor(() => run.inflight() === 1, 2_000, `${name} to receive the in-flight request`);
    const signalledAt = Date.now();
    run.emitter.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(fetch(run.url, { signal: AbortSignal.timeout(1_000) }), `${name} must refuse new connections while draining`);
    assert.equal(downstreamAborted, false, `${name} must let an in-flight request run during the grace period`);
    assert.deepEqual(await inFlight, { status: 503, body: { error: "shutting_down" } }, `${name} must answer an aborted in-flight request`);
    await waitFor(() => run.exits.length > 0, 3_000, `${name} to exit after aborting the in-flight request`);
    assert.ok(Date.now() - signalledAt >= run.graceMs, `${name} must wait for the grace period before aborting`);
    assert.deepEqual(run.exits, [0]);
    assert.deepEqual(run.events(), ["shutdown_started", "shutdown_aborting", "cleanup", "shutdown_complete"]);
  }
}

// The real service process: SIGTERM must end it by itself (signal null, exit code 0) well within Docker's 10 s
// stop timeout. On Windows a child cannot receive SIGTERM without being terminated, so the signal is emitted
// inside the child by scripts/fixtures/emulate-signal.mjs; on Linux (CI) it is a real signal.
export async function assertProcessExitsOnSigterm({ name, args, env, cwd, portVariable }) {
  const emulated = process.platform === "win32";
  const port = await freePort();
  const preload = emulated ? ["--import", new URL("./emulate-signal.mjs", import.meta.url).href] : [];
  const child = spawn(process.execPath, [...preload, ...args], { cwd, env: { ...process.env, ...env, [portVariable]: String(port) }, stdio: [emulated ? "pipe" : "ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    await waitFor(async () => child.exitCode === null && await fetch(`http://127.0.0.1:${port}/healthz`).then(() => true, () => false), 10_000, `${name} to listen`);
    const signalledAt = Date.now();
    if (emulated) child.stdin.write("SIGTERM\n");
    else child.kill("SIGTERM");
    const exit = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 10_000))]);
    assert.ok(exit, `${name} must exit within 10 s of SIGTERM; output:\n${output}`);
    assert.deepEqual(exit, { code: 0, signal: null }, `${name} must exit by itself with code 0; output:\n${output}`);
    assert.ok(Date.now() - signalledAt < 10_000);
    assert.match(output, /"event":"shutdown_started"[\s\S]*"event":"shutdown_complete"/);
    return emulated ? "emulated signal" : "real signal";
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
}

async function start(installGracefulShutdown, handler, onInstalled = () => {}) {
  const server = http.createServer(handler);
  const emitter = new EventEmitter();
  const exits = [];
  const logged = [];
  const graceMs = 300;
  let inflight = 0;
  server.on("request", (request, response) => { inflight += 1; response.once("close", () => { inflight -= 1; }); });
  onInstalled(installGracefulShutdown({ server, emitter, exit: (code) => exits.push(code), log: (event) => logged.push(event), cleanup: async () => logged.push("cleanup"), graceMs, cleanupMs: 500 }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, emitter, exits, graceMs, events: () => [...logged], inflight: () => inflight };
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
