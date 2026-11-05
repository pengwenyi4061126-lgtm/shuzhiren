import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function validateTarget(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`OUTPUT_PROBE_TARGETS[${index}] must be an object`);
  for (const key of ["id", "streamUrl", "avSyncProbeUrl"]) if (typeof value[key] !== "string" || value[key].length === 0 || value[key].length > 2000) throw new Error(`OUTPUT_PROBE_TARGETS[${index}].${key} is invalid`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.id)) throw new Error(`OUTPUT_PROBE_TARGETS[${index}].id is invalid`);
  const streamUrl = safeSourceUrl(value.streamUrl, `OUTPUT_PROBE_TARGETS[${index}].streamUrl`);
  const avSyncProbeUrl = safeHttpUrl(value.avSyncProbeUrl, `OUTPUT_PROBE_TARGETS[${index}].avSyncProbeUrl`);
  const fallbackStreamUrl = value.fallbackStreamUrl === undefined ? null : safeSourceUrl(value.fallbackStreamUrl, `OUTPUT_PROBE_TARGETS[${index}].fallbackStreamUrl`);
  const expectedFps = optionalPositiveNumber(value.expectedFps, `OUTPUT_PROBE_TARGETS[${index}].expectedFps`, 120);
  const expectedWidth = optionalPositiveInteger(value.expectedWidth, `OUTPUT_PROBE_TARGETS[${index}].expectedWidth`, 8192);
  const expectedHeight = optionalPositiveInteger(value.expectedHeight, `OUTPUT_PROBE_TARGETS[${index}].expectedHeight`, 8192);
  const programEvidenceUrl = value.programEvidenceUrl === undefined ? null : safeHttpUrl(value.programEvidenceUrl, `OUTPUT_PROBE_TARGETS[${index}].programEvidenceUrl`);
  const programEvidenceToken = value.programEvidenceToken === undefined ? null : requiredSecret(value.programEvidenceToken, `OUTPUT_PROBE_TARGETS[${index}].programEvidenceToken`);
  if ((expectedWidth === null) !== (expectedHeight === null)) throw new Error(`OUTPUT_PROBE_TARGETS[${index}] must set expectedWidth and expectedHeight together`);
  if (programEvidenceUrl === null && programEvidenceToken !== null) throw new Error(`OUTPUT_PROBE_TARGETS[${index}].programEvidenceToken requires programEvidenceUrl`);
  return { id: value.id, streamUrl, fallbackStreamUrl, avSyncProbeUrl, expectedFps, expectedWidth, expectedHeight, programEvidenceUrl, programEvidenceToken };
}

function optionalPositiveNumber(value, label, maximum) {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}

function optionalPositiveInteger(value, label, maximum) {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value <= 0 || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}

function safeSourceUrl(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) throw new Error(`${label} is invalid`);
  const url = new URL(value);
  if (!["rtmp:", "rtmps:", "srt:", "http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`${label} must use a supported URL without embedded credentials`);
  return url.toString();
}

function safeHttpUrl(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) throw new Error(`${label} is invalid`);
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error(`${label} must be an http(s) URL without embedded credentials`);
  return url.toString();
}

function requiredSecret(value, label) {
  if (typeof value !== "string" || value.length < 32 || value.length > 2000 || /\s/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export async function probeTarget(target, { ffprobePath = "ffprobe", ffmpegPath = "ffmpeg", timeoutMs = 5000, audioSampleSeconds = 5, silenceThresholdDb = -50, silenceDurationSeconds = 2, fetchImpl = fetch, execute = execFileAsync, signal } = {}) {
  // `signal` aborts every measurement at shutdown: fetches are cancelled and ffprobe and ffmpeg are killed.
  const [primary, fallback, avSyncMs, audioActive, programObservation] = await Promise.all([
    inspectStream(target.streamUrl, { ffprobePath, timeoutMs, execute, signal }),
    target.fallbackStreamUrl ? inspectStream(target.fallbackStreamUrl, { ffprobePath, timeoutMs, execute, signal }).then(() => true).catch(() => false) : Promise.resolve(false),
    fetchAvSync(target.avSyncProbeUrl, { timeoutMs, fetchImpl, signal }),
    detectAudioActivity(target.streamUrl, { ffmpegPath, timeoutMs, audioSampleSeconds, silenceThresholdDb, silenceDurationSeconds, execute, signal }),
    fetchProgramEvidence(target, { timeoutMs, fetchImpl, signal })
  ]);
  if (!primary.hasAudio || !primary.hasVideo || primary.outputFps === null || primary.bitrateMbps === null) throw new Error("primary_stream_measurement_incomplete");
  if (target.expectedFps !== null && Math.abs(primary.outputFps - target.expectedFps) > 0.05) throw new Error("primary_stream_fps_mismatch");
  if (target.expectedWidth !== null && (primary.width !== target.expectedWidth || primary.height !== target.expectedHeight)) throw new Error("primary_stream_resolution_mismatch");
  const result = { outputConnected: true, outputFps: primary.outputFps, avSyncMs, bitrateMbps: primary.bitrateMbps, audioActive, fallbackReady: fallback };
  return programObservation ? { ...result, programObservation } : result;
}

async function inspectStream(sourceUrl, { ffprobePath, timeoutMs, execute, signal }) {
  const { stdout } = await execute(ffprobePath, ["-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate,r_frame_rate,bit_rate:format=bit_rate", "-of", "json", sourceUrl], { timeout: timeoutMs, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) });
  const payload = JSON.parse(stdout);
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream?.codec_type === "video");
  const hasAudio = streams.some((stream) => stream?.codec_type === "audio");
  const outputFps = frameRate(video?.avg_frame_rate) ?? frameRate(video?.r_frame_rate);
  const bitrate = numericBitrate(payload?.format?.bit_rate) ?? numericBitrate(video?.bit_rate);
  const width = numericDimension(video?.width);
  const height = numericDimension(video?.height);
  return { hasVideo: Boolean(video), hasAudio, outputFps, width, height, bitrateMbps: bitrate === null ? null : round(bitrate / 1_000_000) };
}

async function fetchAvSync(url, { timeoutMs, fetchImpl, signal }) {
  const response = await fetchImpl(url, { signal: withShutdown(AbortSignal.timeout(timeoutMs), signal) });
  if (!response.ok) throw new Error(`av_sync_probe_http_${response.status}`);
  const payload = await response.json();
  const value = payload?.avSyncMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("av_sync_probe_payload_invalid");
  return round(value);
}

async function fetchProgramEvidence(target, { timeoutMs, fetchImpl, signal }) {
  if (!target.programEvidenceUrl) return null;
  try {
    const response = await fetchImpl(target.programEvidenceUrl, {
      headers: target.programEvidenceToken ? { authorization: `Bearer ${target.programEvidenceToken}` } : undefined,
      signal: withShutdown(AbortSignal.timeout(timeoutMs), signal)
    });
    if (!response.ok) return null;
    return validateProgramObservation(await response.json(), "program evidence response");
  } catch {
    // Output health must remain available when the optional content verifier is down.
    return null;
  }
}

function withShutdown(timeout, signal) { return signal ? AbortSignal.any([timeout, signal]) : timeout; }

export function validateProgramObservation(value, label = "program observation") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const envelope = value;
  const observation = envelope.observation;
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) throw new Error(`${label} observation is invalid`);
  if (typeof envelope.issuer !== "string" || !/^[a-z][a-z0-9_-]{1,63}$/.test(envelope.issuer) || typeof envelope.keyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(envelope.keyId) || typeof envelope.audience !== "string" || envelope.audience.length === 0 || envelope.audience.length > 200 || !isSessionTimestamp(envelope.issuedAt) || !isSessionTimestamp(envelope.expiresAt) || typeof envelope.signature !== "string" || !/^[A-Za-z0-9_-]{80,1024}$/.test(envelope.signature)) throw new Error(`${label} attestation is invalid`);
  if (!isUuid(observation.outboxEventId) || !isMediaCommandId(observation.commandId) || !isUuid(observation.programSegmentId)) throw new Error(`${label} command binding is invalid`);
  if (!allowedAction(observation.action) || !isSessionTimestamp(observation.observedAt) || !Number.isInteger(observation.mediaTimeMs) || observation.mediaTimeMs < 0) throw new Error(`${label} timing is invalid`);
  if (typeof observation.source !== "string" || !/^[a-z][a-z0-9_-]{1,63}$/.test(observation.source)) throw new Error(`${label} source is invalid`);
  if (typeof observation.evidenceRef !== "string" || !(/^evidence:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(observation.evidenceRef) || /^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/.test(observation.evidenceRef))) throw new Error(`${label} evidence reference is invalid`);
  if (typeof observation.contentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(observation.contentSha256)) throw new Error(`${label} content hash is invalid`);
  if (typeof observation.confidence !== "number" || !Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1) throw new Error(`${label} confidence is invalid`);
  return { outboxEventId: observation.outboxEventId, commandId: observation.commandId, programSegmentId: observation.programSegmentId, action: observation.action, source: observation.source, evidenceRef: observation.evidenceRef, contentSha256: observation.contentSha256, confidence: observation.confidence, mediaTimeMs: observation.mediaTimeMs, observedAt: new Date(observation.observedAt).toISOString(), attestation: { issuer: envelope.issuer, keyId: envelope.keyId, audience: envelope.audience, issuedAt: new Date(envelope.issuedAt).toISOString(), expiresAt: new Date(envelope.expiresAt).toISOString(), signature: envelope.signature } };
}

async function detectAudioActivity(sourceUrl, { ffmpegPath, timeoutMs, audioSampleSeconds, silenceThresholdDb, silenceDurationSeconds, execute, signal }) {
  const { stderr = "" } = await execute(ffmpegPath, ["-hide_banner", "-nostdin", "-t", String(audioSampleSeconds), "-i", sourceUrl, "-map", "0:a:0", "-af", `silencedetect=n=${silenceThresholdDb}dB:d=${silenceDurationSeconds}`, "-f", "null", "-"], { timeout: timeoutMs, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) });
  const silentFromStart = /silence_start:\s*0(?:\.0+)?(?:\s|$)/.test(stderr);
  const becameActive = /silence_end:/.test(stderr);
  return !(silentFromStart && !becameActive);
}

function frameRate(value) {
  if (typeof value !== "string") return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) return null;
  return round(numerator / denominator);
}

function numericBitrate(value) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function numericDimension(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function round(value) { return Math.round(value * 1000) / 1000; }
function isUuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isMediaCommandId(value) { return typeof value === "string" && /^media_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function allowedAction(value) { return typeof value === "string" && ["START", "RECOVER", "SCHEDULED_START", "INSERT_PROGRAM", "ROLLBACK_PROGRAM"].includes(value); }
function isSessionTimestamp(value) { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }

// Graceful SIGTERM and SIGINT handling (L7). Node installs no default handler for these signals when it runs
// as PID 1 in a container, so `docker stop` used to wait 10 s and then kill the process with SIGKILL (137).
// Stop listening at once, let in-flight requests finish for SHUTDOWN_GRACE_MS, then abort their downstream calls
// through `signal` and close the remaining connections, run `cleanup` for at most SHUTDOWN_CLEANUP_MS and exit 0.
// A repeated signal is ignored. If shutdown still hangs, the process exits 1 after both budgets.
export const SHUTDOWN_GRACE_MS = 5_000;
export const SHUTDOWN_CLEANUP_MS = 2_000;

export function installGracefulShutdown({ server, log, cleanup = async () => {}, graceMs = SHUTDOWN_GRACE_MS, cleanupMs = SHUTDOWN_CLEANUP_MS, signals = ["SIGTERM", "SIGINT"], emitter = process, exit = (code) => process.exit(code) }) {
  const controller = new AbortController();
  const active = new Set();
  let shutdown = null;
  server.on("request", (request, response) => {
    active.add(response);
    response.once("close", () => {
      active.delete(response);
      if (shutdown) setImmediate(() => server.closeIdleConnections?.());
    });
  });
  const run = async (signal) => {
    const startedAt = Date.now();
    const forced = setTimeout(() => { log("shutdown_forced", { inflight: active.size }); exit(1); }, graceMs + 2 * cleanupMs + 500);
    forced.unref?.();
    log("shutdown_started", { signal, inflight: active.size });
    const closed = new Promise((resolve) => server.close(() => resolve()));
    server.closeIdleConnections?.();
    if (!(await settlesWithin(closed, graceMs))) {
      log("shutdown_aborting", { inflight: active.size });
      controller.abort(new Error("shutting_down"));
      if (!(await settlesWithin(closed, cleanupMs))) server.closeAllConnections?.();
    }
    await settlesWithin(Promise.resolve().then(cleanup).catch((error) => log("shutdown_cleanup_failed", { error: error instanceof Error ? error.message : String(error) })), cleanupMs);
    clearTimeout(forced);
    log("shutdown_complete", { durationMs: Date.now() - startedAt });
    exit(0);
  };
  const begin = (signal) => { shutdown ??= run(signal); return shutdown; };
  for (const signal of signals) emitter.on(signal, () => { void begin(signal); });
  return { signal: controller.signal, get stopping() { return shutdown !== null; }, shutdown: begin };
}

function settlesWithin(promise, timeoutMs) {
  let timer;
  return Promise.race([promise.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]).finally(() => clearTimeout(timer));
}