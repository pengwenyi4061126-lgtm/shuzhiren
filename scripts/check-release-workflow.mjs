// Release_Workflow_Gate (Requirement 3.5, 3.6, 3.7; audit M20 in part).
//
// Text checks keep the protected ten-image publishing and signing controls of
// the release workflow, the CosyVoice image and the evidence scripts. Action
// checks read every `uses:` through actionRefs() of scripts/lib/workflow-model.mjs:
//   MISSING_ACTION <name>  one of the five required actions is not referenced;
//   ACTION_REF job=<jobId> step=<name|index> action=<name> ref=<ref>
//                          a third-party reference (not starting with `./`) whose
//                          ref is not a full 40-hex commit SHA. `index` is the
//                          0-based position in the job's steps.
// This gate checks the reference format only; ci:workflow:check (W5) compares
// the SHAs and `# <tag>` comments with .github/action-pins.json.
// Run checks read every step through steps() of the same module (audit H1):
//   RUN_INPUT_INTERPOLATION job=<jobId> step=<name|index>
//                          the step's `run:` text contains a `${{ … }}` expression
//                          that reads `inputs` or `github.event` (workflow_dispatch
//                          inputs and the rest of the event payload), in any
//                          spacing or letter case. Such values must reach the shell
//                          through the step's `env:` and be read as "$NAME".
//                          One line per step.
//
// Usage: node scripts/check-release-workflow.mjs [--workflow <path>]
//   --workflow  defaults to .github/workflows/release.yml; the other files are
//               always read from the repository root.
// Exit codes: 0 pass; 1 one line per violation, all listed; 2 a file cannot be
// read, the workflow cannot be parsed, or the arguments are invalid (`ERROR ...`).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { actionRefs, jobs, loadWorkflow, steps, WorkflowLoadError } from "./lib/workflow-model.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_ACTIONS = Object.freeze([
  "docker/setup-buildx-action",
  "docker/login-action",
  "docker/build-push-action",
  "actions/upload-artifact",
  "actions/download-artifact"
]);
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
// The body of each `${{ … }}` expression; an unterminated `${{` runs to the end of the text.
const EXPRESSION = /\$\{\{([\s\S]*?)(?:\}\}|$)/g;
// `inputs.x`, `inputs['x']`, `github.event…`, `github['event']`. Expression
// context names are case-insensitive in GitHub Actions.
const INPUT_CONTEXT = /(?<![\w.-])(?:inputs\s*[.[]|github\s*(?:\.\s*event\b|\[\s*['"]event['"]\s*\]))/i;

function readsInputContext(run) {
  for (const match of run.matchAll(EXPRESSION)) if (INPUT_CONTEXT.test(match[1])) return true;
  return false;
}

function fail(reason) {
  console.error(`ERROR ${reason}`);
  process.exit(2);
}

function parseArguments(argv) {
  let workflow = path.join(root, ".github", "workflows", "release.yml");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--workflow") fail(`usage: unknown argument ${argv[i]}; expected [--workflow <path>]`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail("usage: --workflow requires a path");
    workflow = path.resolve(value);
    i += 1;
  }
  return { workflow };
}

function display(file) {
  const relative = path.relative(root, file);
  return relative.startsWith("..") || path.isAbsolute(relative) ? file : relative.split(path.sep).join("/");
}

const { workflow: workflowFile } = parseArguments(process.argv.slice(2));

let workflow;
try {
  workflow = loadWorkflow(workflowFile);
} catch (error) {
  if (!(error instanceof WorkflowLoadError)) throw error;
  fail(`source=${display(workflowFile)} reason=${error.reason}`);
}

const files = {
  cosyvoice: "runtime/cosyvoice/Dockerfile",
  cosyvoiceIgnore: "runtime/cosyvoice/Dockerfile.dockerignore",
  assembler: "scripts/assemble-release-evidence.mjs",
  evidence: "scripts/lib/release-evidence.mjs",
  result: "scripts/write-release-image-result.mjs"
};
const contents = { workflow: workflow.rawText };
for (const [name, file] of Object.entries(files)) {
  try {
    contents[name] = readFileSync(path.join(root, file), "utf8");
  } catch (error) {
    fail(`source=${file} reason=cannot read file (${error.code ?? error.message})`);
  }
}

const violations = [];
function requireText(text, sources, message) {
  for (const source of sources) if (!text.includes(source)) violations.push(`${message}: ${source}`);
}

requireText(contents.workflow, ["workflow_dispatch:", "github.ref_protected", "platforms: linux/amd64", "push: true", "sbom: true", "provenance: mode=max", "org.opencontainers.image.revision=${{ github.sha }}", "self-hosted", "shuzhiren-release", "create-deployment-release-manifest.mjs"], "Release workflow must retain protected ten-image publishing and signing control");
for (const key of ["CONTROL_PLANE_IMAGE", "CONTROL_PLANE_MIGRATOR_IMAGE", "RUNTIME_GATEWAY_IMAGE", "RUNTIME_WORKER_IMAGE", "RUNTIME_OBSERVER_IMAGE", "OUTPUT_PROBE_IMAGE", "CHANNEL_ADAPTER_IMAGE", "ALERT_NOTIFIER_IMAGE", "LIVETALKING_IMAGE", "COSYVOICE_IMAGE"]) {
  if (!contents.workflow.includes(`key: ${key}`)) violations.push(`Release workflow must publish ${key}`);
}
requireText(contents.cosyvoice, ["COPY --chown=cosyvoice:cosyvoice vendor/CosyVoice /opt/CosyVoice/CosyVoice", "MINIFORGE_SHA256", "sha256sum -c", "USER cosyvoice", "org.opencontainers.image.revision"], "CosyVoice release image must retain controlled source and non-root execution");
requireText(contents.cosyvoiceIgnore, ["vendor/*", "!vendor/CosyVoice", "vendor/CosyVoice/.git", "models", "weights", "secrets"], "CosyVoice build context must exclude unsafe local content");
requireText(contents.assembler, ["assembleReleaseEvidence(", "releaseImagesFromResults("], "Release evidence assembly must read the Buildx attestations from the registry");
requireText(contents.evidence, ["oci-buildx-sbom-index", "oci-buildx-provenance-index", "release image results must contain exactly ten files", "attestation-manifest"], "Release evidence assembly must bind all Buildx attestations");
requireText(contents.result, ["schemaVersion: 2", "--digest", "--revision"], "Release image result must bind pushed digest and revision");

const refs = actionRefs(workflow);
for (const name of REQUIRED_ACTIONS) {
  if (!refs.some((ref) => ref.action === name)) violations.push(`MISSING_ACTION ${name}`);
}
const thirdParty = refs.filter((ref) => !ref.uses.startsWith("./"));
for (const ref of thirdParty) {
  if (ref.ref !== null && FULL_COMMIT_SHA.test(ref.ref)) continue;
  violations.push(`ACTION_REF job=${ref.jobId} step=${ref.name ?? ref.index ?? "(job)"} action=${ref.action} ref=${ref.ref ?? "(none)"}`);
}

let runSteps = 0;
for (const job of jobs(workflow)) {
  for (const step of steps(job)) {
    if (step.run === undefined) continue;
    runSteps += 1;
    if (readsInputContext(step.run)) violations.push(`RUN_INPUT_INTERPOLATION job=${step.jobId} step=${step.name ?? step.index}`);
  }
}

if (violations.length > 0) {
  for (const violation of violations) console.error(violation);
  console.error(`FAIL  release workflow gate: ${violations.length} violation(s) in ${display(workflowFile)}`);
  process.exit(1);
}
console.log(`PASS  protected release workflow publishes ten attested image targets and a signed release envelope (${thirdParty.length} third-party action references pinned to full commit SHAs, ${runSteps} run: steps without inputs or github.event expressions in ${display(workflowFile)})`);
