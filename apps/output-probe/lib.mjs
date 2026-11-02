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
  if ((expectedWidth === null) !== (expectedHeight === null)) throw new Error(`OUTPUT_PROBE_TARGETS[${index}] must set expectedWidth and expectedHeight together`);
  return { id: value.id, streamUrl, fallbackStreamUrl, avSyncProbeUrl, expectedFps, expectedWidth, expectedHeight };
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

export async function probeTarget(target, { ffprobePath = "ffprobe", ffmpegPath = "ffmpeg", timeoutMs = 5000, audioSampleSeconds = 5, silenceThresholdDb = -50, silenceDurationSeconds = 2, fetchImpl = fetch, execute = execFileAsync } = {}) {
  const [primary, fallback, avSyncMs, audioActive] = await Promise.all([
    inspectStream(target.streamUrl, { ffprobePath, timeoutMs, execute }),
    target.fallbackStreamUrl ? inspectStream(target.fallbackStreamUrl, { ffprobePath, timeoutMs, execute }).then(() => true).catch(() => false) : Promise.resolve(false),
    fetchAvSync(target.avSyncProbeUrl, { timeoutMs, fetchImpl }),
    detectAudioActivity(target.streamUrl, { ffmpegPath, timeoutMs, audioSampleSeconds, silenceThresholdDb, silenceDurationSeconds, execute })
  ]);
  if (!primary.hasAudio || !primary.hasVideo || primary.outputFps === null || primary.bitrateMbps === null) throw new Error("primary_stream_measurement_incomplete");
  if (target.expectedFps !== null && Math.abs(primary.outputFps - target.expectedFps) > 0.05) throw new Error("primary_stream_fps_mismatch");
  if (target.expectedWidth !== null && (primary.width !== target.expectedWidth || primary.height !== target.expectedHeight)) throw new Error("primary_stream_resolution_mismatch");
  return { outputConnected: true, outputFps: primary.outputFps, avSyncMs, bitrateMbps: primary.bitrateMbps, audioActive, fallbackReady: fallback };
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
