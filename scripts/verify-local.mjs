import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pythonIndex = process.argv.indexOf("--python");
const python = pythonIndex >= 0 ? process.argv[pythonIndex + 1] : undefined;
const withGateway = process.argv.includes("--with-gateway");
if (withGateway && !python) {
  console.error("ERROR --with-gateway requires --python /absolute/path/to/python");
  process.exit(1);
}
const checks = [
  ["run", "deploy:check", "--", "--allow-placeholders"],
  ["run", "deploy:check:test"],
  ["run", "backup:automation:check"],
  ["run", "control-plane:compose:check"],
  ["run", "runtime:compose:check"],
  ["run", "console:page-auth:check"],
  ["run", "console:security-headers:check"],
  ["run", "console:client-requests:check"],
  ["run", "policy:red-team"],
  ["run", "preflight:check"],
  ["run", "lifecycle:authz:check"],
  ["run", "command:confirmation:check"],
  ["run", "service-ingest:auth:check"],
  ["run", "start:ack:check"],
  ["run", "runtime:watchdog:check"],
  ["run", "runtime:outbox:check"],
  ["run", "runtime:telemetry-alerts:check"],
  ["run", "entitlement:check"],
  ["run", "runtime:media:check"],
  ["run", "runtime:voice:check"],
  ["run", "runtime:journal:check"],
  ["run", "runtime:images:check"],
  ["run", "runtime:worker:config:test"],
  ["run", "runtime:worker:health:test"],
  ["run", "runtime:acceptance:test"],
  ["run", "observer:runtime:test"],
  ["run", "observer:targets:test"],
  ["run", "observer:targets:apply:test"],
  ["run", "output-probe:test"],
  ["run", "output-probe:config:test"],
  ["run", "output-probe:response:check"],
  ["run", "channel-adapter:test"],
  ["run", "alert-notifier:test"],
  ["run", "alert-notifier:health:check"],
  ["run", "typecheck"],
  ["run", "lint"],
  ["run", "build"]
];
const nodeEntrypoints = [
  "apps/runtime-worker/index.mjs",
  "apps/runtime-observer/index.mjs",
  "apps/runtime-observer/targets.mjs",
  "apps/output-probe/index.mjs",
  "apps/channel-adapter/index.mjs",
  "apps/alert-notifier/index.mjs"
];

for (const args of checks) {
  console.log(`RUN   npm ${args.join(" ")}`);
  const result = spawnSync(npm, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const entrypoint of nodeEntrypoints) {
  console.log(`RUN   node --check ${entrypoint}`);
  const result = spawnSync(process.execPath, ["--check", entrypoint], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const gatewayChecks = withGateway ? [
  ["-m", "py_compile", "runtime/gateway/app.py", "runtime/gateway/audio.py", "scripts/test-runtime-gateway-config.py"],
  ["scripts/test-runtime-gateway-config.py"],
  ["scripts/test-runtime-gateway-errors.py"],
  ["scripts/test-runtime-gateway-audio.py"],
  ["scripts/test-runtime-gateway-concurrency.py"]
] : [];
for (const args of gatewayChecks) {
  console.log(`RUN   ${python} ${args.join(" ")}`);
  const result = spawnSync(python, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`PASS  local verification completed (${checks.length + nodeEntrypoints.length + gatewayChecks.length} checks; PostgreSQL, Docker, GPU, and platform acceptance are intentionally external${withGateway ? "" : "; add --with-gateway --python after installing runtime/gateway/requirements.txt to verify Gateway Python"})`);
