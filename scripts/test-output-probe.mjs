import assert from "node:assert/strict";
import { probeTarget, validateTarget } from "../apps/output-probe/lib.mjs";

const target = validateTarget({ id: "probe_demo", streamUrl: "rtmp://relay.internal/live/primary", fallbackStreamUrl: "https://relay.internal/fallback.m3u8", avSyncProbeUrl: "http://analyzer.internal/av-sync", expectedFps: 25, expectedWidth: 1280, expectedHeight: 720 }, 0);
const ffprobePayload = JSON.stringify({ streams: [{ codec_type: "video", width: 1280, height: 720, avg_frame_rate: "25/1", bit_rate: "4200000" }, { codec_type: "audio" }], format: { bit_rate: "4100000" } });
let inspectCount = 0;
const result = await probeTarget(target, {
  execute: async () => { inspectCount += 1; return { stdout: ffprobePayload, stderr: "" }; },
  fetchImpl: async () => new Response(JSON.stringify({ avSyncMs: 18.6 }), { status: 200 })
});
assert.deepEqual(result, { outputConnected: true, outputFps: 25, avSyncMs: 18.6, bitrateMbps: 4.1, audioActive: true, fallbackReady: true });
assert.equal(inspectCount, 3, "primary and fallback ffprobe calls plus one audio-activity sample are required");

await assert.rejects(
  () => probeTarget({ ...target, fallbackStreamUrl: null }, { execute: async () => ({ stdout: JSON.stringify({ streams: [{ codec_type: "video", avg_frame_rate: "25/1" }], format: { bit_rate: "4100000" } }) }), fetchImpl: async () => new Response(JSON.stringify({ avSyncMs: 20 }), { status: 200 }) }),
  /primary_stream_measurement_incomplete/
);
await assert.rejects(
  () => probeTarget({ ...target, expectedWidth: 1920, expectedHeight: 1080, fallbackStreamUrl: null }, { execute: async (_command, arguments_) => arguments_.includes("-af") ? { stdout: "", stderr: "" } : { stdout: ffprobePayload, stderr: "" }, fetchImpl: async () => new Response(JSON.stringify({ avSyncMs: 20 }), { status: 200 }) }),
  /primary_stream_resolution_mismatch/
);
assert.throws(
  () => validateTarget({ id: "probe_invalid", streamUrl: "rtmp://relay.internal/live/primary", avSyncProbeUrl: "http://analyzer.internal/av-sync", expectedWidth: 1280 }, 0),
  /expectedWidth and expectedHeight together/
);
const silent = await probeTarget({ ...target, fallbackStreamUrl: null }, { execute: async (_command, arguments_) => arguments_.includes("-af") ? { stdout: "", stderr: "[silencedetect] silence_start: 0" } : { stdout: ffprobePayload, stderr: "" }, fetchImpl: async () => new Response(JSON.stringify({ avSyncMs: 20 }), { status: 200 }) });
assert.equal(silent.audioActive, false, "continuous silence must be reported as inactive audio");
console.log("PASS  output probe measures streams without fabricating missing audio/video metrics");
