import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_DURATION_SECONDS = 300;
const MAX_CONCURRENT_PROBES = 2;
let activeProbes = 0;

export async function inspectPhotoNarrationWebm(bytes, runProbe = defaultProbe) {
  if (activeProbes >= MAX_CONCURRENT_PROBES) throw qualityError(503, "recording_quality_probe_busy");
  activeProbes += 1;
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), "recording-quality-"));
    const filePath = join(directory, "recording.webm");
    await writeFile(filePath, bytes, { mode: 0o600, flag: "wx" });
    let output;
    try {
      output = await runProbe(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") throw qualityError(503, "recording_quality_probe_unavailable");
      if (error?.killed || error?.code === "ETIMEDOUT") throw qualityError(503, "recording_quality_probe_timeout");
      throw qualityError(422, "recording_quality_decode_failed");
    }
    let report;
    try { report = JSON.parse(output.stdout); } catch { throw qualityError(422, "recording_quality_invalid_probe_output"); }
    const streams = Array.isArray(report.streams) ? report.streams : [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const audioTrackCount = streams.filter((stream) => stream.codec_type === "audio").length;
    const durationSeconds = Number(report.format?.duration);
    if (!video) throw qualityError(422, "recording_quality_video_track_missing");
    if (video.width !== 720 || video.height !== 1280) throw qualityError(422, "recording_quality_dimensions_invalid");
    if (audioTrackCount < 1) throw qualityError(422, "recording_quality_audio_track_missing");
    if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > MAX_DURATION_SECONDS) throw qualityError(422, "recording_quality_duration_invalid");
    return { status: "verified", profile: "photo-narration-webm", videoWidth: video.width, videoHeight: video.height, audioTrackCount, durationSeconds, verifier: "ffprobe" };
  } finally {
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
      activeProbes -= 1;
    }
  }
}

async function defaultProbe(filePath) {
  return execFile("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-max_alloc", "16777216", "-show_entries", "stream=codec_type,width,height", "-show_entries", "format=duration", "-of", "json", filePath], { timeout: 10_000, maxBuffer: 64 * 1024 });
}

function qualityError(status, code) { return Object.assign(new Error(code), { status, code }); }
