import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const checks = [
  ["run", "deploy:check", "--", "--allow-placeholders"],
  ["run", "deploy:check:test"],
  ["run", "policy:red-team"],
  ["run", "preflight:check"],
  ["run", "start:ack:check"],
  ["run", "runtime:watchdog:check"],
  ["run", "runtime:acceptance:test"],
  ["run", "observer:runtime:test"],
  ["run", "observer:targets:test"],
  ["run", "observer:targets:apply:test"],
  ["run", "output-probe:test"],
  ["run", "channel-adapter:test"],
  ["run", "alert-notifier:test"],
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

console.log(`PASS  local verification completed (${checks.length + nodeEntrypoints.length} checks; PostgreSQL, Docker, GPU, Python runtime dependencies, and platform acceptance are intentionally external)`);
