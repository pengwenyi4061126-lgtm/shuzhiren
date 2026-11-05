import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSurvivesIdleConnectionTermination } from "./fixtures/pool-error-scenario.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = path.join(root, "apps", "runtime-worker", "index.mjs");
const port = await availablePort();
const child = spawn(process.execPath, [worker], {
  cwd: root,
  env: {
    ...process.env,
    DATABASE_URL: "postgresql://worker:password@127.0.0.1:1/shuzhiren",
    DATABASE_QUERY_TIMEOUT_MS: "100",
    RUNTIME_GATEWAY_URL: "http://127.0.0.1:8090",
    RUNTIME_SHARED_TOKEN: "runtime-worker-token-at-least-32-bytes",
    OUTBOX_POLL_MS: "10",
    SCHEDULER_POLL_MS: "10",
    RUNTIME_WATCHDOG_POLL_MS: "10",
    USAGE_METER_POLL_MS: "10",
    RUNTIME_WORKER_PORT: String(port)
  },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      const health = await response.json();
      return response.status === 503 && health.ok === false && health.lastSuccessfulTickAt === null;
    } catch {
      return false;
    }
  }, 5_000);
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

console.log("PASS  runtime worker stays unhealthy until its first successful database tick");

// M3: every pool-owning service creates its pool through its own copy of db.mjs (each image copies only its
// service directory), and the copies must not drift apart.
const dbModules = ["runtime-worker", "channel-adapter", "alert-notifier"].map((service) => path.join(root, "apps", service, "db.mjs"));
const dbDigests = new Set(dbModules.map((file) => createHash("sha256").update(readFileSync(file)).digest("hex")));
assert.equal(dbDigests.size, 1, `the db.mjs copies must be byte-identical: ${dbModules.join(", ")}`);

// M3: pg-pool emits "error" when an idle connection is terminated; without a listener the worker exited.
await assertSurvivesIdleConnectionTermination({
  name: "runtime worker",
  entry: worker,
  cwd: root,
  portVariable: "RUNTIME_WORKER_PORT",
  env: {
    DATABASE_QUERY_TIMEOUT_MS: "2000",
    RUNTIME_GATEWAY_URL: "http://127.0.0.1:8090",
    RUNTIME_SHARED_TOKEN: "runtime-worker-token-at-least-32-bytes",
    OUTBOX_POLL_MS: "60000",
    SCHEDULER_POLL_MS: "60000",
    RUNTIME_WATCHDOG_POLL_MS: "60000",
    USAGE_METER_POLL_MS: "60000"
  }
});
console.log("PASS  runtime worker survives the termination of idle database connections and logs the pool error (M3)");

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve worker health port");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for unhealthy runtime worker");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
