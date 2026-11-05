import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probe = path.join(root, "apps", "output-probe", "index.mjs");
const target = JSON.stringify([{ id: "probe_fixture", streamUrl: "rtmp://relay.internal/live/fixture", avSyncProbeUrl: "https://sync.internal/fixture" }]);

const shortToken = spawnSync(process.execPath, [probe], {
  cwd: root,
  env: { ...process.env, OUTPUT_PROBE_SHARED_TOKEN: "short", OUTPUT_PROBE_TARGETS: target },
  encoding: "utf8"
});

assert.notEqual(shortToken.status, 0, "output probe must reject a short shared token before serving requests");
assert.match(`${shortToken.stderr}${shortToken.stdout}`, /OUTPUT_PROBE_SHARED_TOKEN must contain at least 32 non-whitespace characters/);

console.log("PASS  output probe rejects unsafe shared-token configuration before startup");

// H5 regression: malformed request targets, malformed percent-encoding and bad credentials must be answered
// with a complete 4xx response by the same running process instead of crashing it.
const sharedToken = "output-probe-shared-token-0123456789abcd";
const goodAuthorization = `Bearer ${sharedToken}`;
const sameLengthAuthorization = `Bearer ${"x".repeat(sharedToken.length)}`;
const fuzzTargetId = "fuzz_target_7f3c";
const probeProcess = await startProbe();
try {
  const { port } = probeProcess;
  const expectHealthy = async (context) => {
    const health = await send(port, { path: "/healthz" });
    assert.equal(health.complete, true, `output probe must still answer /healthz after ${context}`);
    assert.equal(health.status, 200, `output probe must still answer /healthz after ${context}`);
    assert.equal(probeProcess.child.exitCode, null, `output probe process must not exit after ${context}`);
  };

  for (const requestTarget of ["//", "/\\", "//[", "//:99999"]) {
    for (const method of ["GET", "POST", "DELETE"]) {
      for (const authorization of [undefined, goodAuthorization]) {
        const context = `${method} ${requestTarget} (${authorization ? "authorized" : "anonymous"})`;
        const result = await send(port, { method, path: requestTarget, headers: authorization ? { authorization } : {} });
        assert.equal(result.complete, true, `${context} must receive a complete response`);
        assert.equal(result.status, 400, `${context} must be rejected as an invalid request target`);
        assert.deepEqual(JSON.parse(result.body), { error: "invalid_request_target" });
        await expectHealthy(context);
      }
    }
  }

  const schemeRelative = await send(port, { path: "//x" });
  assert.equal(schemeRelative.complete, true, "GET //x must receive a complete response");
  assert.ok(schemeRelative.status >= 400 && schemeRelative.status < 500, "GET //x must be answered with a client error");
  await expectHealthy("GET //x");

  const malformedIds = ["/v1/probes/%E0%A4%A", "/v1/probes/%zz", "/v1/probes/a%"];
  for (const requestTarget of malformedIds) {
    const result = await send(port, { path: requestTarget, headers: { authorization: goodAuthorization } });
    assert.equal(result.complete, true, `GET ${requestTarget} must receive a complete response`);
    assert.equal(result.status, 400, `GET ${requestTarget} with valid credentials must be rejected as an invalid probe id`);
    assert.deepEqual(JSON.parse(result.body), { error: "invalid_probe_id" });
    await expectHealthy(`GET ${requestTarget}`);
  }

  for (const requestTarget of [...malformedIds, `/v1/probes/${fuzzTargetId}`]) {
    for (const [label, headers] of [["no authorization", {}], ["a shorter token", { authorization: "Bearer short" }], ["a same-length wrong token", { authorization: sameLengthAuthorization }]]) {
      const result = await send(port, { path: requestTarget, headers });
      assert.equal(result.complete, true, `GET ${requestTarget} with ${label} must receive a complete response`);
      assert.equal(result.status, 401, `GET ${requestTarget} with ${label} must be unauthorized before the id is decoded`);
      await expectHealthy(`GET ${requestTarget} with ${label}`);
    }
    const rawStatus = await sendRaw(port, Buffer.concat([
      Buffer.from(`GET ${requestTarget} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer `, "latin1"),
      Buffer.from([0xc3, 0xa9]),
      Buffer.from(`${sharedToken.slice(2)}\r\nConnection: close\r\n\r\n`, "latin1")
    ]));
    assert.match(rawStatus, /^HTTP\/1\.1 401 /, `GET ${requestTarget} with non-ASCII credential bytes must be unauthorized`);
    await expectHealthy(`GET ${requestTarget} with non-ASCII credential bytes`);
  }

  const invalidHeaderName = await sendRaw(port, Buffer.from("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nBad Header: value\r\nConnection: close\r\n\r\n", "latin1"));
  assert.match(invalidHeaderName, /^HTTP\/1\.1 400 /, "an unparsable header name must be answered by the HTTP parser with 400");
  await expectHealthy("an unparsable header name");

  const unknownProbe = await send(port, { path: "/v1/probes/unknown_target", headers: { authorization: goodAuthorization } });
  assert.equal(unknownProbe.status, 404, "an authorized request for an unknown target must return 404");
  assert.deepEqual(JSON.parse(unknownProbe.body), { error: "probe_not_found" });

  const unavailable = await send(port, { path: `/v1/probes/${fuzzTargetId}`, headers: { authorization: goodAuthorization } });
  assert.equal(unavailable.complete, true, "a failing measurement must still produce a complete response");
  assert.equal(unavailable.status, 503, "a failing measurement must keep the sanitized 503 response");
  assert.deepEqual(JSON.parse(unavailable.body), { error: "measurement_unavailable" });
  await expectHealthy("a failing measurement");

  assert.equal(probeProcess.startedLines().length, 1, "the output probe must not restart while serving malformed requests");
  assert.equal(probeProcess.startedLines()[0].pid, probeProcess.child.pid, "the started log must report the serving process id");
} finally {
  probeProcess.child.kill();
}

console.log("PASS  output probe answers malformed request targets, ids and credentials without crashing");

async function startProbe() {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await freePort();
    const child = spawn(process.execPath, [probe], {
      cwd: root,
      env: {
        ...process.env,
        OUTPUT_PROBE_PORT: String(port),
        OUTPUT_PROBE_SHARED_TOKEN: sharedToken,
        OUTPUT_PROBE_TARGETS: JSON.stringify([{ id: fuzzTargetId, streamUrl: "rtmp://127.0.0.1:9/live/x", avSyncProbeUrl: "http://127.0.0.1:9/av" }]),
        OUTPUT_PROBE_TIMEOUT_MS: "500",
        OUTPUT_PROBE_AUDIO_SAMPLE_SECONDS: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const startedLines = () => stdout.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((entry) => entry?.event === "started");
    const started = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      const check = () => { if (startedLines().length) { clearTimeout(timer); resolve(true); } };
      child.stdout.on("data", check);
      child.once("exit", () => { clearTimeout(timer); resolve(false); });
      check();
    });
    if (started) return { child, port, startedLines, output: () => ({ stdout, stderr }) };
    child.kill();
    lastError = new Error(`output probe did not start (attempt ${attempt + 1}): ${stderr.slice(0, 500)}`);
    if (!stderr.includes("EADDRINUSE")) break;
  }
  throw lastError;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function send(port, { method = "GET", path: requestPath, headers = {} }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const request = http.request({ host: "127.0.0.1", port, path: requestPath, method, headers: { connection: "close", ...headers }, agent: false });
    const timer = setTimeout(() => { request.destroy(); finish({ complete: false }); }, 2_000);
    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => finish({ complete: true, status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", () => finish({ complete: false }));
    });
    request.on("error", () => finish({ complete: false }));
    request.end();
  });
}

function sendRaw(port, payload) {
  return new Promise((resolve) => {
    let received = "";
    const socket = net.connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => { socket.destroy(); resolve(received); }, 2_000);
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => { received += chunk; });
    socket.on("connect", () => socket.write(payload));
    socket.on("close", () => { clearTimeout(timer); resolve(received); });
    socket.on("error", () => undefined);
  });
}
