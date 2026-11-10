import assert from "node:assert/strict";
import test from "node:test";
import { inspectPhotoNarrationWebm } from "./recording-quality.mjs";

const validProbe = { stdout: JSON.stringify({ streams: [{ codec_type: "video", width: 720, height: 1280 }, { codec_type: "audio" }], format: { duration: "42.5" } }) };

test("independently verifies the actual WebM file has a portrait video, audio, and bounded duration", async () => {
  const report = await inspectPhotoNarrationWebm(Buffer.from("webm"), async (filePath) => {
    assert.match(filePath, /recording-quality-/);
    return validProbe;
  });
  assert.deepEqual(report, { status: "verified", profile: "photo-narration-webm", videoWidth: 720, videoHeight: 1280, audioTrackCount: 1, durationSeconds: 42.5, verifier: "ffprobe" });
});

test("rejects missing audio, wrong dimensions, and unsupported duration", async () => {
  await assert.rejects(inspectPhotoNarrationWebm(Buffer.from("webm"), async () => ({ stdout: JSON.stringify({ streams: [{ codec_type: "video", width: 720, height: 1280 }], format: { duration: "42" } }) })), { code: "recording_quality_audio_track_missing" });
  await assert.rejects(inspectPhotoNarrationWebm(Buffer.from("webm"), async () => ({ stdout: JSON.stringify({ streams: [{ codec_type: "video", width: 720, height: 640 }, { codec_type: "audio" }], format: { duration: "42" } }) })), { code: "recording_quality_dimensions_invalid" });
  await assert.rejects(inspectPhotoNarrationWebm(Buffer.from("webm"), async () => ({ stdout: JSON.stringify({ streams: [{ codec_type: "video", width: 720, height: 1280 }, { codec_type: "audio" }], format: { duration: "Infinity" } }) })), { code: "recording_quality_duration_invalid" });
});

test("fails closed when ffprobe is absent, times out, or returns invalid data", async () => {
  await assert.rejects(inspectPhotoNarrationWebm(Buffer.from("webm"), async () => { throw Object.assign(new Error(), { code: "ENOENT" }); }), { status: 503, code: "recording_quality_probe_unavailable" });
  await assert.rejects(inspectPhotoNarrationWebm(Buffer.from("webm"), async () => { throw Object.assign(new Error(), { killed: true }); }), { status: 503, code: "recording_quality_probe_timeout" });
  await assert.rejects(inspectPhotoNarrationWebm(Buffer.from("webm"), async () => ({ stdout: "not-json" })), { status: 422, code: "recording_quality_invalid_probe_output" });
});

test("caps concurrent ffprobe processes and releases capacity after completion", async () => {
  const releaseProbes = [];
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const blockedProbe = () => {
    markStarted();
    return new Promise((resolve) => { releaseProbes.push(() => resolve(validProbe)); });
  };
  const first = inspectPhotoNarrationWebm(Buffer.from("one"), blockedProbe);
  await started;
  const secondStarted = new Promise((resolve) => { markStarted = resolve; });
  const second = inspectPhotoNarrationWebm(Buffer.from("two"), blockedProbe);
  await secondStarted;
  await assert.rejects(inspectPhotoNarrationWebm(Buffer.from("three"), blockedProbe), { status: 503, code: "recording_quality_probe_busy" });
  releaseProbes.forEach((release) => release());
  await Promise.all([first, second]);
  assert.deepEqual(await inspectPhotoNarrationWebm(Buffer.from("four"), async () => validProbe), { status: "verified", profile: "photo-narration-webm", videoWidth: 720, videoHeight: 1280, audioTrackCount: 1, durationSeconds: 42.5, verifier: "ffprobe" });
});
