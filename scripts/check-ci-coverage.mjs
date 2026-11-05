// CI_Coverage_Gate (Requirement 2.2, 2.3, 2.9): every Local_Verification
// check, including the --with-gateway Python checks, must have at least one
// covering verification step in ci.yml. The judgement is covers() from
// scripts/verify-local-checks.mjs, rules (a)-(e) of Requirement 2.2.
//
// Usage: node scripts/check-ci-coverage.mjs [--workflow <path>] [--checks <module>]
//   --workflow  defaults to .github/workflows/ci.yml
//   --checks    module exporting LOCAL_CHECKS; defaults to scripts/verify-local-checks.mjs
// Exit codes: 0 every check covered; 1 one `UNCOVERED  <id>` line per
// uncovered check; 2 the check list or the workflow cannot be read or parsed,
// or yields zero checks or zero verification steps (`ERROR source=...`).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { covers, validateLocalChecks } from "./verify-local-checks.mjs";
import { commands, jobs, loadWorkflow, steps, tokenize, UnparsableCommand, WorkflowLoadError } from "./lib/workflow-model.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`ERROR usage: ${name} requires a path`);
    process.exit(2);
  }
  return path.resolve(value);
}

function fail(source, reason) {
  console.error(`ERROR source=${source} reason=${reason}`);
  process.exit(2);
}

const workflowFile = option("--workflow", path.join(root, ".github", "workflows", "ci.yml"));
const checksModule = option("--checks", path.join(root, "scripts", "verify-local-checks.mjs"));

let checks;
try {
  ({ LOCAL_CHECKS: checks } = await import(pathToFileURL(checksModule).href));
} catch (error) {
  fail("Local_Verification", `cannot import ${checksModule} (${error.code ?? error.message})`);
}
if (!Array.isArray(checks)) fail("Local_Verification", `${checksModule} does not export a LOCAL_CHECKS array`);
if (checks.length === 0) fail("Local_Verification", `${checksModule} exports an empty LOCAL_CHECKS`);
const listErrors = validateLocalChecks(checks);
if (listErrors.length > 0) fail("Local_Verification", listErrors.join("; "));

let scripts;
try {
  scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
} catch (error) {
  fail("Local_Verification", `cannot read package.json scripts (${error.code ?? error.message})`);
}

let workflow;
try {
  workflow = loadWorkflow(workflowFile);
} catch (error) {
  if (!(error instanceof WorkflowLoadError)) throw error;
  fail("CI_Pipeline", error.message);
}

/** Verification steps of the workflow with their tokenized command lines. */
const ciSteps = [];
for (const job of jobs(workflow)) {
  for (const step of steps(job)) {
    if (step.isPreparation) continue;
    const lines = commands(step);
    if (lines.length === 0) continue;
    const tokenized = [];
    for (const line of lines) {
      try {
        tokenized.push(tokenize(line));
      } catch (error) {
        if (!(error instanceof UnparsableCommand)) throw error;
        console.error(`WARN unparsable command ${job.id}/${step.index}`);
      }
    }
    ciSteps.push({ key: `${job.id}/${step.index}`, tokenized });
  }
}
if (ciSteps.length === 0) fail("CI_Pipeline", `${workflowFile} has no verification run steps`);

const context = { scripts, root };
const coveringSteps = new Set();
const uncovered = [];
for (const check of checks) {
  const covering = ciSteps.filter((step) => step.tokenized.some((tokens) => covers(tokens, check, context)));
  if (covering.length === 0) uncovered.push(check);
  for (const step of covering) coveringSteps.add(step.key);
}

if (uncovered.length > 0) {
  for (const check of uncovered) console.error(`UNCOVERED  ${check.id}`);
  console.error(`FAIL  CI coverage: ${uncovered.length} of ${checks.length} Local_Verification checks have no covering step in ${path.relative(root, workflowFile).split(path.sep).join("/")}`);
  process.exit(1);
}
console.log(`PASS  CI coverage: ${checks.length} Local_Verification checks covered by ${coveringSteps.size} CI_Pipeline steps`);
