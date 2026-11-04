import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeCommand, localChecks, LOCAL_CHECKS, validateLocalChecks } from "./verify-local-checks.mjs";
import { CI_ONLY_STEPS, notRunCiSteps, validateCiOnlySteps } from "./ci-required-steps.mjs";
import { loadWorkflow, WorkflowLoadError } from "./lib/workflow-model.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pythonIndex = process.argv.indexOf("--python");
const python = pythonIndex >= 0 ? process.argv[pythonIndex + 1] : undefined;
const withGateway = process.argv.includes("--with-gateway");
if (withGateway && !python) {
  console.error("ERROR --with-gateway requires --python /absolute/path/to/python");
  process.exit(1);
}

const listErrors = [...validateLocalChecks(LOCAL_CHECKS), ...validateCiOnlySteps(CI_ONLY_STEPS)];
if (listErrors.length > 0) {
  for (const error of listErrors) console.error(`ERROR source=Local_Verification reason=${error}`);
  process.exit(2);
}

let workflow;
try {
  workflow = loadWorkflow(path.join(root, ".github", "workflows", "ci.yml"));
} catch (error) {
  if (!(error instanceof WorkflowLoadError)) throw error;
  console.error(`ERROR source=CI_Pipeline reason=${error.message}`);
  process.exit(2);
}
const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};

function spawnCheck(check) {
  switch (check.kind) {
    case "npm":
      return spawnSync(npm, ["run", check.script, ...(check.args ?? [])], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    case "node-check":
      return spawnSync(process.execPath, ["--check", check.entry], { cwd: root, stdio: "inherit" });
    case "python":
      return spawnSync(python, [check.file], { cwd: root, stdio: "inherit" });
    case "py-compile":
      return spawnSync(python, ["-m", "py_compile", ...check.files], { cwd: root, stdio: "inherit" });
    default:
      throw new Error(`unknown check kind: ${check.kind}`);
  }
}

const checks = localChecks({ withGateway });
for (const check of checks) {
  console.log(`RUN   [${check.label}] ${describeCommand(check, { python })}`);
  const result = spawnCheck(check);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const skippedChecks = LOCAL_CHECKS.filter((check) => !checks.includes(check));
const notRun = notRunCiSteps({ workflow, executedChecks: checks, skippedChecks, scripts, root });
if (notRun.length === 0) console.log("NOT RUN  无");
for (const step of notRun) console.log(`NOT RUN  ${step.job}  ${step.command}  原因：${step.reason}`);

console.log(`PASS  local verification completed (${checks.length} checks; PostgreSQL, Docker, GPU, and platform acceptance are intentionally external; ${notRun.length} CI verification steps not run locally are listed above${withGateway ? "" : "; add --with-gateway --python after installing runtime/gateway/requirements.txt to verify Gateway Python"})`);
