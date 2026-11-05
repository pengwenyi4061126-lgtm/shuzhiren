// Online check of .github/action-pins.json against upstream (design part 1
// §3.1, §3.3, §3.4; Requirement 3.4, 3.5, 3.8). Runs only in the static-gates
// CI job because it needs network access; the offline rule W5 of
// scripts/check-ci-workflow.mjs compares the workflows with the pin file.
//
// For every pinned action:
//   tag-commit   `git ls-remote --tags https://github.com/<owner>/<repo> refs/tags/<tag> refs/tags/<tag>^{}`
//                resolves the tag to the pinned commit. The peeled `^{}` line is
//                the commit of an annotated tag; without it the tag is lightweight
//                and the `refs/tags/<tag>` line is the commit.
//   runs-using   action.yml (or action.yaml) at the pinned commit, read from
//                raw.githubusercontent.com, declares runs.using nodeNN with NN >= 24
//                or docker. A composite action passes when every `uses` inside
//                runs.steps does, checked recursively.
//   runs-using-record  runs.using equals the runsUsing recorded in the pin file.
// For every step of every workflow in .github/workflows that uses a third-party
// action:
//   input        every key under `with:` is declared under `inputs` of that
//                action's metadata at the referenced commit (case-insensitive,
//                as the runner treats input names).
//
// Usage: node scripts/verify-action-pins.mjs [--pins <file>]
//   --pins  defaults to .github/action-pins.json; workflows are read from the
//           .github/workflows directory of this repository.
// Exit codes: 0 every check passes; 1 one `PIN <action> <check> expected=<...>
// actual=<...>` line per mismatch; 2 the pin file or a workflow cannot be read,
// or a network request failed (`ERROR network ...`). A network failure is a
// failure, never a pass. GITHUB_TOKEN is not used.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { jobs, loadWorkflow, normalizeNewlines, steps, WorkflowLoadError } from "./lib/workflow-model.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUEST_TIMEOUT_MS = 30_000;
const LS_REMOTE_TIMEOUT_MS = 60_000;
const MAX_COMPOSITE_DEPTH = 5;
const MIN_NODE_MAJOR = 24;
const ACTION_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9_.+/-]*$/;
const REMOTE_USES = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)((?:\/[^@\s]+)?)@([^\s@]+)$/;

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Commit a tag points to in `git ls-remote` output: the peeled `refs/tags/<tag>^{}`
 * line when present (annotated tag), otherwise the `refs/tags/<tag>` line
 * (lightweight tag). The SHA of an annotated tag object is never returned.
 * @returns {string|null}
 */
export function resolveTagCommit(lsRemoteOutput, tag) {
  let direct = null;
  let peeled = null;
  for (const line of normalizeNewlines(String(lsRemoteOutput)).split("\n")) {
    const match = /^([0-9a-f]{40})\t(\S+)$/.exec(line.trim());
    if (!match) continue;
    if (match[2] === `refs/tags/${tag}^{}`) peeled = match[1];
    else if (match[2] === `refs/tags/${tag}`) direct = match[1];
  }
  return peeled ?? direct;
}

/**
 * Classifies runs.using: "node-ok" for nodeNN with NN >= 24, "node-outdated"
 * for an older nodeNN, "docker", "composite", or "unknown".
 */
export function classifyRuntime(using) {
  if (typeof using !== "string") return "unknown";
  const node = /^node(\d+)$/.exec(using);
  if (node) return Number(node[1]) >= MIN_NODE_MAJOR ? "node-ok" : "node-outdated";
  if (using === "docker" || using === "composite") return using;
  return "unknown";
}

class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = "NetworkError";
  }
}

function parseArguments(argv) {
  let pins = path.join(repoRoot, ".github", "action-pins.json");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--pins" || argv[i + 1] === undefined || argv[i + 1].startsWith("--")) {
      console.error(`ERROR usage: unexpected argument ${argv[i]}; expected [--pins <file>]`);
      process.exit(2);
    }
    pins = path.resolve(argv[i + 1]);
    i += 1;
  }
  return { pinsFile: pins };
}

function lsRemoteTag(action, tag) {
  const url = `https://github.com/${action}`;
  const result = spawnSync("git", ["ls-remote", "--tags", url, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
    encoding: "utf8",
    timeout: LS_REMOTE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
  if (result.error) throw new NetworkError(`git ls-remote ${url} failed (${result.error.code ?? result.error.message})`);
  if (result.status !== 0) throw new NetworkError(`git ls-remote ${url} exited ${result.status}: ${(result.stderr ?? "").trim().replace(/\s+/g, " ")}`);
  return resolveTagCommit(result.stdout, tag);
}

const metadataCache = new Map();

/** action.yml, else action.yaml, of `<action><subPath>` at `ref`; null when neither exists. */
async function actionMetadata(action, ref, subPath = "") {
  const key = `${action}${subPath}@${ref}`;
  if (!metadataCache.has(key)) metadataCache.set(key, fetchActionMetadata(action, ref, subPath));
  return metadataCache.get(key);
}

async function fetchActionMetadata(action, ref, subPath) {
  for (const file of ["action.yml", "action.yaml"]) {
    const url = `https://raw.githubusercontent.com/${action}/${ref}${subPath}/${file}`;
    let response;
    try {
      response = await fetch(url, { headers: { "User-Agent": "shuzhiren-action-pins" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new NetworkError(`GET ${url} failed (${error.cause?.code ?? error.message})`);
    }
    if (response.status === 404) continue;
    if (!response.ok) throw new NetworkError(`GET ${url} returned HTTP ${response.status}`);
    const text = await response.text();
    try {
      const doc = yaml.load(normalizeNewlines(text), { schema: yaml.FAILSAFE_SCHEMA, filename: url });
      return { url, doc: isMapping(doc) ? doc : {} };
    } catch (error) {
      return { url, doc: {}, parseError: error.message };
    }
  }
  return null;
}

/** Runtime problems of an action and, for composite actions, of every nested `uses`. */
async function runtimeProblems(action, ref, subPath, depth, seen) {
  const spec = `${action}${subPath}@${ref}`;
  if (seen.has(spec)) return [];
  seen.add(spec);
  const metadata = await actionMetadata(action, ref, subPath);
  if (!metadata) return [{ spec, actual: "no action.yml or action.yaml" }];
  if (metadata.parseError) return [{ spec, actual: `unparsable ${metadata.url} (${metadata.parseError})` }];
  const using = isMapping(metadata.doc.runs) ? metadata.doc.runs.using : undefined;
  const kind = classifyRuntime(using);
  if (kind === "node-ok" || kind === "docker") return [];
  if (kind !== "composite") return [{ spec, actual: String(using) }];
  if (depth >= MAX_COMPOSITE_DEPTH) return [{ spec, actual: `composite nesting deeper than ${MAX_COMPOSITE_DEPTH}` }];
  const problems = [];
  const nestedSteps = Array.isArray(metadata.doc.runs.steps) ? metadata.doc.runs.steps : [];
  for (const step of nestedSteps) {
    const uses = isMapping(step) && typeof step.uses === "string" ? step.uses.trim() : undefined;
    if (uses === undefined || uses.startsWith("docker://")) continue;
    if (uses.startsWith("./")) {
      problems.push(...(await runtimeProblems(action, ref, path.posix.join(subPath || "/", uses.slice(2)).replace(/\/+$/, ""), depth + 1, seen)));
      continue;
    }
    const match = REMOTE_USES.exec(uses);
    if (!match) {
      problems.push({ spec, actual: `unrecognized nested uses ${uses}` });
      continue;
    }
    problems.push(...(await runtimeProblems(match[1], match[3], match[2], depth + 1, seen)));
  }
  return problems;
}

function readPins(file) {
  let pins;
  try {
    pins = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    console.error(`ERROR pins ${file}: cannot read or parse (${error.code ?? error.message})`);
    process.exit(2);
  }
  const entries = isMapping(pins) && isMapping(pins.actions) ? Object.entries(pins.actions) : [];
  if (entries.length === 0) {
    console.error(`ERROR pins ${file}: actions must be a non-empty mapping`);
    process.exit(2);
  }
  return entries;
}

function readWorkflows() {
  const directory = path.join(repoRoot, ".github", "workflows");
  let names;
  try {
    names = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name)).sort();
  } catch (error) {
    console.error(`ERROR workflows ${directory}: cannot list (${error.code ?? error.message})`);
    process.exit(2);
  }
  return names.map((name) => {
    try {
      return { name, workflow: loadWorkflow(path.join(directory, name)) };
    } catch (error) {
      if (!(error instanceof WorkflowLoadError)) throw error;
      console.error(`ERROR workflow ${error.message}`);
      return process.exit(2);
    }
  });
}

async function main(argv) {
  const { pinsFile } = parseArguments(argv);
  const pins = readPins(pinsFile);
  const workflows = readWorkflows();
  const mismatches = [];
  const networkErrors = [];
  const report = (action, check, expected, actual) => mismatches.push(`PIN ${action} ${check} expected=${expected} actual=${actual}`);
  const guarded = async (task) => {
    try {
      await task();
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error;
      networkErrors.push(error.message);
    }
  };

  for (const [action, pin] of pins) {
    if (!ACTION_NAME.test(action) || !isMapping(pin) || typeof pin.tag !== "string" || !TAG_NAME.test(pin.tag) || typeof pin.commit !== "string" || !/^[0-9a-f]{40}$/.test(pin.commit)) {
      report(action, "record", "<owner>/<repo> with tag and 40-hex commit", JSON.stringify(pin));
      continue;
    }
    await guarded(async () => {
      const commit = lsRemoteTag(action, pin.tag);
      if (commit !== pin.commit) report(action, "tag-commit", `${pin.tag}->${pin.commit}`, `${pin.tag}->${commit ?? "missing"}`);
    });
    await guarded(async () => {
      const metadata = await actionMetadata(action, pin.commit);
      const using = metadata && isMapping(metadata.doc.runs) ? metadata.doc.runs.using : undefined;
      for (const problem of await runtimeProblems(action, pin.commit, "", 0, new Set())) {
        report(action, problem.spec === `${action}@${pin.commit}` ? "runs-using" : "nested-runs-using", `node${MIN_NODE_MAJOR}+|docker`, problem.spec === `${action}@${pin.commit}` ? problem.actual : `${problem.spec}:${problem.actual}`);
      }
      if (using !== undefined && using !== pin.runsUsing) report(action, "runs-using-record", pin.runsUsing, using);
    });
  }

  let usesCount = 0;
  for (const { name, workflow } of workflows) {
    for (const job of jobs(workflow)) {
      for (const step of steps(job)) {
        const match = step.uses === undefined ? null : REMOTE_USES.exec(step.uses.trim());
        if (!match) continue;
        usesCount += 1;
        const keys = step.with ? Object.keys(step.with) : [];
        if (keys.length === 0) continue;
        const [, action, subPath, ref] = match;
        await guarded(async () => {
          const metadata = await actionMetadata(action, ref, subPath);
          if (!metadata) {
            report(`${action}${subPath}`, "input", "action.yml or action.yaml", `missing at ${ref} (${name} ${job.id}/${step.index})`);
            return;
          }
          const declared = new Set(Object.keys(isMapping(metadata.doc.inputs) ? metadata.doc.inputs : {}).map((key) => key.toLowerCase()));
          for (const key of keys) {
            if (!declared.has(key.toLowerCase())) report(`${action}${subPath}`, "input", "an input declared in action.yml", `${key} (${name} ${job.id}/${step.index})`);
          }
        });
      }
    }
  }

  for (const line of mismatches) console.error(line);
  for (const message of networkErrors) console.error(`ERROR network ${message}`);
  if (networkErrors.length > 0) {
    console.error(`FAIL  action pins: ${networkErrors.length} network request(s) failed; the pins are not verified`);
    return 2;
  }
  if (mismatches.length > 0) {
    console.error(`FAIL  action pins: ${mismatches.length} mismatch(es) with upstream`);
    return 1;
  }
  console.log(`PASS  action pins: ${pins.length} pinned actions match their upstream tags and runtimes; ${usesCount} uses in ${workflows.length} workflows pass only declared inputs`);
  return 0;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = path.resolve(process.argv[1]);
  return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry;
}

if (isMainModule()) process.exitCode = await main(process.argv.slice(2));
