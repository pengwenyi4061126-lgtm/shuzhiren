import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = await readFile(path.join(root, "apps/runtime-worker/index.mjs"), "utf8");

assert.match(workerSource, /AbortSignal\.timeout\(gatewayRequestTimeoutMs\)/, "runtime worker must bound Gateway command delivery");
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
