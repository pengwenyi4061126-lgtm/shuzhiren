// Release_Workflow_Gate rules (Requirement 3.5-3.7, 13; audit H1). Pure
// functions over the read-only workflow model of scripts/lib/workflow-model.mjs
// (js-yaml FAILSAFE_SCHEMA: every scalar is a string). The CLI shell is
// scripts/check-release-workflow.mjs.
//
// checkReleaseWorkflow({ workflow, allowlistText, companionFiles }) returns
// Violation[] = { rule, jobId?, step?, detail }, where `step` is the step's
// `name` or `#<1-based position>`. Rule IDs are listed in RULES.
import { parseAllowlist } from "../release-environment.mjs";
import { scanShellQuotes } from "./shell-quote-scan.mjs";
import { actionRefs, jobs, steps } from "./workflow-model.mjs";

export const RULES = Object.freeze([
  "yaml-parse",
  "dispatch-inputs",
  "run-expression",
  "input-env-scope",
  "env-quote",
  "run-shell-syntax",
  "registry-source",
  "registry-validation",
  "release-vars-source",
  "credentials-environment",
  "allowlist-format",
  "pinned-actions",
  "release-structure",
  "companion-files"
]);

export const REQUIRED_ACTIONS = Object.freeze([
  "docker/setup-buildx-action",
  "docker/login-action",
  "docker/build-push-action",
  "actions/upload-artifact",
  "actions/download-artifact"
]);
export const IMAGE_KEYS = Object.freeze(["CONTROL_PLANE_IMAGE", "CONTROL_PLANE_MIGRATOR_IMAGE", "RUNTIME_GATEWAY_IMAGE", "RUNTIME_WORKER_IMAGE", "RUNTIME_OBSERVER_IMAGE", "OUTPUT_PROBE_IMAGE", "CHANNEL_ADAPTER_IMAGE", "ALERT_NOTIFIER_IMAGE", "LIVETALKING_IMAGE", "COSYVOICE_IMAGE"]);
export const RELEASE_ENVIRONMENT = "release-production";
const BUILD_JOB = "build-and-push";
const SIGN_JOB = "assemble-and-sign";
const SIGNING_VARIABLES = Object.freeze(["RELEASE_SIGNING_KEY_PATH", "RELEASE_ISSUER", "RELEASE_KEY_ID"]);
const ALLOWLIST_PATH = ".github/release-registry-allowlist.json";
const MINIFORGE_PIN = "runtime/cosyvoice/miniforge.json";
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

// The body of each `${{ … }}` expression; an unterminated `${{` runs to the end of the text.
const EXPRESSION = /\$\{\{([\s\S]*?)(?:\}\}|$)/g;
// Expression context names are case-insensitive in GitHub Actions.
const CONTEXTS = Object.freeze([
  ["inputs", /(?<![\w.-])inputs\s*[.[]/i],
  ["github.event", /(?<![\w.-])github\s*(?:\.\s*event\b|\[\s*['"]event['"]\s*\])/i],
  ["vars", /(?<![\w.-])vars\s*[.[]/i],
  ["secrets", /(?<![\w.-])secrets\s*[.[]/i]
]);
const INPUT_CONTEXTS = new Set(["inputs", "github.event"]);

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Contexts read by the `${{ }}` expressions of a text, in CONTEXTS order; "other" when none matches. */
export function expressionContexts(text) {
  const found = new Set();
  let any = false;
  for (const match of String(text).matchAll(EXPRESSION)) {
    any = true;
    let named = false;
    for (const [name, pattern] of CONTEXTS) {
      if (pattern.test(match[1])) {
        found.add(name);
        named = true;
      }
    }
    if (!named) found.add("other");
  }
  return any ? [...CONTEXTS.map(([name]) => name), "other"].filter((name) => found.has(name)) : [];
}

const hasExpression = (value) => typeof value === "string" && value.includes("${{");
const exactVars = (value, name) => typeof value === "string" && new RegExp(`^\\$\\{\\{\\s*vars\\.${name}\\s*\\}\\}$`).test(value.trim());
const stepLabel = (step) => step.name ?? `#${step.index + 1}`;
const actionOf = (step) => (step.uses ?? "").split("@")[0];
const hasCondition = (step) => Object.hasOwn(step.raw, "if") || Object.hasOwn(step.raw, "continue-on-error");
const textOf = (value) => JSON.stringify(value ?? null);

function environmentName(definition) {
  const environment = definition?.environment;
  if (typeof environment === "string") return environment;
  if (isMapping(environment) && typeof environment.name === "string") return environment.name;
  return undefined;
}

function triggers(doc) {
  const on = doc.on;
  if (typeof on === "string") return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((name) => [name, null]));
  return isMapping(on) ? on : {};
}

/** Scripts and companion text checks carried over from the substring gate. */
export const COMPANION_REQUIREMENTS = Object.freeze({
  "runtime/cosyvoice/Dockerfile": { message: "CosyVoice release image must retain controlled source and non-root execution", texts: ["COPY --chown=cosyvoice:cosyvoice vendor/CosyVoice /opt/CosyVoice/CosyVoice", "MINIFORGE_SHA256", "sha256sum -c", "USER cosyvoice", "org.opencontainers.image.revision"] },
  "runtime/cosyvoice/Dockerfile.dockerignore": { message: "CosyVoice build context must exclude unsafe local content", texts: ["vendor/*", "!vendor/CosyVoice", "vendor/CosyVoice/.git", "models", "weights", "secrets"] },
  "scripts/assemble-release-evidence.mjs": { message: "Release evidence assembly must read the Buildx attestations from the registry", texts: ["assembleReleaseEvidence(", "releaseImagesFromResults("] },
  "scripts/lib/release-evidence.mjs": { message: "Release evidence assembly must bind all Buildx attestations", texts: ["oci-buildx-sbom-index", "oci-buildx-provenance-index", "release image results must contain exactly ten files", "attestation-manifest"] },
  "scripts/write-release-image-result.mjs": { message: "Release image result must bind pushed digest and revision", texts: ["schemaVersion: 2", "--digest", "--revision"] }
});

/**
 * @param {{ workflow: { doc: object, rawText: string }, allowlistText: string, companionFiles?: Record<string, string> }} input
 * @returns {{ rule: string, jobId?: string, step?: string, detail: string }[]}
 */
export function checkReleaseWorkflow({ workflow, allowlistText, companionFiles = {} }) {
  const violations = [];
  const add = (rule, detail, step, jobId = step?.jobId) => violations.push({ rule, ...(jobId ? { jobId } : {}), ...(step ? { step: stepLabel(step) } : {}), detail });
  const doc = workflow.doc;
  const jobList = jobs(workflow);
  const jobById = new Map(jobList.map((job) => [job.id, job]));
  const stepsByJob = new Map(jobList.map((job) => [job.id, steps(job)]));
  const allSteps = [...stepsByJob.values()].flat();

  // dispatch-inputs: release values never come from a person filling in a form.
  const on = triggers(doc);
  const dispatch = on.workflow_dispatch;
  if (isMapping(dispatch) && Object.hasOwn(dispatch, "inputs")) {
    const names = isMapping(dispatch.inputs) ? Object.keys(dispatch.inputs) : [];
    if (names.length === 0) add("dispatch-inputs", "on.workflow_dispatch declares inputs; release values come from the release-production environment");
    for (const name of names) add("dispatch-inputs", `on.workflow_dispatch declares input "${name}"; release values come from the release-production environment or the repository`);
  }

  // run-expression, env-quote, run-shell-syntax
  const workflowEnv = isMapping(doc.env) ? doc.env : {};
  for (const job of jobList) {
    const jobEnv = isMapping(job.definition?.env) ? job.definition.env : {};
    for (const step of stepsByJob.get(job.id)) {
      if (step.run === undefined) continue;
      const contexts = expressionContexts(step.run);
      if (contexts.length > 0) {
        const input = contexts.some((name) => INPUT_CONTEXTS.has(name)) ? " (workflow input or event payload)" : "";
        add("run-expression", `run: contains a \${{ }} expression reading ${contexts.join(", ")}${input}; map the value through env: and read it as "$NAME"`, step);
      }
      const mapped = new Set(Object.entries({ ...workflowEnv, ...jobEnv, ...(step.env ?? {}) }).filter(([, value]) => hasExpression(value)).map(([name]) => name));
      const scan = scanShellQuotes(step.run);
      const unquoted = [...new Set(scan.refs.filter((ref) => mapped.has(ref.name) && !ref.quoted).map((ref) => ref.name))];
      if (unquoted.length > 0) add("env-quote", `run: reads ${unquoted.map((name) => `$${name}`).join(", ")} outside double quotes; write "$NAME"`, step);
      const kinds = [...new Set(scan.unsupported.map(({ kind }) => kind))];
      if (kinds.length > 0) add("run-shell-syntax", `run: uses ${kinds.join(" and ")}, which the quote scanner does not model; use $( ) and files instead`, step);
    }
  }

  // input-env-scope: workflow- and job-level env must not carry inputs or the event payload into every step.
  const scopeContexts = (env) => Object.entries(isMapping(env) ? env : {}).filter(([, value]) => expressionContexts(value).some((name) => INPUT_CONTEXTS.has(name))).map(([name]) => name);
  for (const name of scopeContexts(doc.env)) add("input-env-scope", `workflow env ${name} reads inputs or github.event`);
  for (const job of jobList) for (const name of scopeContexts(job.definition?.env)) add("input-env-scope", `job env ${name} reads inputs or github.event`, undefined, job.id);

  // registry-source: the registry host comes only from vars.RELEASE_REGISTRY.
  for (const step of allSteps) {
    const action = actionOf(step);
    if (action === "docker/login-action") {
      if (!exactVars(step.with?.registry, "RELEASE_REGISTRY")) add("registry-source", "docker/login-action with.registry must be exactly ${{ vars.RELEASE_REGISTRY }}", step);
    } else if (action === "docker/build-push-action") {
      const tags = String(step.with?.tags ?? "").split(/[\n,]/).map((tag) => tag.trim()).filter(Boolean);
      if (tags.length === 0 || tags.some((tag) => !/^\$\{\{\s*vars\.RELEASE_REGISTRY\s*\}\}\//.test(tag))) add("registry-source", "every docker/build-push-action tag must start with ${{ vars.RELEASE_REGISTRY }}/", step);
      if (expressionContexts(textOf(step.with)).some((name) => INPUT_CONTEXTS.has(name))) add("registry-source", "docker/build-push-action with: must not read inputs or github.event", step);
    }
  }

  // registry-validation: in every job, the allowlist check runs before the first other use of vars.RELEASE_REGISTRY.
  for (const job of jobList) {
    const list = stepsByJob.get(job.id);
    const usesRegistry = (step) => /vars\s*\.\s*RELEASE_REGISTRY\b/.test(textOf({ with: step.with, env: step.env }));
    const first = list.find((step) => usesRegistry(step) && step.raw.id !== "validate-registry");
    if (!first) continue;
    const validation = list.find((step) => step.raw.id === "validate-registry");
    if (!validation || validation.index > first.index) {
      add("registry-validation", `a step with id validate-registry must run before the first use of vars.RELEASE_REGISTRY (${stepLabel(first)})`, undefined, job.id);
      continue;
    }
    if (!/\bnode\s+scripts\/release-environment\.mjs\s+registry\s+--allowlist\s+\.github\/release-registry-allowlist\.json\b/.test(validation.run ?? "")) add("registry-validation", `validate-registry must run node scripts/release-environment.mjs registry --allowlist ${ALLOWLIST_PATH}`, validation);
    if (!exactVars(validation.env?.RELEASE_REGISTRY, "RELEASE_REGISTRY") || !exactVars(validation.env?.RELEASE_IMAGE_NAMESPACE, "RELEASE_IMAGE_NAMESPACE")) add("registry-validation", "validate-registry env must map RELEASE_REGISTRY and RELEASE_IMAGE_NAMESPACE to the same vars", validation);
    if (hasCondition(validation)) add("registry-validation", "validate-registry must not have if: or continue-on-error", validation);
    for (const login of list.filter((step) => actionOf(step) === "docker/login-action")) if (hasCondition(login)) add("registry-validation", "docker/login-action must not have if: or continue-on-error", login);
  }

  // release-vars-source: signing values from vars, validated before evidence assembly and signing;
  // build arguments from the reviewed Miniforge pin.
  for (const job of jobList) {
    const list = stepsByJob.get(job.id);
    const manifest = list.find((step) => /create-deployment-release-manifest\.mjs/.test(step.run ?? ""));
    if (manifest) {
      for (const name of SIGNING_VARIABLES) if (!exactVars(manifest.env?.[name], name)) add("release-vars-source", `the manifest step env must map ${name} to \${{ vars.${name} }}`, manifest);
      const signing = list.find((step) => step.raw.id === "validate-signing");
      const assemble = list.find((step) => /assemble-release-evidence\.mjs/.test(step.run ?? ""));
      const deadline = Math.min(manifest.index, assemble?.index ?? Infinity);
      if (!signing || signing.index > deadline) add("release-vars-source", "a step with id validate-signing must run before evidence assembly and the signed manifest", undefined, job.id);
      else {
        if (!/\bnode\s+scripts\/release-environment\.mjs\s+signing\b/.test(signing.run ?? "")) add("release-vars-source", "validate-signing must run node scripts/release-environment.mjs signing", signing);
        for (const name of SIGNING_VARIABLES) if (!exactVars(signing.env?.[name], name)) add("release-vars-source", `validate-signing env must map ${name} to \${{ vars.${name} }}`, signing);
        if (hasCondition(signing)) add("release-vars-source", "validate-signing must not have if: or continue-on-error", signing);
      }
    }
    const build = list.find((step) => actionOf(step) === "docker/build-push-action");
    if (build) {
      const args = list.find((step) => step.raw.id === "build-args");
      if (!args || args.index > build.index) add("release-vars-source", "a step with id build-args must run before docker/build-push-action", undefined, job.id);
      else {
        if (!/\bnode\s+scripts\/release-environment\.mjs\s+build-args\s+--matrix-key\s+"\$MATRIX_KEY"\s+--miniforge\s+runtime\/cosyvoice\/miniforge\.json\b/.test(args.run ?? "")) add("release-vars-source", `build-args must run node scripts/release-environment.mjs build-args --matrix-key "$MATRIX_KEY" --miniforge ${MINIFORGE_PIN}`, args);
        if (Object.keys(args.env ?? {}).some((name) => name.startsWith("MINIFORGE_"))) add("release-vars-source", `build-args must not take Miniforge values from env:; they come from ${MINIFORGE_PIN}`, args);
        if (hasCondition(args)) add("release-vars-source", "build-args must not have if: or continue-on-error", args);
      }
      if (!/^\$\{\{\s*steps\.build-args\.outputs\.value\s*\}\}$/.test(String(build.with?.["build-args"] ?? "").trim())) add("release-vars-source", "docker/build-push-action build-args must be ${{ steps.build-args.outputs.value }}", build);
    }
  }

  // credentials-environment: registry secrets and environment variables are only available in release-production.
  for (const job of jobList) {
    const text = textOf(job.definition);
    const reads = /secrets\s*\.\s*REGISTRY_(?:USERNAME|PASSWORD)\b/.test(text) || /vars\s*\./.test(text);
    if (!reads && job.id !== BUILD_JOB && job.id !== SIGN_JOB) continue;
    if (environmentName(job.definition) !== RELEASE_ENVIRONMENT) add("credentials-environment", `job must declare environment: ${RELEASE_ENVIRONMENT}`, undefined, job.id);
  }

  // allowlist-format
  for (const problem of parseAllowlist(allowlistText, ALLOWLIST_PATH).problems) add("allowlist-format", problem);

  // pinned-actions: format only; ci:workflow:check (W5) compares SHAs with .github/action-pins.json.
  const refs = actionRefs(workflow);
  for (const name of REQUIRED_ACTIONS) if (!refs.some((ref) => ref.action === name)) add("pinned-actions", `MISSING_ACTION ${name}`);
  for (const ref of refs.filter((item) => !item.uses.startsWith("./"))) {
    if (ref.ref !== null && FULL_COMMIT_SHA.test(ref.ref)) continue;
    const step = ref.index === null ? undefined : stepsByJob.get(ref.jobId)[ref.index];
    add("pinned-actions", `ACTION_REF action=${ref.action} ref=${ref.ref ?? "(none)"}`, step, ref.jobId);
  }

  // release-structure
  const structure = (detail, jobId) => add("release-structure", detail, undefined, jobId);
  if (!Object.hasOwn(on, "workflow_dispatch")) structure("on: must contain workflow_dispatch");
  for (const id of [BUILD_JOB, SIGN_JOB]) {
    const job = jobById.get(id);
    if (!job) structure(`job ${id} is missing`);
    else if (String(job.definition?.if ?? "").trim() !== "github.ref_protected") structure("job must have if: github.ref_protected", id);
  }
  const buildJob = jobById.get(BUILD_JOB);
  if (buildJob) {
    const include = buildJob.definition?.strategy?.matrix?.include;
    const keys = Array.isArray(include) ? include.map((item) => item?.key) : [];
    const missing = IMAGE_KEYS.filter((key) => !keys.includes(key));
    if (missing.length > 0 || keys.length !== IMAGE_KEYS.length) structure(`strategy.matrix.include must list exactly the ten image keys (missing: ${missing.join(", ") || "none"})`, BUILD_JOB);
    const build = stepsByJob.get(BUILD_JOB).find((step) => actionOf(step) === "docker/build-push-action");
    if (build) {
      for (const [key, expected] of [["platforms", "linux/amd64"], ["push", "true"], ["sbom", "true"], ["provenance", "mode=max"]]) {
        if (String(build.with?.[key] ?? "").trim() !== expected) structure(`docker/build-push-action ${key} must be ${expected}`, BUILD_JOB);
      }
      if (!String(build.with?.labels ?? "").includes("org.opencontainers.image.revision=${{ github.sha }}")) structure("docker/build-push-action labels must include org.opencontainers.image.revision=${{ github.sha }}", BUILD_JOB);
    }
  }
  const signJob = jobById.get(SIGN_JOB);
  if (signJob) {
    const runsOn = [].concat(signJob.definition?.["runs-on"] ?? []);
    if (!runsOn.includes("self-hosted") || !runsOn.includes("shuzhiren-release")) structure("job must run on the self-hosted shuzhiren-release runner", SIGN_JOB);
    if (![].concat(signJob.definition?.needs ?? []).includes(BUILD_JOB)) structure(`job must need ${BUILD_JOB}`, SIGN_JOB);
    if (!stepsByJob.get(SIGN_JOB).some((step) => /create-deployment-release-manifest\.mjs/.test(step.run ?? ""))) structure("job must run scripts/create-deployment-release-manifest.mjs", SIGN_JOB);
  }
  for (const step of allSteps.filter((item) => actionOf(item) === "actions/checkout")) {
    if (String(step.with?.["persist-credentials"] ?? "").trim() !== "false") add("release-structure", "actions/checkout must set persist-credentials: false", step);
  }

  // companion-files
  for (const [file, { message, texts }] of Object.entries(COMPANION_REQUIREMENTS)) {
    const content = companionFiles[file];
    if (content === undefined) {
      add("companion-files", `${file} was not provided`);
      continue;
    }
    for (const text of texts) if (!content.includes(text)) add("companion-files", `${message}: ${file} must contain ${text}`);
  }

  return violations;
}

/** One CLI line per violation: `ERROR [<rule>] job=<jobId> step=<name|#n>: <detail>`. */
export function formatViolation({ rule, jobId, step, detail }) {
  return `ERROR [${rule}]${jobId ? ` job=${jobId}` : ""}${step ? ` step=${step}` : ""}: ${detail}`;
}
