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

export async function probeTarget(target, { ffprobePath = "ffprobe", ffmpegPath = "ffmpeg", timeoutMs = 5000, audioSampleSeconds = 5, silenceThresholdDb = -50, silenceDurationSeconds = 2, fetchImpl = fetch, execute = execFileAsync } = {}) {
  const [primary, fallback, avSyncMs, audioActive, programObservation] = await Promise.all([
    inspectStream(target.streamUrl, { ffprobePath, timeoutMs, execute }),
    target.fallbackStreamUrl ? inspectStream(target.fallbackStreamUrl, { ffprobePath, timeoutMs, execute }).then(() => true).catch(() => false) : Promise.resolve(false),
    fetchAvSync(target.avSyncProbeUrl, { timeoutMs, fetchImpl }),
    detectAudioActivity(target.streamUrl, { ffmpegPath, timeoutMs, audioSampleSeconds, silenceThresholdDb, silenceDurationSeconds, execute }),
    fetchProgramEvidence(target, { timeoutMs, fetchImpl })
  ]);
  if (!primary.hasAudio || !primary.hasVideo || primary.outputFps === null || primary.bitrateMbps === null) throw new Error("primary_stream_measurement_incomplete");
  if (target.expectedFps !== null && Math.abs(primary.outputFps - target.expectedFps) > 0.05) throw new Error("primary_stream_fps_mismatch");
  if (target.expectedWidth !== null && (primary.width !== target.expectedWidth || primary.height !== target.expectedHeight)) throw new Error("primary_stream_resolution_mismatch");
  const result = { outputConnected: true, outputFps: primary.outputFps, avSyncMs, bitrateMbps: primary.bitrateMbps, audioActive, fallbackReady: fallback };
  return programObservation ? { ...result, programObservation } : result;
}

async function inspectStream(sourceUrl, { ffprobePath, timeoutMs, execute }) {
  const { stdout } = await execute(ffprobePath, ["-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate,r_frame_rate,bit_rate:format=bit_rate", "-of", "json", sourceUrl], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
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

async function fetchAvSync(url, { timeoutMs, fetchImpl }) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`av_sync_probe_http_${response.status}`);
  const payload = await response.json();
  const value = payload?.avSyncMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("av_sync_probe_payload_invalid");
  return round(value);
}

async function fetchProgramEvidence(target, { timeoutMs, fetchImpl }) {
  if (!target.programEvidenceUrl) return null;
  try {
    const response = await fetchImpl(target.programEvidenceUrl, {
      headers: target.programEvidenceToken ? { authorization: `Bearer ${target.programEvidenceToken}` } : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return null;
    return validateProgramObservation(await response.json(), "program evidence response");
  } catch {
    // Output health must remain available when the optional content verifier is down.
    return null;
  }
}

export function validateProgramObservation(value, label = "program observation") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const observation = value;
  if (!isUuid(observation.outboxEventId) || !isMediaCommandId(observation.commandId) || !isUuid(observation.programSegmentId)) throw new Error(`${label} command binding is invalid`);
  if (!allowedAction(observation.action) || !isSessionTimestamp(observation.observedAt) || !Number.isInteger(observation.mediaTimeMs) || observation.mediaTimeMs < 0) throw new Error(`${label} timing is invalid`);
  if (typeof observation.source !== "string" || !/^[a-z][a-z0-9_-]{1,63}$/.test(observation.source)) throw new Error(`${label} source is invalid`);
  if (typeof observation.evidenceRef !== "string" || !(/^evidence:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(observation.evidenceRef) || /^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/.test(observation.evidenceRef))) throw new Error(`${label} evidence reference is invalid`);
  if (typeof observation.contentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(observation.contentSha256)) throw new Error(`${label} content hash is invalid`);
  if (typeof observation.confidence !== "number" || !Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1) throw new Error(`${label} confidence is invalid`);
  return { outboxEventId: observation.outboxEventId, commandId: observation.commandId, programSegmentId: observation.programSegmentId, action: observation.action, source: observation.source, evidenceRef: observation.evidenceRef, contentSha256: observation.contentSha256, confidence: observation.confidence, mediaTimeMs: observation.mediaTimeMs, observedAt: new Date(observation.observedAt).toISOString() };
}

async function detectAudioActivity(sourceUrl, { ffmpegPath, timeoutMs, audioSampleSeconds, silenceThresholdDb, silenceDurationSeconds, execute }) {
  const { stderr = "" } = await execute(ffmpegPath, ["-hide_banner", "-nostdin", "-t", String(audioSampleSeconds), "-i", sourceUrl, "-map", "0:a:0", "-af", `silencedetect=n=${silenceThresholdDb}dB:d=${silenceDurationSeconds}`, "-f", "null", "-"], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
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
