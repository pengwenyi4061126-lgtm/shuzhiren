import { spawnSync } from "node:child_process";

const [script, ...args] = process.argv.slice(2);
if (!script) throw new Error("Usage: node scripts/run-python-test.mjs <script.py> [...args]");

const requested = process.env.PYTHON?.trim();
const candidates = requested ? [requested] : process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];

for (const command of candidates) {
  const result = spawnSync(command, [script, ...args], { stdio: "inherit" });
  if (result.error?.code === "ENOENT") continue;
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

throw new Error("Python 3 is required; set PYTHON to its executable path when it is not on PATH");
