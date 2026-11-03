import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
