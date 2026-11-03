import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const observer = path.join(root, "apps", "runtime-observer", "index.mjs");
const telemetryToken = "observer-tenant-token-at-least-16";
const gatewayToken = "gateway-shared-token-at-least-16";
const observerPort = 18084;

async function startServer(probeMode) {
  const samples = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/v1/observations/session_demo") {
      assert.equal(request.headers.authorization, `Bearer ${gatewayToken}`);
      return json(response, 200, { session: { id: "session_demo", active: true }, gpu: { available: true, utilization_percent: 71, memory_used_mib: 14200 }, quality: { writer_accepting_frames: true, inference_fps: 28.5 } });
    }
    if (url.pathname === "/probe") {
      if (probeMode === "unavailable") return json(response, 503, { error: "probe_unavailable" });
      return json(response, 200, { outputConnected: true, outputFps: 25, avSyncMs: 19, bitrateMbps: 4.1, audioActive: probeMode !== "silent", fallbackReady: true });
    }
    if (url.pathname === "/api/v1/runtime/telemetry" && request.method === "POST") {
      assert.equal(request.headers.authorization, `Bearer ${telemetryToken}`);
      if (probeMode === "telemetry_unavailable") return json(response, 503, { error: "telemetry_unavailable" });
      samples.push(await requestBody(request));
      return json(response, 202, { data: { accepted: true } });
    }
    return json(response, 404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return { server, samples, baseUrl: `http://127.0.0.1:${address.port}` };
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function observeOnce(probeMode) {
  const fixture = await startServer(probeMode);
  const targets = JSON.stringify([{ tenantId: "tenant_demo", runId: "run_demo", sessionId: "session_demo", telemetryToken, outputProbeUrl: `${fixture.baseUrl}/probe` }]);
  const child = spawn(process.execPath, [observer], {
    cwd: root,
    env: { ...process.env, CONTROL_PLANE_URL: fixture.baseUrl, RUNTIME_GATEWAY_URL: fixture.baseUrl, RUNTIME_SHARED_TOKEN: gatewayToken, RUNTIME_OBSERVER_TARGETS: targets, RUNTIME_OBSERVER_POLL_MS: "10", RUNTIME_OBSERVER_TIMEOUT_MS: "1000", RUNTIME_OBSERVER_FAIL_CLOSED: "true", RUNTIME_OBSERVER_PORT: String(observerPort) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${observerPort}/healthz`)).ok;
      } catch {
        return false;
      }
    }, 5000);
    await waitFor(() => fixture.samples.length === 1, 5000);
    return fixture.samples[0];
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => fixture.server.close(resolve));
  }
}

async function observeReloadedTargets() {
  const fixture = await startServer("healthy");
  const directory = await mkdtemp(path.join(os.tmpdir(), "shuzhiren-observer-targets-"));
  const targetsFile = path.join(directory, "runtime-observer-targets.json");
  const target = (runId) => [{ tenantId: "tenant_demo", runId, sessionId: "session_demo", telemetryToken, outputProbeUrl: `${fixture.baseUrl}/probe` }];
  await writeFile(targetsFile, JSON.stringify(target("run_file_before")));
  const child = spawn(process.execPath, [observer], {
    cwd: root,
    env: { ...process.env, CONTROL_PLANE_URL: fixture.baseUrl, RUNTIME_GATEWAY_URL: fixture.baseUrl, RUNTIME_SHARED_TOKEN: gatewayToken, RUNTIME_OBSERVER_TARGETS: "[]", RUNTIME_OBSERVER_TARGETS_FILE: targetsFile, RUNTIME_OBSERVER_POLL_MS: "10", RUNTIME_OBSERVER_TIMEOUT_MS: "1000", RUNTIME_OBSERVER_FAIL_CLOSED: "true", RUNTIME_OBSERVER_PORT: String(observerPort) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitFor(() => fixture.samples.some((sample) => sample.runId === "run_file_before"), 5000);
    await writeFile(targetsFile, "not-json");
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${observerPort}/healthz`);
        const health = await response.json();
        return !response.ok && health.targetConfigHealthy === false;
      } catch {
        return false;
      }
    }, 5000);
    await writeFile(targetsFile, JSON.stringify(target("run_file_after")));
    await waitFor(() => fixture.samples.some((sample) => sample.runId === "run_file_after"), 5000);
    const healthResponse = await fetch(`http://127.0.0.1:${observerPort}/healthz`);
    const health = await healthResponse.json();
    assert.equal(healthResponse.ok, true);
    assert.equal(health.targetConfigSource, "file");
    assert.equal(health.targetConfigHealthy, true);
    assert.equal(health.targetCount, 1);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => fixture.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

async function observeTelemetryDeliveryFailure() {
  const fixture = await startServer("telemetry_unavailable");
  const targets = JSON.stringify([{ tenantId: "tenant_demo", runId: "run_demo", sessionId: "session_demo", telemetryToken, outputProbeUrl: `${fixture.baseUrl}/probe` }]);
  const child = spawn(process.execPath, [observer], {
    cwd: root,
    env: { ...process.env, CONTROL_PLANE_URL: fixture.baseUrl, RUNTIME_GATEWAY_URL: fixture.baseUrl, RUNTIME_SHARED_TOKEN: gatewayToken, RUNTIME_OBSERVER_TARGETS: targets, RUNTIME_OBSERVER_POLL_MS: "10", RUNTIME_OBSERVER_TIMEOUT_MS: "1000", RUNTIME_OBSERVER_FAIL_CLOSED: "true", RUNTIME_OBSERVER_PORT: String(observerPort) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${observerPort}/healthz`);
        const health = await response.json();
        return !response.ok && health.lastError === "telemetry_delivery_failed";
      } catch {
        return false;
      }
    }, 5000);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => fixture.server.close(resolve));
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for runtime observer telemetry");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const healthy = await observeOnce("healthy");
assert.deepEqual(healthy, { tenantId: "tenant_demo", runId: "run_demo", outputConnected: true, inferenceFps: 28.5, outputFps: 25, avSyncMs: 19, bitrateMbps: 4.1, gpuUtilization: 71, gpuMemoryMiB: 14200, audioActive: true, fallbackReady: true });

const silent = await observeOnce("silent");
assert.deepEqual(silent, { tenantId: "tenant_demo", runId: "run_demo", outputConnected: true, inferenceFps: 28.5, outputFps: 25, avSyncMs: 19, bitrateMbps: 4.1, gpuUtilization: 71, gpuMemoryMiB: 14200, audioActive: false, fallbackReady: true });

const failed = await observeOnce("unavailable");
assert.deepEqual(failed, { tenantId: "tenant_demo", runId: "run_demo", outputConnected: false, inferenceFps: 0, outputFps: 0, avSyncMs: 0, bitrateMbps: 0, gpuUtilization: 0, gpuMemoryMiB: 0, audioActive: false, fallbackReady: false });

await observeReloadedTargets();
await observeTelemetryDeliveryFailure();

console.log("PASS  runtime observer activity-audio, fail-closed, delivery health, and target reload paths");
