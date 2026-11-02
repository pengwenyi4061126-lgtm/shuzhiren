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

for (const args of checks) {
  console.log(`RUN   npm ${args.join(" ")}`);
  const result = spawnSync(npm, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`PASS  local verification completed (${checks.length} checks; PostgreSQL, Docker, GPU, and platform acceptance are intentionally external)`);
