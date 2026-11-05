import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = await readFile(path.join(root, "apps/runtime-worker/index.mjs"), "utf8");

assert.match(workerSource, /AbortSignal\.timeout\(timeoutMs\)/, "runtime worker must bound Gateway command delivery");
assert.match(workerSource, /Math\.min\(gatewayRequestTimeoutMs, Math\.floor\(event\.claimStartedAt \+ leaseMs - leaseMarginMs - performance\.now\(\)\)\)/, "runtime worker must end a delivery request before its outbox lease expires (M10)");
assert.doesNotMatch(workerSource, /await response\.text\(\)/, "runtime worker must not persist arbitrary Gateway response bodies in delivery errors");
assert.match(workerSource, /let lastSuccessfulTickAt = null/, "runtime worker must wait for a successful tick before reporting healthy");

for (const token of ["short", "this token has whitespace and is intentionally invalid"]) {
  const result = spawnSync(process.execPath, ["apps/runtime-worker/index.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://worker:password@127.0.0.1:5432/shuzhiren",
      RUNTIME_GATEWAY_URL: "http://127.0.0.1:8090",
      RUNTIME_SHARED_TOKEN: token
    },
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0, "runtime worker must reject a weak shared token before starting");
  assert.match(`${result.stderr}${result.stdout}`, /RUNTIME_SHARED_TOKEN must contain at least 32 non-whitespace characters/);
}

const invalidTimeout = spawnSync(process.execPath, ["apps/runtime-worker/index.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    DATABASE_URL: "postgresql://worker:password@127.0.0.1:5432/shuzhiren",
    RUNTIME_GATEWAY_URL: "http://127.0.0.1:8090",
    RUNTIME_SHARED_TOKEN: "runtime-worker-token-at-least-32-bytes",
    RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS: "0"
  },
  encoding: "utf8"
});
assert.notEqual(invalidTimeout.status, 0, "runtime worker must reject an unbounded Gateway delivery timeout before starting");
assert.match(`${invalidTimeout.stderr}${invalidTimeout.stdout}`, /RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS must be an integer between 100 and 60000/);

console.log("PASS  runtime worker rejects unsafe command-delivery timeout configuration before serving work");

// M10: metering at USAGE_METER_POLL_MS=60000 inside the delivery loop could skip whole minutes; the separate
// metering loop runs at least every 30 s.
{
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:http");
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ["apps/runtime-worker/index.mjs"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: "postgresql://worker:password@127.0.0.1:1/shuzhiren", DATABASE_QUERY_TIMEOUT_MS: "100", RUNTIME_GATEWAY_URL: "http://127.0.0.1:8090", RUNTIME_SHARED_TOKEN: "runtime-worker-token-at-least-32-bytes", USAGE_METER_POLL_MS: "60000", RUNTIME_WORKER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 10_000;
  while (!output.includes('"event":"worker.started"') && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
  child.kill("SIGKILL");
  const started = output.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.event === "worker.started");
  assert.equal(started?.usageMeterPollMs, 30_000, "a metering interval above 30 s must be capped at 30 s");
}
console.log("PASS  runtime worker meters live minutes at least every 30 s (M10)");
