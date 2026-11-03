import http from "node:http";
import { probeTarget, validateTarget } from "./lib.mjs";

const port = positiveInt(process.env.OUTPUT_PROBE_PORT, 8081);
const timeoutMs = positiveInt(process.env.OUTPUT_PROBE_TIMEOUT_MS, 5000);
const cacheMs = positiveInt(process.env.OUTPUT_PROBE_CACHE_MS, 3000);
const audioSampleSeconds = positiveInt(process.env.OUTPUT_PROBE_AUDIO_SAMPLE_SECONDS, 5);
const silenceDurationSeconds = positiveInt(process.env.OUTPUT_PROBE_SILENCE_DURATION_SECONDS, 2);
const silenceThresholdDb = negativeNumber(process.env.OUTPUT_PROBE_SILENCE_THRESHOLD_DB, -50);
const token = required("OUTPUT_PROBE_SHARED_TOKEN");
const targets = configuredTargets();
const cache = new Map();

function required(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function positiveInt(value, fallback) { const parsed = Number.parseInt(value ?? "", 10); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function negativeNumber(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) && parsed < 0 && parsed >= -120 ? parsed : fallback; }
function configuredTargets() {
  let raw;
  try { raw = JSON.parse(required("OUTPUT_PROBE_TARGETS")); } catch { throw new Error("OUTPUT_PROBE_TARGETS must be valid JSON"); }
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("OUTPUT_PROBE_TARGETS must contain at least one target");
  const result = new Map();
  raw.forEach((entry, index) => {
    const target = validateTarget(entry, index);
    if (result.has(target.id)) throw new Error(`OUTPUT_PROBE_TARGETS contains duplicate id ${target.id}`);
    result.set(target.id, target);
  });
  return result;
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function authorized(request) { return request.headers.authorization === `Bearer ${token}`; }

async function measuredTarget(target) {
  const existing = cache.get(target.id);
  if (existing && existing.expiresAt > Date.now()) return existing.value;
  const value = probeTarget(target, { timeoutMs, audioSampleSeconds, silenceDurationSeconds, silenceThresholdDb });
  cache.set(target.id, { value, expiresAt: Date.now() + cacheMs });
  try { return await value; } catch (error) { cache.delete(target.id); throw error; }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, { status: "ok", targetCount: targets.size });
  if (request.method !== "GET" || !url.pathname.startsWith("/v1/probes/")) return json(response, 404, { error: "not_found" });
  if (!authorized(request)) return json(response, 401, { error: "unauthorized" });
  const id = decodeURIComponent(url.pathname.slice("/v1/probes/".length));
  const target = targets.get(id);
  if (!target) return json(response, 404, { error: "probe_not_found" });
  try {
    return json(response, 200, await measuredTarget(target));
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : "probe_failed";
    process.stderr.write(`${JSON.stringify({ service: "output-probe", event: "measurement_failed", targetId: target.id, diagnostic })}\n`);
    return json(response, 503, { error: "measurement_unavailable" });
  }
});

server.listen(port, "0.0.0.0", () => process.stdout.write(`${JSON.stringify({ service: "output-probe", event: "started", port, targetCount: targets.size, timeoutMs, cacheMs, audioSampleSeconds, silenceDurationSeconds, silenceThresholdDb })}\n`));
