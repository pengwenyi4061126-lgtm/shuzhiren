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
  return { id: value.id, streamUrl, fallbackStreamUrl, avSyncProbeUrl };
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

export async function probeTarget(target, { ffprobePath = "ffprobe", timeoutMs = 5000, fetchImpl = fetch, execute = execFileAsync } = {}) {
  const [primary, fallback, avSyncMs] = await Promise.all([
    inspectStream(target.streamUrl, { ffprobePath, timeoutMs, execute }),
    target.fallbackStreamUrl ? inspectStream(target.fallbackStreamUrl, { ffprobePath, timeoutMs, execute }).then(() => true).catch(() => false) : Promise.resolve(false),
    fetchAvSync(target.avSyncProbeUrl, { timeoutMs, fetchImpl })
  ]);
  if (!primary.hasAudio || !primary.hasVideo || primary.outputFps === null || primary.bitrateMbps === null) throw new Error("primary_stream_measurement_incomplete");
  return { outputConnected: true, outputFps: primary.outputFps, avSyncMs, bitrateMbps: primary.bitrateMbps, fallbackReady: fallback };
}

async function inspectStream(sourceUrl, { ffprobePath, timeoutMs, execute }) {
  const { stdout } = await execute(ffprobePath, ["-v", "error", "-show_entries", "stream=codec_type,avg_frame_rate,r_frame_rate,bit_rate:format=bit_rate", "-of", "json", sourceUrl], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  const payload = JSON.parse(stdout);
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream?.codec_type === "video");
  const hasAudio = streams.some((stream) => stream?.codec_type === "audio");
  const outputFps = frameRate(video?.avg_frame_rate) ?? frameRate(video?.r_frame_rate);
  const bitrate = numericBitrate(payload?.format?.bit_rate) ?? numericBitrate(video?.bit_rate);
  return { hasVideo: Boolean(video), hasAudio, outputFps, bitrateMbps: bitrate === null ? null : round(bitrate / 1_000_000) };
}

async function fetchAvSync(url, { timeoutMs, fetchImpl }) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`av_sync_probe_http_${response.status}`);
  const payload = await response.json();
  const value = payload?.avSyncMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("av_sync_probe_payload_invalid");
  return round(value);
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

function round(value) { return Math.round(value * 1000) / 1000; }
