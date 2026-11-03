import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
