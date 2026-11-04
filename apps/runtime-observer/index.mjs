import http from "node:http";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseObserverTargets } from "./targets.mjs";

const controlPlaneUrl = requiredUrl("CONTROL_PLANE_URL");
const gatewayUrl = requiredUrl("RUNTIME_GATEWAY_URL");
const gatewayToken = requiredSecret("RUNTIME_SHARED_TOKEN");
const pollMs = positiveInt(process.env.RUNTIME_OBSERVER_POLL_MS, 5000);
const timeoutMs = positiveInt(process.env.RUNTIME_OBSERVER_TIMEOUT_MS, 3000);
const failClosed = process.env.RUNTIME_OBSERVER_FAIL_CLOSED !== "false";
const healthPort = positiveInt(process.env.RUNTIME_OBSERVER_PORT, 8084);
const targetsFile = optionalAbsolutePath(process.env.RUNTIME_OBSERVER_TARGETS_FILE);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredSecret(name) {
  const value = required(name);
  if (value.length < 32 || /\s/.test(value)) throw new Error(`${name} must contain at least 32 non-whitespace characters`);
  return value;
}

function requiredUrl(name) {
  const value = required(name);
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error(`${name} must be an http(s) URL without embedded credentials`);
  return url.toString().replace(/\/$/, "");
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalAbsolutePath(value) {
  if (!value) return null;
  if (!isAbsolute(value)) throw new Error("RUNTIME_OBSERVER_TARGETS_FILE must be an absolute container path");
  return value;
}

async function initialTargets() {
  if (!targetsFile) return parseObserverTargets(process.env.RUNTIME_OBSERVER_TARGETS ?? "[]", "RUNTIME_OBSERVER_TARGETS");
  const raw = await readFile(targetsFile, "utf8");
  return { raw, targets: parseObserverTargets(raw, "RUNTIME_OBSERVER_TARGETS_FILE") };
}

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), service: "runtime-observer", event, ...fields })}\n`);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function validProbe(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const outputConnected = value.outputConnected;
  const fallbackReady = value.fallbackReady;
  const outputFps = finiteNonNegative(value.outputFps);
  const avSyncMs = finiteNonNegative(value.avSyncMs);
  const bitrateMbps = finiteNonNegative(value.bitrateMbps);
  const audioActive = value.audioActive;
  if (typeof outputConnected !== "boolean" || typeof fallbackReady !== "boolean" || typeof audioActive !== "boolean" || outputFps === null || avSyncMs === null || bitrateMbps === null) return null;
  return { outputConnected, outputFps, avSyncMs, bitrateMbps, audioActive, fallbackReady };
}

function validProgramObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const observation = value;
  const uuid = (candidate) => typeof candidate === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate);
  const commandId = typeof observation.commandId === "string" && /^media_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(observation.commandId);
  const action = typeof observation.action === "string" && ["START", "RECOVER", "SCHEDULED_START", "INSERT_PROGRAM", "ROLLBACK_PROGRAM"].includes(observation.action);
  const evidenceRef = typeof observation.evidenceRef === "string" && (/^evidence:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(observation.evidenceRef) || /^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/.test(observation.evidenceRef));
  if (!uuid(observation.outboxEventId) || !commandId || !uuid(observation.programSegmentId) || !action || typeof observation.source !== "string" || !/^[a-z][a-z0-9_-]{1,63}$/.test(observation.source) || !evidenceRef || typeof observation.contentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(observation.contentSha256) || typeof observation.confidence !== "number" || !Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1 || !Number.isInteger(observation.mediaTimeMs) || observation.mediaTimeMs < 0 || typeof observation.observedAt !== "string" || Number.isNaN(Date.parse(observation.observedAt))) return null;
  return { outboxEventId: observation.outboxEventId, commandId: observation.commandId, programSegmentId: observation.programSegmentId, action: observation.action, source: observation.source, evidenceRef: observation.evidenceRef, contentSha256: observation.contentSha256, confidence: observation.confidence, mediaTimeMs: observation.mediaTimeMs, observedAt: new Date(observation.observedAt).toISOString() };
}

function failedSample(target) {
  return { runId: target.runId, outputConnected: false, inferenceFps: 0, outputFps: 0, avSyncMs: 0, bitrateMbps: 0, gpuUtilization: 0, gpuMemoryMiB: 0, audioActive: false, fallbackReady: false };
}

function telemetryFromObservation(target, observation, probe) {
  const quality = observation?.quality;
  const gpu = observation?.gpu;
  const session = observation?.session;
  const writerAcceptingFrames = quality?.writer_accepting_frames === true;
  const sessionActive = session?.active === true;
  return {
    runId: target.runId,
    outputConnected: probe.outputConnected && sessionActive && writerAcceptingFrames,
    inferenceFps: finiteNonNegative(quality?.inference_fps) ?? 0,
    outputFps: probe.outputFps,
    avSyncMs: probe.avSyncMs,
    bitrateMbps: probe.bitrateMbps,
    gpuUtilization: finiteNonNegative(gpu?.utilization_percent) ?? 0,
    gpuMemoryMiB: finiteNonNegative(gpu?.memory_used_mib) ?? 0,
    audioActive: probe.audioActive,
    fallbackReady: probe.fallbackReady,
  };
}

async function postTelemetry(target, telemetry) {
  const data = await fetchJson(`${controlPlaneUrl}/api/v1/runtime/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${target.telemetryToken}` },
    body: JSON.stringify({ tenantId: target.tenantId, ...telemetry }),
  });
  return data;
}

async function postProgramOutputObservation(target, observation) {
  return fetchJson(`${controlPlaneUrl}/api/v1/runtime/program-output-observations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${target.telemetryToken}` },
    body: JSON.stringify({ tenantId: target.tenantId, runId: target.runId, runtimeSessionId: target.sessionId, ...observation }),
  });
}

async function observeTarget(target) {
  try {
    const [observation, probeRaw] = await Promise.all([
      fetchJson(`${gatewayUrl}/v1/observations/${encodeURIComponent(target.sessionId)}`, { headers: { authorization: `Bearer ${gatewayToken}` } }),
      fetchJson(target.outputProbeUrl, target.outputProbeToken ? { headers: { authorization: `Bearer ${target.outputProbeToken}` } } : undefined),
    ]);
    const probe = validProbe(probeRaw);
    if (!probe) throw new Error("output_probe_payload_invalid");
    const telemetry = telemetryFromObservation(target, observation, probe);
    await postTelemetry(target, telemetry);
    const outputObservation = validProgramObservation(probeRaw.programObservation);
    if (probeRaw.programObservation !== undefined && !outputObservation) log("program_output_observation.rejected", { runId: target.runId, reason: "output_probe_program_observation_invalid" });
    if (outputObservation) await postProgramOutputObservation(target, outputObservation);
    log("telemetry.posted", { runId: target.runId, outputConnected: telemetry.outputConnected, outputFps: telemetry.outputFps, probeConnected: probe.outputConnected, writerAcceptingFrames: observation?.quality?.writer_accepting_frames === true, outputObservationPosted: Boolean(outputObservation) });
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "observation_failed";
    if (!failClosed) {
      log("telemetry.skipped", { runId: target.runId, reason });
      return false;
    }
    try {
      await postTelemetry(target, failedSample(target));
      log("telemetry.fail_closed", { runId: target.runId, reason });
      return true;
    } catch (postError) {
      log("telemetry.delivery_failed", { runId: target.runId, reason, deliveryError: postError instanceof Error ? postError.message : "telemetry_delivery_failed" });
      return false;
    }
  }
}

const initial = await initialTargets();
let targets = Array.isArray(initial) ? initial : initial.targets;
let targetsFileContents = Array.isArray(initial) ? null : initial.raw;
let targetConfigError = null;
let stopping = false;
let lastSuccessfulCycleAt = null;
let lastCycleError = null;
const healthServer = http.createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/healthz") return json(response, 404, { ok: false, error: "not_found" });
  const cycleFresh = lastSuccessfulCycleAt !== null && Date.now() - lastSuccessfulCycleAt <= Math.max(pollMs * 3, 15_000);
  const healthy = cycleFresh && !stopping && !targetConfigError;
  return json(response, healthy ? 200 : 503, { ok: healthy, targetCount: targets.length, targetConfigSource: targetsFile ? "file" : "environment", targetConfigHealthy: !targetConfigError, lastSuccessfulCycleAt: lastSuccessfulCycleAt === null ? null : new Date(lastSuccessfulCycleAt).toISOString(), lastError: lastCycleError, targetConfigError });
});
healthServer.listen(healthPort, "0.0.0.0", () => log("observer.health_listening", { port: healthPort }));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });
log("observer.started", { targetCount: targets.length, targetConfigSource: targetsFile ? "file" : "environment", pollMs, timeoutMs, failClosed, healthPort });

async function refreshTargetsFromFile() {
  if (!targetsFile) return true;
  try {
    const raw = await readFile(targetsFile, "utf8");
    if (raw !== targetsFileContents) {
      const nextTargets = parseObserverTargets(raw, "RUNTIME_OBSERVER_TARGETS_FILE");
      targets = nextTargets;
      targetsFileContents = raw;
      log("observer.targets_reloaded", { targetCount: targets.length });
    }
    targetConfigError = null;
    return true;
  } catch (error) {
    targetConfigError = error instanceof Error ? error.message : "target_config_read_failed";
    log("observer.target_config_error", { error: targetConfigError });
    return false;
  }
}

while (!stopping) {
  if (!(await refreshTargetsFromFile())) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    continue;
  }
  try {
    const delivered = await Promise.all(targets.map(observeTarget));
    if (!delivered.every(Boolean)) throw new Error("telemetry_delivery_failed");
    lastSuccessfulCycleAt = Date.now();
    lastCycleError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "observer_cycle_failed";
    lastCycleError = message;
    log("observer.error", { error: message });
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}
await new Promise((resolve) => healthServer.close(resolve));
log("observer.stopped");

function json(response, status, value) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
