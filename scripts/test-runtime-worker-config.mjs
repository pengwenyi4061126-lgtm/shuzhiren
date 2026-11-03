import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

console.log("PASS  runtime worker rejects weak shared tokens before serving work");
