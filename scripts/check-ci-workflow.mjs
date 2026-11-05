// ci.yml structure gate: rules W1-W12 (Requirement 1.3-1.7, 1.9-1.11, 1.13,
// 2.4, 2.5, 3.1, 3.2, 3.4, 3.5).
//
//   W1  Top-level permissions are exactly { contents: read }; no job declares permissions.
//   W2  Every job's runs-on is the string ubuntu-24.04.
//   W3  The six group jobs exist; no job declares needs; no job or step declares
//       if:; no job or step sets continue-on-error to anything but false.
//   W4  defaults.run.shell is bash and no job or step switches to another shell;
//       no run: text matches `|| true|:|exit 0|echo`, `; true` at a line end, or `set +e`.
//   W5  Every uses: not starting with ./ in ci.yml and release.yml is
//       <owner>/<repo>[/<path>]@<40 lowercase hex> on its own line with a trailing
//       `# <tag>` comment, and SHA and tag equal the .github/action-pins.json entry.
//   W6  Every verification step covers a Local_Verification check (covers() of
//       scripts/verify-local-checks.mjs) or is registered in CI_ONLY_STEPS, and
//       every CI_ONLY_STEPS entry has a verification step in the job it names.
//   W7  postgres-integration declares services.postgres and a job-level
//       DATABASE_URL, runs the six Requirement 1.3 steps with db:migrate first,
//       and the control-plane:integration step sets RUN_CONTROL_PLANE_INTEGRATION_TESTS: "true".
//   W8  python-gateway runs pip install -r runtime/gateway/requirements.txt before
//       its first Python test and runs every scripts/test-runtime-gateway-*.py
//       directly or through an npm script.
//   W9  py_compile (with `*` expanded) compiles every .py file directly under runtime/gateway/.
//   W10 docker-build builds every apps/*/Dockerfile, the console migrator target,
//       runtime/gateway, runtime/livetalking and runtime/cosyvoice; the CosyVoice
//       build takes MINIFORGE_URL and MINIFORGE_SHA256 only from shell variables
//       read with jq from runtime/cosyvoice/miniforge.json, its step has no `${{`,
//       no workflow, job or step env declares MINIFORGE_*, and the JSON has an
//       https:// url and a 64-hex lowercase sha256.
//   W11 compose-render renders Control_Plane_Compose and Runtime_Compose. Each
//       docker compose step is simulated offline (scripts/lib/compose-interpolation.mjs):
//       every --env-file is an existing config/*.example.env; with workflow, job
//       and step env over later --env-file over earlier, no `:?`/`?` variable of
//       the compose file is left without a value, and every service env_file
//       resolves (relative to the compose file directory) to an existing file
//       under config/ that the env parser accepts. The runtime render enables the
//       four profiles and passes the four env files of Requirement 1.11.
//   W12 static-gates runs membership:scopes:check, governance:tenant-scope:check
//       and ci:coverage:check.
//
// Steps follow scripts/lib/workflow-model.mjs: `uses:` steps, a bare `npm ci`
// and steps named `prep:...` are preparation steps; all others are verification
// steps, and their commands are the normalized lines of `run:`.
//
// Usage: node scripts/check-ci-workflow.mjs [--workflow <path>] [--root <dir>]
//   --root      repository root, default this repository. release.yml,
//               .github/action-pins.json, package.json, the check lists
//               scripts/verify-local-checks.mjs (LOCAL_CHECKS) and
//               scripts/ci-required-steps.mjs (CI_ONLY_STEPS), and every file a
//               rule inspects are read from it (tests point it at a fixture).
//   --workflow  defaults to <root>/.github/workflows/ci.yml.
// Exit codes: 0 pass; 1 one `RULE <Wn> <job>/<step> <message>` line per
// violation, all listed (`<step>` is the 0-based index in the job's steps, `-`
// for a job-level finding; `-/-` is workflow-level); 2 a workflow, the pin
// registry, package.json or a check list cannot be read or parsed, or the
// arguments are invalid (`ERROR ...`).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { InvalidInterpolation, interpolate, MissingRequiredVariable, parseEnvFile, resolveComposeEnvFiles, UnsupportedEnvSyntax } from "./lib/compose-interpolation.mjs";
import { actionRefs, commands, jobs, loadWorkflow, normalizeNewlines, steps, tokenize, UnparsableCommand, WorkflowLoadError } from "./lib/workflow-model.mjs";
import { covers, expandGlob, validateLocalChecks } from "./verify-local-checks.mjs";
import { findCiOnlyStep, validateCiOnlySteps } from "./ci-required-steps.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GROUP_JOBS = Object.freeze(["static-gates", "node-unit", "python-gateway", "postgres-integration", "compose-render", "docker-build"]);
const POSTGRES_STEPS = Object.freeze(["db:migrate", "db:migrate:integrity:test", "service-principals:integration", "db:migrate:lock:test", "db:verify", "control-plane:integration"]);
const STATIC_GATE_COMMANDS = Object.freeze(["npm run membership:scopes:check", "npm run governance:tenant-scope:check", "npm run ci:coverage:check"]);
const GATEWAY_REQUIREMENTS = "runtime/gateway/requirements.txt";
const CONTROL_PLANE_COMPOSE = "infra/compose/docker-compose.control-plane.yml";
const RUNTIME_COMPOSE = "infra/compose/docker-compose.runtime.yml";
const RUNTIME_PROFILES = Object.freeze(["output-probe", "channel-adapter", "alert-notifier", "cosyvoice"]);
const RUNTIME_ENV_FILES = Object.freeze(["config/runtime.example.env", "config/runtime-gateway.example.env", "config/channel-adapter.example.env", "config/alert-notifier.example.env"]);
const ENV_FILE_ARGUMENT = /^config\/[^/]+\.example\.env$/;
const PINNED_USES = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/[^@\s]+)?@([0-9a-f]{40})$/;
const PYTHON = Object.freeze(["python3", "python"]);
const FALSE_SPELLINGS = new Set(["false", "False", "FALSE"]);
const IGNORED_EXIT_CODE = Object.freeze([/\|\|\s*(true|:|exit 0|echo)/, /;\s*true\s*$/m, /\bset\s+\+e\b/]);
const COMPOSE_VALUE_OPTIONS = new Map([["--env-file", "envFiles"], ["-f", "files"], ["--file", "files"], ["--profile", "profiles"], ["-p", null], ["--project-name", null]]);
const DOCKER_BUILD_VALUE_OPTIONS = new Set(["--file", "-f", "--target", "--build-arg", "--tag", "-t", "--platform", "--label", "--cache-from", "--cache-to", "--secret", "--ssh", "--network", "--progress", "--output", "-o", "--build-context", "--iidfile", "--metadata-file", "--attest", "--add-host", "--shm-size", "--ulimit", "--allow"]);

function fail(reason) {
  console.error(`ERROR ${reason}`);
  process.exit(2);
}

function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (name !== "--workflow" && name !== "--root") fail(`usage: unknown argument ${name}; expected [--workflow <path>] [--root <dir>]`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`usage: ${name} requires a path`);
    options[name.slice(2)] = path.resolve(value);
    i += 1;
  }
  const root = options.root ?? repoRoot;
  return { root, workflowFile: options.workflow ?? path.join(root, ".github", "workflows", "ci.yml") };
}

const { root, workflowFile } = parseArguments(process.argv.slice(2));

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const toPosix = (file) => file.split(path.sep).join("/");
const toRepoPath = (file) => file.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
const describe = (value) => (value === undefined ? "(not set)" : JSON.stringify(value));
const collapse = (command) => command.replace(/\s+/g, " ").trim();

function display(file) {
  const relative = path.relative(root, file);
  return relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? file : toPosix(relative);
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isInside(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function loadWorkflowOrExit(file) {
  try {
    return loadWorkflow(file);
  } catch (error) {
    if (!(error instanceof WorkflowLoadError)) throw error;
    return fail(`source=CI_Pipeline reason=${display(file)}: ${error.reason}`);
  }
}

function readJsonOrExit(file, source) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return fail(`source=${source} reason=${display(file)}: cannot read file (${error.code ?? error.message})`);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    return fail(`source=${source} reason=${display(file)}: JSON parse failed (${error.message})`);
  }
}

async function importListOrExit(file, name) {
  let module;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (error) {
    return fail(`source=Local_Verification reason=cannot import ${display(file)} (${error.code ?? error.message})`);
  }
  if (!Array.isArray(module[name])) fail(`source=Local_Verification reason=${display(file)} does not export a ${name} array`);
  return module[name];
}

const workflow = loadWorkflowOrExit(workflowFile);
const releaseFile = path.join(root, ".github", "workflows", "release.yml");
const release = loadWorkflowOrExit(releaseFile);
const pinsFile = path.join(root, ".github", "action-pins.json");
const pins = readJsonOrExit(pinsFile, "CI_Pipeline");
const packageJson = readJsonOrExit(path.join(root, "package.json"), "Local_Verification");
const scripts = isMapping(packageJson) && isMapping(packageJson.scripts) ? packageJson.scripts : {};
const localChecks = await importListOrExit(path.join(root, "scripts", "verify-local-checks.mjs"), "LOCAL_CHECKS");
const ciOnlySteps = await importListOrExit(path.join(root, "scripts", "ci-required-steps.mjs"), "CI_ONLY_STEPS");
const listErrors = [...validateLocalChecks(localChecks), ...validateCiOnlySteps(ciOnlySteps)];
if (listErrors.length > 0) fail(`source=Local_Verification reason=${listErrors.join("; ")}`);

function safeTokenize(line, where) {
  try {
    return tokenize(line);
  } catch (error) {
    if (!(error instanceof UnparsableCommand)) throw error;
    console.error(`WARN unparsable command ${where}: ${line}`);
    return null;
  }
}

const doc = workflow.doc;
const jobList = jobs(workflow).map((job) => {
  const definition = isMapping(job.definition) ? job.definition : {};
  const jobSteps = steps(job).map((step) => {
    const lines = commands(step);
    return { ...step, lines, tokens: lines.map((line) => safeTokenize(line, `${job.id}/${step.index}`)) };
  });
  return { id: job.id, definition, steps: jobSteps };
});
const jobById = new Map(jobList.map((job) => [job.id, job]));
const verificationSteps = (job) => job.steps.filter((step) => !step.isPreparation);
const where = (job, step) => `${job.id}/${step.index}`;
const startsWith = (tokens, prefix) => Array.isArray(tokens) && prefix.every((token, index) => tokens[index] === token);
const coverageContext = { scripts, root };

function scriptTokens(name) {
  return typeof scripts[name] === "string" ? safeTokenize(scripts[name], `package.json scripts.${name}`) : null;
}

function effectiveEnv(job, step) {
  const layer = (env) => (isMapping(env) ? env : {});
  return { ...layer(doc.env), ...layer(job.definition.env), ...layer(step.env) };
}

const violations = [];
const report = (rule, location, message) => violations.push({ rule, location, message });

function requireJob(rule, id, purpose) {
  const job = jobById.get(id);
  if (!job) report(rule, `${id}/-`, `job ${id} is missing; ${purpose}`);
  return job;
}

function checkPermissions() {
  const permissions = doc.permissions;
  if (!isMapping(permissions) || Object.keys(permissions).length !== 1 || permissions.contents !== "read") {
    report("W1", "-/-", `top-level permissions must be exactly { contents: read }, found ${describe(permissions)}`);
  }
  for (const job of jobList) {
    if (Object.hasOwn(job.definition, "permissions")) report("W1", `${job.id}/-`, `job declares permissions ${describe(job.definition.permissions)}; only the top-level { contents: read } is allowed`);
  }
}

function checkRunners() {
  for (const job of jobList) {
    const runsOn = job.definition["runs-on"];
    if (runsOn !== "ubuntu-24.04") report("W2", `${job.id}/-`, `runs-on must be the string ubuntu-24.04, found ${describe(runsOn)}`);
  }
}

function checkIsolation() {
  for (const id of GROUP_JOBS) {
    if (!jobById.has(id)) report("W3", `${id}/-`, `verification group job ${id} is missing`);
  }
  const continuesOnError = (value) => value !== undefined && !(typeof value === "string" && FALSE_SPELLINGS.has(value));
  for (const job of jobList) {
    if (Object.hasOwn(job.definition, "needs")) report("W3", `${job.id}/-`, `job declares needs ${describe(job.definition.needs)}; verification groups must not depend on each other`);
    if (Object.hasOwn(job.definition, "if")) report("W3", `${job.id}/-`, `job declares if: ${describe(job.definition.if)}`);
    if (continuesOnError(job.definition["continue-on-error"])) report("W3", `${job.id}/-`, `job sets continue-on-error: ${describe(job.definition["continue-on-error"])}`);
    for (const step of job.steps) {
      if (Object.hasOwn(step.raw, "if")) report("W3", where(job, step), `step declares if: ${describe(step.raw.if)}`);
      if (continuesOnError(step.raw["continue-on-error"])) report("W3", where(job, step), `step sets continue-on-error: ${describe(step.raw["continue-on-error"])}`);
    }
  }
}

function checkExitCodes() {
  const shell = isMapping(doc.defaults) && isMapping(doc.defaults.run) ? doc.defaults.run.shell : undefined;
  if (shell !== "bash") report("W4", "-/-", `defaults.run.shell must be bash, found ${describe(shell)}`);
  for (const job of jobList) {
    const jobRun = isMapping(job.definition.defaults) && isMapping(job.definition.defaults.run) ? job.definition.defaults.run : {};
    if (Object.hasOwn(jobRun, "shell") && jobRun.shell !== "bash") report("W4", `${job.id}/-`, `job defaults.run.shell must be bash, found ${describe(jobRun.shell)}`);
    for (const step of job.steps) {
      if (Object.hasOwn(step.raw, "shell") && step.raw.shell !== "bash") report("W4", where(job, step), `step shell must be bash, found ${describe(step.raw.shell)}`);
      if (step.run === undefined) continue;
      const text = normalizeNewlines(step.run);
      for (const pattern of IGNORED_EXIT_CODE) {
        const match = pattern.exec(text);
        if (match) report("W4", where(job, step), `run text contains ${JSON.stringify(collapse(match[0]))}, which ignores a failing exit code`);
      }
    }
  }
}

function checkActionPins() {
  const entries = isMapping(pins) && isMapping(pins.actions) ? pins.actions : undefined;
  const registry = display(pinsFile);
  if (!isMapping(pins) || pins.schemaVersion !== "1") report("W5", "-/-", `${registry}: schemaVersion must be "1", found ${describe(isMapping(pins) ? pins.schemaVersion : pins)}`);
  if (!entries || Object.keys(entries).length === 0) report("W5", "-/-", `${registry}: actions must be a non-empty mapping of <owner>/<repo> to pin records`);
  for (const [name, pin] of Object.entries(entries ?? {})) {
    const problems = [];
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) problems.push("key is not <owner>/<repo>");
    if (!isMapping(pin)) problems.push("record is not an object");
    else {
      if (typeof pin.tag !== "string" || !/^\S+$/.test(pin.tag)) problems.push(`tag ${describe(pin.tag)} is not a tag name`);
      if (typeof pin.commit !== "string" || !/^[0-9a-f]{40}$/.test(pin.commit)) problems.push(`commit ${describe(pin.commit)} is not 40 lowercase hex`);
      if (typeof pin.runsUsing !== "string" || !/^(node\d+|docker|composite)$/.test(pin.runsUsing)) problems.push(`runsUsing ${describe(pin.runsUsing)} is not nodeNN, docker or composite`);
      if (typeof pin.resolvedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(pin.resolvedAt)) problems.push(`resolvedAt ${describe(pin.resolvedAt)} is not YYYY-MM-DD`);
    }
    for (const problem of problems) report("W5", "-/-", `${registry}: actions["${name}"] ${problem}`);
  }
  let count = 0;
  for (const [file, parsed] of [[workflowFile, workflow], [releaseFile, release]]) {
    for (const ref of actionRefs(parsed)) {
      if (ref.uses.startsWith("./")) continue;
      count += 1;
      const location = `${ref.jobId}/${ref.index ?? "-"}`;
      const source = display(file);
      const match = PINNED_USES.exec(ref.uses);
      if (!match) {
        report("W5", location, `${source}: uses ${ref.uses} is not <owner>/<repo>[/<path>]@<40 lowercase hex commit SHA>`);
        continue;
      }
      const action = `${match[1]}/${match[2]}`;
      const commit = match[4];
      if (ref.tagComment === null) report("W5", location, `${source}: uses ${ref.uses} has no "# <tag>" comment at the end of its own uses: line`);
      const pin = entries && isMapping(entries[action]) ? entries[action] : undefined;
      if (!pin) {
        report("W5", location, `${source}: ${action} has no record in ${registry}`);
        continue;
      }
      if (pin.commit !== commit) report("W5", location, `${source}: ${action}@${commit} does not match the commit ${pin.commit} pinned in ${registry}`);
      if (ref.tagComment !== null && ref.tagComment !== pin.tag) report("W5", location, `${source}: ${action} comment "# ${ref.tagComment}" does not match the tag ${pin.tag} pinned in ${registry}`);
    }
  }
  return count;
}

function checkStepInventory() {
  for (const job of jobList) {
    for (const step of verificationSteps(job)) {
      if (step.lines.length === 0) {
        report("W6", where(job, step), "verification step runs no command");
        continue;
      }
      const covered = step.tokens.some((tokens) => tokens !== null && localChecks.some((check) => covers(tokens, check, coverageContext)));
      if (!covered && !findCiOnlyStep(job.id, step.lines, ciOnlySteps)) {
        report("W6", where(job, step), `${JSON.stringify(step.lines.join(" ; "))} covers no Local_Verification check and is not registered in CI_ONLY_STEPS`);
      }
    }
  }
  for (const entry of ciOnlySteps) {
    const job = jobById.get(entry.job);
    const command = collapse(entry.command);
    const present = job !== undefined && verificationSteps(job).some((step) => step.lines.includes(command));
    if (!present) report("W6", `${entry.job}/-`, `CI_ONLY_STEPS entry ${JSON.stringify(command)} has no verification step in job ${entry.job}`);
  }
}

function checkPostgres() {
  const job = requireJob("W7", "postgres-integration", "the PostgreSQL steps of Requirement 1.3 do not run");
  if (!job) return;
  if (!isMapping(job.definition.services) || !isMapping(job.definition.services.postgres)) report("W7", `${job.id}/-`, "job must declare services.postgres");
  const env = isMapping(job.definition.env) ? job.definition.env : {};
  if (typeof env.DATABASE_URL !== "string" || env.DATABASE_URL.trim() === "") report("W7", `${job.id}/-`, `job must declare a job-level env.DATABASE_URL, found ${describe(env.DATABASE_URL)}`);
  const position = new Map();
  for (const step of verificationSteps(job)) {
    for (const script of POSTGRES_STEPS) {
      if (!position.has(script) && step.tokens.some((tokens) => startsWith(tokens, ["npm", "run", script]))) position.set(script, step);
    }
  }
  for (const script of POSTGRES_STEPS) {
    if (!position.has(script)) report("W7", `${job.id}/-`, `no verification step runs npm run ${script}`);
  }
  const migrate = position.get("db:migrate");
  for (const script of POSTGRES_STEPS.slice(1)) {
    const step = position.get(script);
    if (migrate && step && step.index < migrate.index) report("W7", where(job, step), `npm run ${script} runs before npm run db:migrate (step ${migrate.index})`);
  }
  const integration = position.get("control-plane:integration");
  if (integration) {
    const value = integration.env ? integration.env.RUN_CONTROL_PLANE_INTEGRATION_TESTS : undefined;
    if (value !== "true") report("W7", where(job, integration), `step env RUN_CONTROL_PLANE_INTEGRATION_TESTS must be "true", found ${describe(value)}`);
  }
}

function installsGatewayRequirements(tokens) {
  if (!Array.isArray(tokens)) return false;
  let rest;
  if ((tokens[0] === "pip" || tokens[0] === "pip3") && tokens[1] === "install") rest = tokens.slice(2);
  else if (PYTHON.includes(tokens[0]) && tokens[1] === "-m" && tokens[2] === "pip" && tokens[3] === "install") rest = tokens.slice(4);
  else return false;
  return rest.some((token, index) => {
    if (token === "-r" || token === "--requirement") return toRepoPath(rest[index + 1] ?? "") === GATEWAY_REQUIREMENTS;
    if (token.startsWith("--requirement=")) return toRepoPath(token.slice("--requirement=".length)) === GATEWAY_REQUIREMENTS;
    return token.startsWith("-r") && token.length > 2 && toRepoPath(token.slice(2)) === GATEWAY_REQUIREMENTS;
  });
}

function runsPythonFile(tokens, viaNpm = true) {
  if (!Array.isArray(tokens) || tokens.length < 2) return false;
  if (PYTHON.includes(tokens[0]) && tokens[1].endsWith(".py")) return true;
  if (tokens[0] === "node" && tokens[1] === "scripts/run-python-test.mjs") return true;
  if (viaNpm && tokens[0] === "npm" && tokens[1] === "run" && tokens.length === 3) return runsPythonFile(scriptTokens(tokens[2]), false);
  return false;
}

function checkGatewayTests() {
  const job = requireJob("W8", "python-gateway", "the Gateway Python tests do not run");
  if (!job) return;
  const jobSteps = verificationSteps(job);
  const install = jobSteps.find((step) => step.tokens.some(installsGatewayRequirements));
  if (!install) report("W8", `${job.id}/-`, `no verification step runs pip install -r ${GATEWAY_REQUIREMENTS}`);
  const firstTest = jobSteps.find((step) => step.tokens.some((tokens) => runsPythonFile(tokens)));
  if (install && firstTest && firstTest.index < install.index) report("W8", where(job, firstTest), `Python test runs before pip install -r ${GATEWAY_REQUIREMENTS} (step ${install.index})`);
  for (const file of expandGlob("scripts/test-runtime-gateway-*.py", root)) {
    const check = { kind: "python", file };
    if (!jobSteps.some((step) => step.tokens.some((tokens) => tokens !== null && covers(tokens, check, coverageContext)))) {
      report("W8", `${job.id}/-`, `no step runs ${file} directly or through an npm script`);
    }
  }
}

const isPyCompile = (tokens) => Array.isArray(tokens) && PYTHON.includes(tokens[0]) && tokens[1] === "-m" && tokens[2] === "py_compile";

function checkPyCompile() {
  const job = requireJob("W9", "python-gateway", "runtime/gateway/*.py is not compiled");
  if (!job) return;
  const compileSteps = verificationSteps(job).filter((step) => step.tokens.some(isPyCompile));
  if (compileSteps.length === 0) {
    report("W9", `${job.id}/-`, "no verification step runs python3 -m py_compile");
    return;
  }
  const compiled = new Set(compileSteps.flatMap((step) => step.tokens.filter(isPyCompile).flatMap((tokens) => tokens.slice(3).flatMap((argument) => expandGlob(argument, root)))));
  let entries;
  try {
    entries = readdirSync(path.join(root, "runtime", "gateway"), { withFileTypes: true });
  } catch (error) {
    report("W9", "-/-", `runtime/gateway/ cannot be listed (${error.code ?? error.message})`);
    return;
  }
  const missing = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".py")).map((entry) => `runtime/gateway/${entry.name}`).filter((file) => !compiled.has(file)).sort();
  if (missing.length > 0) report("W9", where(job, compileSteps[0]), `py_compile does not compile ${missing.join(", ")}`);
}

function parseDockerBuild(tokens) {
  let start;
  if (startsWith(tokens, ["docker", "build"])) start = 2;
  else if (startsWith(tokens, ["docker", "buildx", "build"])) start = 3;
  else return null;
  const build = { file: undefined, target: undefined, buildArgs: [] };
  const positionals = [];
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (["&&", "||", ";", "|"].includes(token)) break;
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = token.startsWith("--") && equals > 0 ? token.slice(0, equals) : token;
    if (!DOCKER_BUILD_VALUE_OPTIONS.has(name)) continue;
    const value = name === token ? tokens[++i] : token.slice(equals + 1);
    if (name === "--file" || name === "-f") build.file = value;
    else if (name === "--target") build.target = value;
    else if (name === "--build-arg" && value !== undefined) build.buildArgs.push(value);
  }
  const context = positionals.at(-1);
  if (build.file === undefined && context !== undefined) build.file = path.posix.join(toRepoPath(context), "Dockerfile");
  if (build.file !== undefined) build.file = toRepoPath(build.file);
  return build;
}

function appDockerfiles() {
  let entries;
  try {
    entries = readdirSync(path.join(root, "apps"), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory() && isFile(path.join(root, "apps", entry.name, "Dockerfile"))).map((entry) => `apps/${entry.name}/Dockerfile`).sort();
}

function readsMiniforgeJson(lines, variable, field) {
  const assignment = new RegExp(`^${variable}=("?)\\$\\(jq(?: -[A-Za-z]+)* (['"]?)\\.${field}\\2 runtime/cosyvoice/miniforge\\.json\\)\\1$`);
  return lines.some((line) => assignment.test(line));
}

function checkDockerBuilds() {
  const layers = [["-/-", doc.env], ...jobList.flatMap((job) => [[`${job.id}/-`, job.definition.env], ...job.steps.map((step) => [where(job, step), step.env])])];
  for (const [location, env] of layers) {
    if (!isMapping(env)) continue;
    for (const key of Object.keys(env)) {
      if (key.startsWith("MINIFORGE_")) report("W10", location, `env declares ${key}; MINIFORGE_* values come only from runtime/cosyvoice/miniforge.json`);
    }
  }
  let pin;
  try {
    pin = JSON.parse(readFileSync(path.join(root, "runtime", "cosyvoice", "miniforge.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    report("W10", "-/-", `runtime/cosyvoice/miniforge.json cannot be read or parsed (${error.code ?? error.message})`);
  }
  if (pin !== undefined) {
    const url = isMapping(pin) ? pin.url : undefined;
    const sha256 = isMapping(pin) ? pin.sha256 : undefined;
    if (typeof url !== "string" || !url.startsWith("https://")) report("W10", "-/-", `runtime/cosyvoice/miniforge.json url must start with https://, found ${describe(url)}`);
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) report("W10", "-/-", `runtime/cosyvoice/miniforge.json sha256 must be 64 lowercase hex, found ${describe(sha256)}`);
  }
  const job = requireJob("W10", "docker-build", "no image is built");
  if (!job) return;
  const builds = verificationSteps(job).flatMap((step) => step.tokens.map(parseDockerBuild).filter(Boolean).map((build) => ({ ...build, step })));
  const required = [
    ...appDockerfiles().map((file) => ({ file, target: null, label: `${file} (default target)` })),
    { file: "apps/console/Dockerfile", target: "migrator", label: "apps/console/Dockerfile --target migrator" },
    ...["runtime/gateway", "runtime/livetalking", "runtime/cosyvoice"].map((directory) => ({ file: `${directory}/Dockerfile`, target: undefined, label: `${directory}/Dockerfile` }))
  ];
  for (const { file, target, label } of required) {
    const found = builds.some((build) => build.file === file && (target === undefined || (target === null ? build.target === undefined : build.target === target)));
    if (!found) report("W10", `${job.id}/-`, `no docker build for ${label}`);
  }
  for (const build of builds.filter((candidate) => candidate.file === "runtime/cosyvoice/Dockerfile")) {
    const location = where(job, build.step);
    if ((build.step.run ?? "").includes("${{")) report("W10", location, "CosyVoice build step contains a ${{ }} expression");
    for (const [name, field] of [["MINIFORGE_URL", "url"], ["MINIFORGE_SHA256", "sha256"]]) {
      const argument = build.buildArgs.find((value) => value.startsWith(`${name}=`));
      if (argument === undefined) {
        report("W10", location, `CosyVoice build has no --build-arg ${name}`);
        continue;
      }
      const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(argument.slice(name.length + 1))?.[1];
      if (!variable || !readsMiniforgeJson(build.step.lines, variable, field)) {
        report("W10", location, `--build-arg ${argument} must use a shell variable assigned in the same step from jq '.${field}' runtime/cosyvoice/miniforge.json`);
      }
    }
  }
}

function parseComposeCommand(tokens) {
  const parsed = { envFiles: [], files: [], profiles: [], unsupported: [], subcommand: undefined };
  for (let i = 2; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("-")) {
      parsed.subcommand = token;
      break;
    }
    const equals = token.indexOf("=");
    const name = token.startsWith("--") && equals > 0 ? token.slice(0, equals) : token;
    if (!COMPOSE_VALUE_OPTIONS.has(name)) {
      parsed.unsupported.push(token);
      continue;
    }
    const value = name === token ? tokens[++i] : token.slice(equals + 1);
    if (value === undefined) {
      parsed.unsupported.push(token);
      continue;
    }
    const key = COMPOSE_VALUE_OPTIONS.get(name);
    if (key) parsed[key].push(value);
  }
  return parsed;
}

function visitStrings(node, keys, visit) {
  if (typeof node === "string") visit(node, keys);
  else if (Array.isArray(node)) node.forEach((item, index) => visitStrings(item, [...keys, String(index)], visit));
  else if (isMapping(node)) for (const [key, value] of Object.entries(node)) visitStrings(value, [...keys, key], visit);
}

/** Simulates one `docker compose ... config` command; returns the repository-relative compose file. */
function simulateCompose(job, step, tokens) {
  const location = where(job, step);
  const command = parseComposeCommand(tokens);
  const composeFile = command.files.length === 1 ? toRepoPath(command.files[0]) : undefined;
  const envFiles = command.envFiles.map(toRepoPath);
  if (composeFile === RUNTIME_COMPOSE) {
    for (const profile of RUNTIME_PROFILES) if (!command.profiles.includes(profile)) report("W11", location, `Runtime_Compose render must enable --profile ${profile}`);
    for (const file of RUNTIME_ENV_FILES) if (!envFiles.includes(file)) report("W11", location, `Runtime_Compose render must pass --env-file ${file}`);
  }
  const blocking = [];
  if (command.unsupported.length > 0) blocking.push(`docker compose option(s) ${command.unsupported.join(" ")} are not modeled offline`);
  if (command.subcommand !== "config") blocking.push(`docker compose step must run config, found ${describe(command.subcommand)}`);
  if (composeFile === undefined) blocking.push(`docker compose step must pass exactly one -f compose file, found ${command.files.length}`);
  const workingDirectory = step.raw["working-directory"] ?? job.definition.defaults?.run?.["working-directory"] ?? doc.defaults?.run?.["working-directory"];
  if (workingDirectory !== undefined) blocking.push(`working-directory ${describe(workingDirectory)} is not modeled; compose paths resolve from the repository root`);
  for (const file of envFiles) {
    if (!ENV_FILE_ARGUMENT.test(file) || !isFile(path.join(root, file))) blocking.push(`--env-file ${file} is not an existing config/*.example.env file`);
  }
  const shellEnv = effectiveEnv(job, step);
  for (const [key, value] of Object.entries(shellEnv)) {
    if (typeof value !== "string" || value.includes("${{")) blocking.push(`env ${key} is ${describe(value)}, which cannot be simulated offline`);
  }
  if (composeFile !== undefined && !isFile(path.join(root, composeFile))) blocking.push(`compose file ${composeFile} does not exist`);
  for (const message of blocking) report("W11", location, message);
  if (blocking.length > 0) return composeFile;

  const composePath = path.join(root, composeFile);
  const envFilePaths = envFiles.map((file) => path.join(root, file));
  const env = new Map();
  try {
    for (const file of envFilePaths) for (const [key, value] of parseEnvFile(readFileSync(file, "utf8"), display(file))) env.set(key, value);
  } catch (error) {
    if (!(error instanceof UnsupportedEnvSyntax)) throw error;
    report("W11", location, `${error.file}:${error.line}: ${error.detail}`);
    return composeFile;
  }
  for (const [key, value] of Object.entries(shellEnv)) env.set(key, value);

  let model;
  try {
    model = yaml.load(normalizeNewlines(readFileSync(composePath, "utf8")), { filename: composeFile });
  } catch (error) {
    report("W11", location, `${composeFile} cannot be parsed (${error.message.split("\n")[0]})`);
    return composeFile;
  }
  const missing = new Map();
  let invalid = false;
  visitStrings(model, [], (value, keys) => {
    try {
      interpolate(value, env);
    } catch (error) {
      if (error instanceof MissingRequiredVariable) {
        if (!missing.has(error.variable)) missing.set(error.variable, { message: error.requiredMessage, at: keys.join(".") });
      } else if (error instanceof InvalidInterpolation) {
        invalid = true;
        report("W11", location, `${composeFile} ${keys.join(".")}: ${error.message}`);
      } else {
        throw error;
      }
    }
  });
  for (const [variable, { message, at }] of missing) report("W11", location, `${composeFile}: required variable ${variable} has no value${message ? ` (${message})` : ""}, first used at ${at}`);
  if (missing.size > 0 || invalid) return composeFile;

  let entries;
  try {
    entries = resolveComposeEnvFiles({ composeFile: composePath, envFiles: envFilePaths, shellEnv });
  } catch (error) {
    if (!(error instanceof MissingRequiredVariable || error instanceof InvalidInterpolation || error instanceof UnsupportedEnvSyntax || error.constructor === Error)) throw error;
    report("W11", location, error.message);
    return composeFile;
  }
  const configDirectory = path.join(root, "config");
  for (const entry of entries) {
    const exists = isFile(entry.resolvedPath);
    if (!exists || !isInside(configDirectory, entry.resolvedPath)) {
      report("W11", location, `service ${entry.service} env_file ${entry.entry} resolves to ${display(entry.resolvedPath)}, which ${exists ? "is not under config/" : "does not exist"}`);
      continue;
    }
    try {
      parseEnvFile(readFileSync(entry.resolvedPath, "utf8"), display(entry.resolvedPath));
    } catch (error) {
      if (!(error instanceof UnsupportedEnvSyntax)) throw error;
      report("W11", location, `${error.file}:${error.line}: ${error.detail}`);
    }
  }
  return composeFile;
}

function checkComposeRender() {
  const job = requireJob("W11", "compose-render", "Control_Plane_Compose and Runtime_Compose are not rendered");
  if (!job) return;
  const rendered = new Set();
  for (const step of verificationSteps(job)) {
    for (const tokens of step.tokens) {
      if (startsWith(tokens, ["docker", "compose"])) rendered.add(simulateCompose(job, step, tokens));
    }
  }
  for (const file of [CONTROL_PLANE_COMPOSE, RUNTIME_COMPOSE]) {
    if (!rendered.has(file)) report("W11", `${job.id}/-`, `no docker compose ... config step renders ${file}`);
  }
}

function checkStaticGates() {
  const job = requireJob("W12", "static-gates", "Requirement 2.4 checks do not run");
  if (!job) return;
  for (const command of STATIC_GATE_COMMANDS) {
    const expected = tokenize(command);
    const found = verificationSteps(job).some((step) => step.tokens.some((tokens) => Array.isArray(tokens) && tokens.length === expected.length && startsWith(tokens, expected)));
    if (!found) report("W12", `${job.id}/-`, `static-gates has no step running ${command}`);
  }
}

checkPermissions();
checkRunners();
checkIsolation();
checkExitCodes();
const pinnedReferences = checkActionPins();
checkStepInventory();
checkPostgres();
checkGatewayTests();
checkPyCompile();
checkDockerBuilds();
checkComposeRender();
checkStaticGates();

if (violations.length > 0) {
  for (const { rule, location, message } of violations) console.error(`RULE ${rule} ${location} ${message}`);
  console.error(`FAIL  ci workflow structure: ${violations.length} violation(s) in ${display(workflowFile)}`);
  process.exit(1);
}
const verificationCount = jobList.reduce((total, job) => total + verificationSteps(job).length, 0);
console.log(`PASS  ci workflow structure: W1-W12 hold for ${display(workflowFile)} (${jobList.length} jobs, ${verificationCount} verification steps, ${pinnedReferences} third-party action references in ci.yml and release.yml match ${display(pinsFile)})`);
