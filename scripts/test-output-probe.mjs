import assert from "node:assert/strict";
import http from "node:http";
import { authorizationDigest, authorizationMatches, createProbeHandler, decodeTargetId, guardedHandler, json, parseRequestTarget } from "../apps/output-probe/handler.mjs";
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
const programEvidence = { issuer: "watermark_verifier", keyId: "fixture-2026", audience: "tenant_demo:run_demo", issuedAt: "2026-11-04T00:00:00.000Z", expiresAt: "2026-11-04T00:05:00.000Z", signature: "a".repeat(86), observation: { outboxEventId: "11111111-1111-4111-8111-111111111111", commandId: "media_22222222-2222-4222-8222-222222222222", programSegmentId: "33333333-3333-4333-8333-333333333333", action: "INSERT_PROGRAM", source: "watermark_verifier", evidenceRef: "evidence://probe/fixture/1", contentSha256: "a".repeat(64), confidence: 0.992, mediaTimeMs: 5230, observedAt: "2026-11-04T00:00:00.000Z" } };
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
assert.deepEqual(observed.programObservation, { ...programEvidence.observation, attestation: { issuer: programEvidence.issuer, keyId: programEvidence.keyId, audience: programEvidence.audience, issuedAt: programEvidence.issuedAt, expiresAt: programEvidence.expiresAt, signature: programEvidence.signature } }, "a verifier attestation envelope must be preserved without the probe fabricating command linkage");
const evidenceUnavailable = await probeTarget(validateTarget({ ...primaryTarget, programEvidenceUrl: "https://verifier.internal/program" }, 0), {
  execute: async (_command, arguments_) => arguments_.includes("-af") ? { stdout: "", stderr: "" } : { stdout: ffprobePayload, stderr: "" },
  fetchImpl: async (url) => String(url).includes("verifier") ? new Response("unavailable", { status: 503 }) : new Response(JSON.stringify({ avSyncMs: 20 }), { status: 200 })
});
assert.equal("programObservation" in evidenceUnavailable, false, "a missing verifier proof must not be fabricated from output health");
console.log("PASS  output probe measures streams without fabricating missing audio/video metrics");

// H5: request parsing helpers, constant-time credential comparison and the guarded request handler.
assert.equal(parseRequestTarget("//"), null, "an unparsable request target must be reported as null");
assert.equal(parseRequestTarget("/v1/probes/a").pathname, "/v1/probes/a");
assert.equal(decodeTargetId("%E0%A4%A"), null, "malformed percent-encoding must be reported as null");
assert.equal(decodeTargetId("probe%5Fdemo"), "probe_demo");
const probeToken = "output-probe-shared-token-0123456789abcd";
const expectedDigest = authorizationDigest(`Bearer ${probeToken}`);
assert.equal(expectedDigest.length, 32);
assert.equal(authorizationMatches(`Bearer ${probeToken}`, expectedDigest), true);
for (const [label, header] of [["missing", undefined], ["non-string", ["Bearer", probeToken]], ["shorter", "Bearer short"], ["longer", `Bearer ${probeToken}x`], ["same length but different", `Bearer ${"x".repeat(probeToken.length)}`], ["containing 0xC3 0xA9 bytes", `Bearer ${Buffer.from([0xc3, 0xa9]).toString("latin1")}${probeToken.slice(2)}`]]) {
  assert.equal(authorizationMatches(header, expectedDigest), false, `${label} authorization must not match`);
}
assert.equal(authorizationMatches(Buffer.from("Bearer é-token", "utf8").toString("latin1"), authorizationDigest("Bearer é-token")), true, "raw UTF-8 header bytes must compare against the UTF-8 encoded expected value");

const guardLog = [];
const guardCases = {
  "/sync-throw": () => { throw new Error("secret-detail"); },
  "/async-throw": async () => { throw new Error("secret-detail"); },
  "/rejected": () => Promise.reject(new Error("secret-detail")),
  "/partial": (_request, response) => { response.writeHead(200, { "content-type": "text/plain" }); response.write("partial"); throw new Error("secret-detail"); },
  "/healthz": (_request, response) => json(response, 200, { status: "ok" })
};
const throwingTargets = new Proxy(new Map(), { get(map, property) { if (property === "get") throw new TypeError("targets lookup exploded secret-detail"); const value = Reflect.get(map, property, map); return typeof value === "function" ? value.bind(map) : value; } });
const probeHandler = guardedHandler(createProbeHandler({ token: probeToken, targets: throwingTargets, measure: async () => ({}), log: (entry) => guardLog.push(entry) }), { log: (entry) => guardLog.push(entry) });
const guardServer = http.createServer((request, response) => {
  if (request.url.startsWith("/v1/probes/")) return probeHandler(request, response);
  return guardedHandler((guardCases[request.url] ?? guardCases["/healthz"]), { log: (entry) => guardLog.push(entry) })(request, response);
});
await new Promise((resolve) => guardServer.listen(0, "127.0.0.1", resolve));
try {
  const { port } = guardServer.address();
  for (const casePath of ["/sync-throw", "/async-throw", "/rejected"]) {
    const result = await getLocal(port, casePath);
    assert.equal(result.complete, true, `${casePath} must receive a complete response`);
    assert.equal(result.status, 500, `${casePath} must be answered with 500`);
    assert.equal(result.body, JSON.stringify({ error: "internal_error" }), `${casePath} must not expose the exception`);
    assert.doesNotMatch(result.body, /secret-detail|    at /);
  }
  const partial = await getLocal(port, "/partial");
  assert.equal(partial.complete, false, "a failure after the headers were sent must abort the response instead of completing it");
  const lookupFailure = await getLocal(port, "/v1/probes/probe_demo", { authorization: `Bearer ${probeToken}` });
  assert.equal(lookupFailure.status, 500, "an unexpected probe handler exception must be answered with 500");
  assert.equal(lookupFailure.body, JSON.stringify({ error: "internal_error" }));
  const healthy = await getLocal(port, "/healthz");
  assert.equal(healthy.status, 200, "the same server must keep serving after handler failures");
  assert.ok(guardLog.length >= 5 && guardLog.every((entry) => entry.event === "request_failed" && typeof entry.errorName === "string" && entry.message.length <= 200), "handler failures must be logged with a bounded message");
} finally {
  await new Promise((resolve) => guardServer.close(resolve));
}
console.log("PASS  output probe guards request handlers and compares credentials in constant time");

// L7: the output probe registered no SIGTERM handler, so as a container's PID 1 it ignored `docker stop` until
// Docker killed it after 10 s.
{
  const { installGracefulShutdown } = await import("../apps/output-probe/lib.mjs");
  const { assertGracefulShutdownBehaviour, assertProcessExitsOnSigterm } = await import("./fixtures/graceful-shutdown-scenarios.mjs");
  await assertGracefulShutdownBehaviour(installGracefulShutdown, "output probe");
  let abortedSignal = null;
  await assert.rejects(probeTarget({ ...target, fallbackStreamUrl: null }, { signal: AbortSignal.abort(), execute: async (_command, _arguments, options) => { abortedSignal = options.signal; throw new Error("aborted"); }, fetchImpl: async (_url, options) => { if (options.signal.aborted) throw new Error("aborted"); return new Response("{}"); } }));
  assert.equal(abortedSignal?.aborted, true, "the shutdown signal must reach ffprobe and ffmpeg so that they are killed");
  const { fileURLToPath } = await import("node:url");
  const ran = await assertProcessExitsOnSigterm({
    name: "output probe",
    args: [fileURLToPath(new URL("../apps/output-probe/index.mjs", import.meta.url))],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    portVariable: "OUTPUT_PROBE_PORT",
    env: { OUTPUT_PROBE_SHARED_TOKEN: "output-probe-shared-token-at-least-32-chars", OUTPUT_PROBE_TARGETS: JSON.stringify([{ id: "probe_demo", streamUrl: "rtmp://relay.internal/live/primary", avSyncProbeUrl: "http://analyzer.internal/av-sync" }]) }
  });
  console.log(`PASS  output probe stops listening on SIGTERM, aborts in-flight measurements after the grace period and exits 0 (process check: ${ran}) (L7)`);
}

function getLocal(port, requestPath, headers = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const request = http.get({ host: "127.0.0.1", port, path: requestPath, headers: { connection: "close", ...headers }, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => finish({ complete: true, status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", () => finish({ complete: false }));
      response.on("aborted", () => finish({ complete: false }));
    });
    const timer = setTimeout(() => { request.destroy(); finish({ complete: false }); }, 2_000);
    request.on("error", () => finish({ complete: false }));
  });
}
