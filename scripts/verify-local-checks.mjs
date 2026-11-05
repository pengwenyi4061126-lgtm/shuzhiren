// Single source of the Local_Verification check list. scripts/verify-local.mjs
// runs it; the CI coverage and workflow gates compare it with ci.yml.
//
// Labels (Requirement 36.10, 36.11): a check is "behavioral" only when it is a
// Behavioral_Test whose every assertion is about the result of executing the
// code under test, with no substring or regex match against repository file
// text. Everything else is "static", including typecheck, lint, build,
// `node --check` and `py_compile`.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { tokenize, UnparsableCommand } from "./lib/workflow-model.mjs";

/** @typedef {"static"|"behavioral"} CheckLabel */
/** @typedef {{ id: string, kind: "npm", script: string, args?: string[], label: CheckLabel }
 *  | { id: string, kind: "node-check", entry: string, label: "static" }
 *  | { id: string, kind: "python", file: string, label: CheckLabel, gatewayOnly: true }
 *  | { id: string, kind: "py-compile", files: string[], label: "static", gatewayOnly: true }} LocalCheck */

export const CHECK_LABELS = Object.freeze(["static", "behavioral"]);

function freezeCheck(check) {
  for (const key of ["args", "files"]) if (Array.isArray(check[key])) Object.freeze(check[key]);
  return Object.freeze(check);
}

/** @type {readonly LocalCheck[]} */
export const LOCAL_CHECKS = Object.freeze([
  { id: "deploy:check", kind: "npm", script: "deploy:check", args: ["--", "--allow-placeholders"], label: "static" },
  { id: "deploy:check:test", kind: "npm", script: "deploy:check:test", label: "behavioral" },
  { id: "deploy:manifest:test", kind: "npm", script: "deploy:manifest:test", label: "behavioral" },
  { id: "deploy:images:test", kind: "npm", script: "deploy:images:test", label: "behavioral" },
  { id: "release:evidence:test", kind: "npm", script: "release:evidence:test", label: "behavioral" },
  { id: "release:workflow:check", kind: "npm", script: "release:workflow:check", label: "static" },
  { id: "release:workflow:gate:test", kind: "npm", script: "release:workflow:gate:test", label: "behavioral" },
  { id: "backup:automation:check", kind: "npm", script: "backup:automation:check", label: "static" },
  { id: "backup:restore:drill:test", kind: "npm", script: "backup:restore:drill:test", label: "behavioral" },
  { id: "control-plane:compose:check", kind: "npm", script: "control-plane:compose:check", label: "static" },
  { id: "runtime:compose:check", kind: "npm", script: "runtime:compose:check", label: "static" },
  { id: "console:page-auth:check", kind: "npm", script: "console:page-auth:check", label: "static" },
  { id: "console:security-headers:check", kind: "npm", script: "console:security-headers:check", label: "static" },
  { id: "console:client-requests:check", kind: "npm", script: "console:client-requests:check", label: "static" },
  { id: "membership:authz:check", kind: "npm", script: "membership:authz:check", label: "static" },
  { id: "membership:scopes:check", kind: "npm", script: "membership:scopes:check", label: "static" },
  { id: "governance:tenant-scope:check", kind: "npm", script: "governance:tenant-scope:check", label: "static" },
  { id: "policy:red-team", kind: "npm", script: "policy:red-team", label: "behavioral" },
  { id: "governance:immutability:check", kind: "npm", script: "governance:immutability:check", label: "static" },
  { id: "program:revisions:check", kind: "npm", script: "program:revisions:check", label: "static" },
  { id: "program:runtime-scripts:check", kind: "npm", script: "program:runtime-scripts:check", label: "static" },
  { id: "runtime:program-transition:check", kind: "npm", script: "runtime:program-transition:check", label: "static" },
  { id: "control-room:program-transition:check", kind: "npm", script: "control-room:program-transition:check", label: "static" },
  { id: "runtime:program-output:check", kind: "npm", script: "runtime:program-output:check", label: "static" },
  { id: "preflight:check", kind: "npm", script: "preflight:check", label: "static" },
  { id: "lifecycle:authz:check", kind: "npm", script: "lifecycle:authz:check", label: "static" },
  { id: "command:confirmation:check", kind: "npm", script: "command:confirmation:check", label: "static" },
  { id: "service-ingest:auth:check", kind: "npm", script: "service-ingest:auth:check", label: "static" },
  { id: "service-principals:check", kind: "npm", script: "service-principals:check", label: "static" },
  { id: "start:ack:check", kind: "npm", script: "start:ack:check", label: "static" },
  { id: "runtime:watchdog:check", kind: "npm", script: "runtime:watchdog:check", label: "static" },
  { id: "runtime:outbox:check", kind: "npm", script: "runtime:outbox:check", label: "static" },
  { id: "runtime:telemetry-alerts:check", kind: "npm", script: "runtime:telemetry-alerts:check", label: "static" },
  { id: "entitlement:check", kind: "npm", script: "entitlement:check", label: "static" },
  { id: "runtime:media:check", kind: "npm", script: "runtime:media:check", label: "static" },
  { id: "runtime:voice:check", kind: "npm", script: "runtime:voice:check", label: "static" },
  { id: "runtime:journal:check", kind: "npm", script: "runtime:journal:check", label: "static" },
  { id: "runtime:preview:check", kind: "npm", script: "runtime:preview:check", label: "static" },
  { id: "media:evidence:check", kind: "npm", script: "media:evidence:check", label: "static" },
  { id: "recording:evidence:check", kind: "npm", script: "recording:evidence:check", label: "static" },
  { id: "runtime:images:check", kind: "npm", script: "runtime:images:check", label: "static" },
  { id: "runtime:images:licenses:check", kind: "npm", script: "runtime:images:licenses:check", label: "static" },
  { id: "runtime:images:licenses:test", kind: "npm", script: "runtime:images:licenses:test", label: "behavioral" },
  // static: its first three assertions match the source text of apps/runtime-worker/index.mjs.
  { id: "runtime:worker:config:test", kind: "npm", script: "runtime:worker:config:test", label: "static" },
  { id: "runtime:worker:health:test", kind: "npm", script: "runtime:worker:health:test", label: "behavioral" },
  { id: "runtime:acceptance:test", kind: "npm", script: "runtime:acceptance:test", label: "behavioral" },
  { id: "observer:runtime:test", kind: "npm", script: "observer:runtime:test", label: "behavioral" },
  { id: "observer:targets:test", kind: "npm", script: "observer:targets:test", label: "behavioral" },
  { id: "observer:targets:apply:test", kind: "npm", script: "observer:targets:apply:test", label: "behavioral" },
  { id: "output-probe:test", kind: "npm", script: "output-probe:test", label: "behavioral" },
  { id: "output-probe:config:test", kind: "npm", script: "output-probe:config:test", label: "behavioral" },
  { id: "output-probe:response:check", kind: "npm", script: "output-probe:response:check", label: "static" },
  { id: "channel-adapter:test", kind: "npm", script: "channel-adapter:test", label: "behavioral" },
  { id: "channel:verification:check", kind: "npm", script: "channel:verification:check", label: "static" },
  { id: "settlement:reconciliation:check", kind: "npm", script: "settlement:reconciliation:check", label: "static" },
  { id: "alert-notifier:test", kind: "npm", script: "alert-notifier:test", label: "behavioral" },
  { id: "alert-notifier:health:check", kind: "npm", script: "alert-notifier:health:check", label: "static" },
  { id: "ci:gates:test", kind: "npm", script: "ci:gates:test", label: "behavioral" },
  { id: "ci:coverage:check", kind: "npm", script: "ci:coverage:check", label: "static" },
  { id: "ci:workflow:check", kind: "npm", script: "ci:workflow:check", label: "static" },
  { id: "ci:db-fail-closed:test", kind: "npm", script: "ci:db-fail-closed:test", label: "behavioral" },
  { id: "ci:evidence:test", kind: "npm", script: "ci:evidence:test", label: "behavioral" },
  { id: "docs:governance:check", kind: "npm", script: "docs:governance:check", label: "static" },
  { id: "docs:governance:test", kind: "npm", script: "docs:governance:test", label: "behavioral" },
  { id: "typecheck", kind: "npm", script: "typecheck", label: "static" },
  { id: "lint", kind: "npm", script: "lint", label: "static" },
  { id: "build", kind: "npm", script: "build", label: "static" },
  { id: "node --check apps/runtime-worker/index.mjs", kind: "node-check", entry: "apps/runtime-worker/index.mjs", label: "static" },
  { id: "node --check apps/runtime-observer/index.mjs", kind: "node-check", entry: "apps/runtime-observer/index.mjs", label: "static" },
  { id: "node --check apps/runtime-observer/targets.mjs", kind: "node-check", entry: "apps/runtime-observer/targets.mjs", label: "static" },
  { id: "node --check apps/output-probe/index.mjs", kind: "node-check", entry: "apps/output-probe/index.mjs", label: "static" },
  { id: "node --check apps/channel-adapter/index.mjs", kind: "node-check", entry: "apps/channel-adapter/index.mjs", label: "static" },
  { id: "node --check apps/alert-notifier/index.mjs", kind: "node-check", entry: "apps/alert-notifier/index.mjs", label: "static" },
  { id: "py_compile", kind: "py-compile", files: ["runtime/gateway/app.py", "runtime/gateway/audio.py", "scripts/test-runtime-gateway-config.py"], label: "static", gatewayOnly: true },
  { id: "scripts/test-runtime-gateway-config.py", kind: "python", file: "scripts/test-runtime-gateway-config.py", label: "behavioral", gatewayOnly: true },
  { id: "scripts/test-runtime-gateway-errors.py", kind: "python", file: "scripts/test-runtime-gateway-errors.py", label: "behavioral", gatewayOnly: true },
  { id: "scripts/test-runtime-gateway-audio.py", kind: "python", file: "scripts/test-runtime-gateway-audio.py", label: "behavioral", gatewayOnly: true },
  { id: "scripts/test-runtime-gateway-concurrency.py", kind: "python", file: "scripts/test-runtime-gateway-concurrency.py", label: "behavioral", gatewayOnly: true },
  { id: "scripts/test-runtime-gateway-state-backup.py", kind: "python", file: "scripts/test-runtime-gateway-state-backup.py", label: "behavioral", gatewayOnly: true },
  { id: "scripts/test-runtime-gateway-state-restore-drill.py", kind: "python", file: "scripts/test-runtime-gateway-state-restore-drill.py", label: "behavioral", gatewayOnly: true }
].map(freezeCheck));

export function localChecks({ withGateway = false } = {}) {
  return LOCAL_CHECKS.filter((check) => withGateway || !check.gatewayOnly);
}

/** Command text used in `RUN` lines and in VERIFICATION_LOG entries. */
export function describeCommand(check, { python = "python" } = {}) {
  switch (check.kind) {
    case "npm":
      return ["npm", "run", check.script, ...(check.args ?? [])].join(" ");
    case "node-check":
      return `node --check ${check.entry}`;
    case "python":
      return `${python} ${check.file}`;
    case "py-compile":
      return [python, "-m", "py_compile", ...check.files].join(" ");
    default:
      throw new Error(`unknown check kind: ${check.kind}`);
  }
}

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Structural validation of a check list: unique non-empty `id`, exactly one
 * `label` from CHECK_LABELS, and the fields each `kind` needs.
 * @returns {string[]} one message per problem; empty when the list is valid.
 */
export function validateLocalChecks(checks) {
  if (!Array.isArray(checks)) return ["LOCAL_CHECKS is not an array"];
  if (checks.length === 0) return ["LOCAL_CHECKS is empty"];
  const errors = [];
  const seen = new Set();
  checks.forEach((check, index) => {
    const where = `LOCAL_CHECKS[${index}]`;
    if (check === null || typeof check !== "object") {
      errors.push(`${where} is not an object`);
      return;
    }
    const name = isNonEmptyString(check.id) ? `${where} (${check.id})` : where;
    if (!isNonEmptyString(check.id)) errors.push(`${where} has no id`);
    else if (seen.has(check.id)) errors.push(`${name} duplicates id ${check.id}`);
    else seen.add(check.id);
    if (!CHECK_LABELS.includes(check.label)) errors.push(`${name} label must be exactly one of ${CHECK_LABELS.join(", ")}`);
    switch (check.kind) {
      case "npm":
        if (!isNonEmptyString(check.script)) errors.push(`${name} has no npm script`);
        if (check.args !== undefined && !isStringArray(check.args)) errors.push(`${name} args must be an array of strings`);
        break;
      case "node-check":
        if (!isNonEmptyString(check.entry)) errors.push(`${name} has no entry`);
        if (check.label !== "static") errors.push(`${name} node --check must be labeled static`);
        break;
      case "python":
        if (!isNonEmptyString(check.file)) errors.push(`${name} has no file`);
        if (check.gatewayOnly !== true) errors.push(`${name} Python checks must be gatewayOnly`);
        break;
      case "py-compile":
        if (!isStringArray(check.files) || check.files.length === 0) errors.push(`${name} has no files`);
        if (check.label !== "static") errors.push(`${name} py_compile must be labeled static`);
        if (check.gatewayOnly !== true) errors.push(`${name} py_compile must be gatewayOnly`);
        break;
      default:
        errors.push(`${name} has unknown kind ${String(check.kind)}`);
    }
  });
  return errors;
}

const PYTHON_INTERPRETERS = ["python3", "python"];

function toPosix(file) {
  return file.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

function safeTokenize(command) {
  try {
    return tokenize(command);
  } catch (error) {
    if (error instanceof UnparsableCommand) return null;
    throw error;
  }
}

function sameTokens(left, right) {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function escapeRegExp(text) {
  return text.replace(/[.+?^$()|[\]{}\\]/g, "\\$&");
}

function segmentPattern(segment) {
  return new RegExp(`^${segment.split("*").map(escapeRegExp).join("[^/]*")}$`);
}

/**
 * Expands `*` in a repository-relative path against `root`, like bash without
 * nullglob except that a pattern without matches expands to nothing. `*` does
 * not match a leading dot. Arguments without `*` are returned unchanged.
 * @returns {string[]} sorted POSIX paths relative to root.
 */
export function expandGlob(pattern, root) {
  const normalized = toPosix(pattern);
  if (!normalized.includes("*")) return [normalized];
  let prefixes = [""];
  for (const segment of normalized.split("/")) {
    if (!segment.includes("*")) {
      prefixes = prefixes.map((prefix) => (prefix ? `${prefix}/${segment}` : segment));
      continue;
    }
    const matcher = segmentPattern(segment);
    prefixes = prefixes.flatMap((prefix) => {
      let names;
      try {
        names = readdirSync(path.join(root, prefix || "."));
      } catch {
        return [];
      }
      return names
        .filter((name) => matcher.test(name) && (segment.startsWith(".") || !name.startsWith(".")))
        .map((name) => (prefix ? `${prefix}/${name}` : name));
    });
  }
  return prefixes.filter((candidate) => existsSync(path.join(root, candidate))).sort();
}

function scriptTokens(scripts, name) {
  return typeof scripts?.[name] === "string" ? safeTokenize(scripts[name]) : null;
}

function runsPythonDirectly(tokens, file) {
  return tokens.length === 2 && PYTHON_INTERPRETERS.includes(tokens[0]) && tokens[1] === file;
}

function runsPythonViaRunner(tokens, file) {
  return tokens.length === 3 && tokens[0] === "node" && tokens[1] === "scripts/run-python-test.mjs" && tokens[2] === file;
}

/**
 * Requirement 2.2 coverage: true when the CI command `ciCommand` (a string or
 * pre-split tokens) is a covering step for `check`:
 *   (a) npm: `npm run <script>` with exactly the check's args;
 *   (b) npm: the script's package.json command plus the check's args without a leading `--`;
 *   (c) node-check: `node --check <entry>`;
 *   (d) python: `python3|python <file>`, or `npm run <S>` where S runs the file directly
 *       or via `node scripts/run-python-test.mjs <file>`;
 *   (e) py-compile: `python3|python -m py_compile …` whose `*`-expanded files include every check file.
 * Commands that cannot be tokenized cover nothing.
 * @param {{ scripts?: Record<string, string>, root?: string }} context package.json scripts and repository root.
 */
export function covers(ciCommand, check, { scripts = {}, root = process.cwd() } = {}) {
  const tokens = Array.isArray(ciCommand) ? ciCommand : safeTokenize(ciCommand);
  if (!tokens || tokens.length === 0) return false;
  switch (check.kind) {
    case "npm": {
      const args = check.args ?? [];
      if (tokens[0] === "npm" && tokens[1] === "run" && tokens[2] === check.script && sameTokens(tokens.slice(3), args)) return true;
      const definition = scriptTokens(scripts, check.script);
      if (!definition) return false;
      return sameTokens(tokens, [...definition, ...(args[0] === "--" ? args.slice(1) : args)]);
    }
    case "node-check":
      return sameTokens(tokens, ["node", "--check", check.entry]);
    case "python": {
      if (runsPythonDirectly(tokens, check.file)) return true;
      if (tokens.length !== 3 || tokens[0] !== "npm" || tokens[1] !== "run") return false;
      const definition = scriptTokens(scripts, tokens[2]);
      return Boolean(definition) && (runsPythonDirectly(definition, check.file) || runsPythonViaRunner(definition, check.file));
    }
    case "py-compile": {
      if (tokens.length < 4 || !PYTHON_INTERPRETERS.includes(tokens[0]) || tokens[1] !== "-m" || tokens[2] !== "py_compile") return false;
      const compiled = new Set(tokens.slice(3).flatMap((argument) => expandGlob(argument, root)));
      return check.files.every((file) => compiled.has(toPosix(file)));
    }
    default:
      return false;
  }
}
