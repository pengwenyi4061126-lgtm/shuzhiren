const controlPlaneUrl = requiredUrl("CONTROL_PLANE_URL");
const gatewayUrl = requiredUrl("RUNTIME_GATEWAY_URL");
const gatewayToken = required("RUNTIME_SHARED_TOKEN");
const pollMs = positiveInt(process.env.RUNTIME_OBSERVER_POLL_MS, 5000);
const timeoutMs = positiveInt(process.env.RUNTIME_OBSERVER_TIMEOUT_MS, 3000);
const failClosed = process.env.RUNTIME_OBSERVER_FAIL_CLOSED !== "false";
const targets = configuredTargets();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
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

function configuredTargets() {
  let raw;
  try { raw = JSON.parse(required("RUNTIME_OBSERVER_TARGETS")); } catch { throw new Error("RUNTIME_OBSERVER_TARGETS must be valid JSON"); }
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("RUNTIME_OBSERVER_TARGETS must contain at least one target");
  return raw.map((target, index) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error(`RUNTIME_OBSERVER_TARGETS[${index}] must be an object`);
    const value = target;
    for (const key of ["tenantId", "runId", "sessionId", "telemetryToken", "outputProbeUrl"]) if (typeof value[key] !== "string" || value[key].length === 0 || value[key].length > 2000) throw new Error(`RUNTIME_OBSERVER_TARGETS[${index}].${key} is invalid`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.sessionId)) throw new Error(`RUNTIME_OBSERVER_TARGETS[${index}].sessionId is invalid`);
    if (value.telemetryToken.length < 16) throw new Error(`RUNTIME_OBSERVER_TARGETS[${index}].telemetryToken is too short`);
    const probeUrl = new URL(value.outputProbeUrl);
    if (!/^https?:$/.test(probeUrl.protocol) || probeUrl.username || probeUrl.password) throw new Error(`RUNTIME_OBSERVER_TARGETS[${index}].outputProbeUrl is invalid`);
    return { tenantId: value.tenantId, runId: value.runId, sessionId: value.sessionId, telemetryToken: value.telemetryToken, outputProbeUrl: probeUrl.toString() };
  });
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
  if (typeof outputConnected !== "boolean" || typeof fallbackReady !== "boolean" || outputFps === null || avSyncMs === null || bitrateMbps === null) return null;
  return { outputConnected, outputFps, avSyncMs, bitrateMbps, fallbackReady };
}

function failedSample(target) {
  return { runId: target.runId, outputConnected: false, inferenceFps: 0, outputFps: 0, avSyncMs: 0, bitrateMbps: 0, gpuUtilization: 0, gpuMemoryMiB: 0, fallbackReady: false };
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

async function observeTarget(target) {
  try {
    const [observation, probeRaw] = await Promise.all([
      fetchJson(`${gatewayUrl}/v1/observations/${encodeURIComponent(target.sessionId)}`, { headers: { authorization: `Bearer ${gatewayToken}` } }),
      fetchJson(target.outputProbeUrl),
    ]);
    const probe = validProbe(probeRaw);
    if (!probe) throw new Error("output_probe_payload_invalid");
    const telemetry = telemetryFromObservation(target, observation, probe);
    await postTelemetry(target, telemetry);
    log("telemetry.posted", { runId: target.runId, outputConnected: telemetry.outputConnected, outputFps: telemetry.outputFps, probeConnected: probe.outputConnected, writerAcceptingFrames: observation?.quality?.writer_accepting_frames === true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "observation_failed";
    if (!failClosed) {
      log("telemetry.skipped", { runId: target.runId, reason });
      return;
    }
    try {
      await postTelemetry(target, failedSample(target));
      log("telemetry.fail_closed", { runId: target.runId, reason });
    } catch (postError) {
      log("telemetry.delivery_failed", { runId: target.runId, reason, deliveryError: postError instanceof Error ? postError.message : "telemetry_delivery_failed" });
    }
  }
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });
log("observer.started", { targetCount: targets.length, pollMs, timeoutMs, failClosed });
while (!stopping) {
  await Promise.all(targets.map(observeTarget));
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}
log("observer.stopped");
