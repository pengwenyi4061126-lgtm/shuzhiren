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
const programEvidence = { outboxEventId: "11111111-1111-4111-8111-111111111111", commandId: "media_22222222-2222-4222-8222-222222222222", programSegmentId: "33333333-3333-4333-8333-333333333333", action: "INSERT_PROGRAM", source: "watermark_verifier", evidenceRef: "evidence://probe/fixture/1", contentSha256: "a".repeat(64), confidence: 0.992, mediaTimeMs: 5230, observedAt: "2026-11-04T00:00:00.000Z" };
const { fallbackStreamUrl: _fallbackStreamUrl, programEvidenceUrl: _programEvidenceUrl, programEvidenceToken: _programEvidenceToken, ...primaryTarget } = target;
const programEvidenceToken = "program-evidence-token-at-least-32-characters";
const observed = await probeTarget(validateTarget({ ...primaryTarget, programEvidenceUrl: "https://verifier.internal/program", programEvidenceToken }, 0), {
  execute: async (_command, arguments_) => arguments_.includes("-af") ? { stdout: "", stderr: "" } : { stdout: ffprobePayload, stderr: "" },
  fetchImpl: async (url, options) => {
    if (String(url).includes("verifier")) {
      assert.equal(options.headers.authorization, `Bearer ${programEvidenceToken}`);
      return new Response(JSON.stringify(programEvidence), { status: 200 });
    }
    return new Response(JSON.stringify({ avSyncMs: 20 }), { status: 200 });
  }
});
assert.deepEqual(observed.programObservation, programEvidence, "a verifier proof must be preserved without the probe fabricating command linkage");
const evidenceUnavailable = await probeTarget(validateTarget({ ...primaryTarget, programEvidenceUrl: "https://verifier.internal/program" }, 0), {
  execute: async (_command, arguments_) => arguments_.includes("-af") ? { stdout: "", stderr: "" } : { stdout: ffprobePayload, stderr: "" },
  fetchImpl: async (url) => String(url).includes("verifier") ? new Response("unavailable", { status: 503 }) : new Response(JSON.stringify({ avSyncMs: 20 }), { status: 200 })
});
assert.equal("programObservation" in evidenceUnavailable, false, "a missing verifier proof must not be fabricated from output health");
console.log("PASS  output probe measures streams without fabricating missing audio/video metrics");
