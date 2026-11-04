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
const programOutputToken = "observer-program-output-token-at-least-32";
const gatewayToken = "gateway-shared-token-at-least-16";
const observerPort = 18084;

async function startServer(probeMode) {
  const samples = [];
  const programOutputObservations = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/v1/observations/session_demo") {
      assert.equal(request.headers.authorization, `Bearer ${gatewayToken}`);
      if (probeMode === "slow") await new Promise((resolve) => setTimeout(resolve, 500));
      return json(response, 200, { session: { id: "session_demo", active: true }, gpu: { available: true, utilization_percent: 71, memory_used_mib: 14200 }, quality: { writer_accepting_frames: true, inference_fps: 28.5 } });
    }
    if (url.pathname === "/probe") {
      if (probeMode === "unavailable") return json(response, 503, { error: "probe_unavailable" });
      const observedAt = new Date().toISOString();
      const programObservation = probeMode === "program_observation" ? { outboxEventId: "11111111-1111-4111-8111-111111111111", commandId: "media_22222222-2222-4222-8222-222222222222", programSegmentId: "33333333-3333-4333-8333-333333333333", action: "INSERT_PROGRAM", source: "watermark_verifier", evidenceRef: "evidence://observer/fixture/1", contentSha256: "a".repeat(64), confidence: 0.99, mediaTimeMs: 5000, observedAt, attestation: { issuer: "watermark_verifier", keyId: "fixture-2026", audience: "tenant_demo:run_demo", issuedAt: observedAt, expiresAt: new Date(Date.now() + 60_000).toISOString(), signature: "a".repeat(86) } } : undefined;
      return json(response, 200, { outputConnected: true, outputFps: 25, avSyncMs: 19, bitrateMbps: 4.1, audioActive: probeMode !== "silent", fallbackReady: true, ...(programObservation ? { programObservation } : {}) });
    }
    if (url.pathname === "/api/v1/runtime/telemetry" && request.method === "POST") {
      assert.equal(request.headers.authorization, `Bearer ${telemetryToken}`);
      if (probeMode === "telemetry_unavailable") return json(response, 503, { error: "telemetry_unavailable" });
      samples.push(await requestBody(request));
      return json(response, 202, { data: { accepted: true } });
    }
    if (url.pathname === "/api/v1/runtime/program-output-observations" && request.method === "POST") {
      assert.equal(request.headers.authorization, `Bearer ${programOutputToken}`);
      programOutputObservations.push(await requestBody(request));
      return json(response, 202, { data: { accepted: true } });
    }
    return json(response, 404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return { server, samples, programOutputObservations, baseUrl: `http://127.0.0.1:${address.port}` };
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
  const targets = JSON.stringify([{ tenantId: "tenant_demo", runId: "run_demo", sessionId: "session_demo", telemetryToken, programOutputToken, outputProbeUrl: `${fixture.baseUrl}/probe` }]);
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
    if (probeMode === "program_observation") await waitFor(() => fixture.programOutputObservations.length === 1, 5000);
    return { telemetry: fixture.samples[0], programOutputObservation: fixture.programOutputObservations[0] };
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
  const target = (runId) => [{ tenantId: "tenant_demo", runId, sessionId: "session_demo", telemetryToken, programOutputToken, outputProbeUrl: `${fixture.baseUrl}/probe` }];
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
  const targets = JSON.stringify([{ tenantId: "tenant_demo", runId: "run_demo", sessionId: "session_demo", telemetryToken, programOutputToken, outputProbeUrl: `${fixture.baseUrl}/probe` }]);
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

async function observeStartupHealth() {
  const fixture = await startServer("slow");
  const targets = JSON.stringify([{ tenantId: "tenant_demo", runId: "run_demo", sessionId: "session_demo", telemetryToken, programOutputToken, outputProbeUrl: `${fixture.baseUrl}/probe` }]);
  const child = spawn(process.execPath, [observer], {
    cwd: root,
    env: { ...process.env, CONTROL_PLANE_URL: fixture.baseUrl, RUNTIME_GATEWAY_URL: fixture.baseUrl, RUNTIME_SHARED_TOKEN: gatewayToken, RUNTIME_OBSERVER_TARGETS: targets, RUNTIME_OBSERVER_POLL_MS: "10", RUNTIME_OBSERVER_TIMEOUT_MS: "1000", RUNTIME_OBSERVER_FAIL_CLOSED: "true", RUNTIME_OBSERVER_PORT: String(observerPort) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    let health;
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${observerPort}/healthz`);
        health = await response.json();
        return response.status === 503 && health.lastSuccessfulCycleAt === null;
      } catch {
        return false;
      }
    }, 5000);
    assert.equal(health.lastSuccessfulCycleAt, null);
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
assert.deepEqual(healthy.telemetry, { tenantId: "tenant_demo", runId: "run_demo", outputConnected: true, inferenceFps: 28.5, outputFps: 25, avSyncMs: 19, bitrateMbps: 4.1, gpuUtilization: 71, gpuMemoryMiB: 14200, audioActive: true, fallbackReady: true });

const silent = await observeOnce("silent");
assert.deepEqual(silent.telemetry, { tenantId: "tenant_demo", runId: "run_demo", outputConnected: true, inferenceFps: 28.5, outputFps: 25, avSyncMs: 19, bitrateMbps: 4.1, gpuUtilization: 71, gpuMemoryMiB: 14200, audioActive: false, fallbackReady: true });

const failed = await observeOnce("unavailable");
assert.deepEqual(failed.telemetry, { tenantId: "tenant_demo", runId: "run_demo", outputConnected: false, inferenceFps: 0, outputFps: 0, avSyncMs: 0, bitrateMbps: 0, gpuUtilization: 0, gpuMemoryMiB: 0, audioActive: false, fallbackReady: false });

const observed = await observeOnce("program_observation");
assert.deepEqual(observed.programOutputObservation, { tenantId: "tenant_demo", runId: "run_demo", runtimeSessionId: "session_demo", outboxEventId: "11111111-1111-4111-8111-111111111111", commandId: "media_22222222-2222-4222-8222-222222222222", programSegmentId: "33333333-3333-4333-8333-333333333333", action: "INSERT_PROGRAM", source: "watermark_verifier", evidenceRef: "evidence://observer/fixture/1", contentSha256: "a".repeat(64), confidence: 0.99, mediaTimeMs: 5000, observedAt: observed.programOutputObservation.observedAt, attestation: { issuer: "watermark_verifier", keyId: "fixture-2026", audience: "tenant_demo:run_demo", issuedAt: observed.programOutputObservation.attestation.issuedAt, expiresAt: observed.programOutputObservation.attestation.expiresAt, signature: "a".repeat(86) } });

await observeReloadedTargets();
await observeTelemetryDeliveryFailure();
await observeStartupHealth();

console.log("PASS  runtime observer activity-audio, output-evidence forwarding, fail-closed, startup health, delivery health, and target reload paths");
