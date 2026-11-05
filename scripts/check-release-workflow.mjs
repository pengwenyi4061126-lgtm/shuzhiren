// Release_Workflow_Gate CLI (Requirement 3.5-3.7, 13; audit H1, M20 in part).
// The rules live in scripts/lib/release-workflow-gate.mjs and read the workflow
// as YAML through scripts/lib/workflow-model.mjs:
//   dispatch-inputs          on.workflow_dispatch declares no inputs
//   run-expression           no `run:` contains a `${{ }}` expression (inputs,
//                            github.event, vars, secrets or any other context);
//                            values reach the shell through env: as "$NAME"
//   input-env-scope          workflow/job env: does not read inputs or github.event
//   env-quote                every env: value mapped from `${{ }}` is read in
//                            double quotes in `run:`
//   run-shell-syntax         no backtick substitution or heredoc in `run:`
//   registry-source          login registry and image tags use vars.RELEASE_REGISTRY
//   registry-validation      validate-registry runs before the first registry use
//   release-vars-source      signing values from vars, validated before evidence and
//                            signing; build arguments from runtime/cosyvoice/miniforge.json
//   credentials-environment  build-and-push, assemble-and-sign and every job reading
//                            registry secrets or vars declare environment: release-production
//   allowlist-format         .github/release-registry-allowlist.json format
//   pinned-actions           MISSING_ACTION / ACTION_REF (40-hex SHAs; ci:workflow:check
//                            W5 compares them with .github/action-pins.json)
//   release-structure        ten images, protected refs, attestations, self-hosted signer,
//                            persist-credentials: false
//   companion-files          CosyVoice Dockerfile, dockerignore and evidence scripts
//
// Usage: node scripts/check-release-workflow.mjs [--workflow <path>] [--allowlist <path>]
//   --workflow   default .github/workflows/release.yml
//   --allowlist  default .github/release-registry-allowlist.json
// The companion files are always read from the repository root.
// Output: `ERROR [<rule>] job=<jobId> step=<name|#n>: <detail>` per violation and
// exit 1 (a workflow that cannot be parsed is `ERROR [yaml-parse]: ...` and
// exit 1); `PASS  release workflow gate (<n> rules) ...` and exit 0; a file that
// cannot be read (`ERROR source=<file> reason=...`) or invalid arguments exit 2.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkReleaseWorkflow, COMPANION_REQUIREMENTS, formatViolation, RULES } from "./lib/release-workflow-gate.mjs";
import { actionRefs, parseWorkflow, WorkflowLoadError } from "./lib/workflow-model.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(reason) {
  console.error(`ERROR ${reason}`);
  process.exit(2);
}

function parseArguments(argv) {
  const options = {
    "--workflow": path.join(root, ".github", "workflows", "release.yml"),
    "--allowlist": path.join(root, ".github", "release-registry-allowlist.json")
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!Object.hasOwn(options, key) || seen.has(key)) fail(`usage: unknown or repeated argument ${key}; expected [--workflow <path>] [--allowlist <path>]`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`usage: ${key} requires a path`);
    options[key] = path.resolve(value);
    seen.add(key);
  }
  return { workflowFile: options["--workflow"], allowlistFile: options["--allowlist"] };
}

function display(file) {
  const relative = path.relative(root, file);
  return relative.startsWith("..") || path.isAbsolute(relative) ? file : relative.split(path.sep).join("/");
}

function read(file, label = display(file)) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    fail(`source=${label} reason=cannot read file (${error.code ?? error.message})`);
  }
}

const { workflowFile, allowlistFile } = parseArguments(process.argv.slice(2));

// Design 1.4: a workflow that cannot be parsed, or has no jobs mapping, is a
// yaml-parse violation (exit 1) and no other rule runs.
function yamlParseFailure(reason) {
  console.error(formatViolation({ rule: "yaml-parse", detail: `${display(workflowFile)}: ${reason}` }));
  console.error(`FAIL  release workflow gate: 1 violation(s) in ${display(workflowFile)}`);
  process.exit(1);
}

let workflow;
try {
  workflow = parseWorkflow(read(workflowFile), display(workflowFile));
} catch (error) {
  if (!(error instanceof WorkflowLoadError)) throw error;
  yamlParseFailure(error.reason);
}
if (workflow.doc.jobs === null || typeof workflow.doc.jobs !== "object" || Array.isArray(workflow.doc.jobs)) yamlParseFailure("workflow has no jobs mapping");
const allowlistText = read(allowlistFile);
const companionFiles = Object.fromEntries(Object.keys(COMPANION_REQUIREMENTS).map((file) => [file, read(path.join(root, file), file)]));

const violations = checkReleaseWorkflow({ workflow, allowlistText, companionFiles });
if (violations.length > 0) {
  for (const violation of violations) console.error(formatViolation(violation));
  console.error(`FAIL  release workflow gate: ${violations.length} violation(s) in ${display(workflowFile)}`);
  process.exit(1);
}
const pinned = actionRefs(workflow).filter((ref) => !ref.uses.startsWith("./")).length;
console.log(`PASS  release workflow gate (${RULES.length} rules): ${display(workflowFile)} has no workflow_dispatch inputs, no \${{ }} in run: steps, release-production on both jobs, an allowlisted registry check before login and ${pinned} third-party action references pinned to full commit SHAs`);
