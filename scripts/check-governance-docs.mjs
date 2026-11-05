// Documentation governance gate (design part 1 §4.1-4.4, §6.1, §7.1-7.4; part 8
// §2.1; Requirement 1.12, 1.14, 1.15, 4.1-4.8, 6.8, 7.1-7.15, 36.13, 36.14).
// It validates docs/VERIFICATION_LOG.md with scripts/lib/verification-log.mjs:
//   - every `## V-YYYYMMDD-NN <结论摘要>` heading has one ```yaml block of a type
//     registered in ENTRY_TYPES, with the source fields of Requirement 4.2-4.5;
//   - `判定` equals classifyConclusion (Requirement 4.6-4.8);
//   - every check and step label equals its label in LOCAL_CHECKS or
//     CI_ONLY_STEPS (VLOG-LABEL-UNKNOWN when the name is in neither list);
//   - `静态门禁覆盖` lists every Static_Gate of the evidence with the behavioral
//     tests of scripts/static-gate-coverage.mjs as of the entry's commit, or [无]
//     when that mapping is empty or the file does not exist in that commit;
//   - no line matches a secret pattern (SECRET).
// It validates docs/AUDIT_REGISTER.md with scripts/lib/audit-register.mjs:
//   - C1-C4, H1-H7, M1-M25, L1-L18 each exactly once and new defects N1…Nk
//     without gaps (AR-SET); L items keep the report's wording (AR-LOW-TEXT);
//   - the required fields and their formats (AR-FIELD, AR-PRIORITY);
//   - `状态` equals deriveStatus (AR-STATUS), with the rules for verifications
//     (AR-VERIFY), fix order (AR-ORDER), negations (AR-NEGATE) and fixes (AR-FIX);
//     `记录` references must name entries of the log validated above;
//   - no line matches a secret pattern (SECRET).
// It validates docs/DEPLOYMENT_READINESS.md with scripts/lib/readiness-matrix.mjs
// (design part 1 §6.1-6.5; part 8 Requirement 40 §6.1; Requirement 6.1-6.8,
// 32.10, 32.11, 40.1, 40.5-40.7): sections, table headers, row ids, statuses,
// EP-01 to EP-14, EP and RW evidence, environment rows, decision D1 and the
// secret patterns (codes RM-*, SECRET). 代码已完成且有验证证据 rows must cite
// entries of the log validated above; when the log has structure errors those
// rows count as unsupported.
// It validates the Handoff_Doc files (README.md, docs/RESUME_HANDOFF.md,
// docs/FRAMEWORK_STATUS.md, docs/IMPLEMENTATION_ROADMAP.md) and the CLAIM rule
// over every docs/*.md file except the log and the register with
// scripts/lib/handoff-docs.mjs (design part 1 §4.4, §5.1-5.5; part 8
// Requirement 40 §6.1): CLAIM, CI-CLAIM, RUN-REF, AUDIT-LIST, CHECKPOINT,
// STALE-SYNC, MATRIX-STATUS and, while D1 is 待用户决策, D1-MENTION, D1-STATUS,
// D1-DEFAULT. CLAIM hits in CLAIM_PENDING_FILES (docs/DEPLOYMENT_RUNBOOK.md)
// print as NOTE lines until that file's maintainer resolves them.
// With --commit-msg it also validates a commit message: each
// `Verification-Log: V-YYYYMMDD-NN` trailer must name a valid log entry, and
// each embedded ```yaml block must be a valid entry, where `提交: 本提交` is
// allowed. Run it before every commit:
//   npm run docs:governance:check -- --commit-msg <file>   (or - for stdin)
//
// Usage: node scripts/check-governance-docs.mjs [--log <path>] [--register <path>] [--docs-root <dir>] [--commit-msg <file|->]
//   --log        log to validate, default docs/VERIFICATION_LOG.md (tests point it at fixtures).
//   --register   register to validate, default docs/AUDIT_REGISTER.md.
//   --docs-root  directory holding README.md and docs/ for the matrix and
//                Handoff_Doc checks, default the repository root. When --log or
//                --register points at a fixture and --docs-root is not given,
//                the matrix and Handoff_Doc checks are skipped, because the
//                repository documents cite the repository log and register.
// Labels, Static_Gates and named CI steps are read from this repository's
// scripts/verify-local-checks.mjs, scripts/ci-required-steps.mjs, package.json
// and .github/workflows/ci.yml.
// Output: one `<code> <entry|record|file:line> <field>: <message>` line per
// error (codes VLOG, VLOG-LABEL-UNKNOWN, AR-*, RM-*, the Handoff_Doc codes and
// SECRET; matrix and Handoff_Doc errors read `<code> <file>:<line> <message>`) and `NOTE ...` lines for
// coverage that could not be checked because git cannot resolve the commit
// (for example in a shallow CI checkout).
// Exit codes: 0 no errors; 1 errors; 2 an input cannot be read (`ERROR ...`).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { loadWorkflow, WorkflowLoadError } from "./lib/workflow-model.mjs";
import {
  coverageCommits,
  createCheckResolver,
  DEFAULT_LOG_FILE,
  loadStaticGateCoverage,
  parseCommitMessage,
  parseVerificationLog,
  validateCommitMessage,
  validateVerificationLog
} from "./lib/verification-log.mjs";
import { countByStatus, DEFAULT_REGISTER_FILE, validateAuditRegister } from "./lib/audit-register.mjs";
import { MATRIX_FILE, parseReadinessMatrix, validateReadinessMatrix } from "./lib/readiness-matrix.mjs";
import { CLAIM_EXCLUDED_FILES, CLAIM_PENDING_FILES, HANDOFF_FILES, validateHandoffDocs } from "./lib/handoff-docs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`ERROR ${message}`);
  process.exit(2);
}

function parseArguments(argv) {
  const options = { log: path.join(root, DEFAULT_LOG_FILE), register: path.join(root, DEFAULT_REGISTER_FILE), docsRoot: null, commitMessage: null };
  let fixtureInputs = false;
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (!["--log", "--register", "--docs-root", "--commit-msg"].includes(name)) fail(`usage: unknown argument ${name}; expected [--log <path>] [--register <path>] [--docs-root <dir>] [--commit-msg <file|->]`);
    const value = argv[i + 1];
    if (value === undefined || (value.startsWith("--") && value !== "-")) fail(`usage: ${name} requires a value`);
    if (name === "--log") options.log = path.resolve(value);
    else if (name === "--register") options.register = path.resolve(value);
    else if (name === "--docs-root") options.docsRoot = path.resolve(value);
    else options.commitMessage = value;
    if (name === "--log" || name === "--register") fixtureInputs = true;
    i += 1;
  }
  if (options.docsRoot === null && !fixtureInputs) options.docsRoot = root;
  return options;
}

function readText(file, label) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    fail(`missing ${label} (${error.code ?? error.message})`);
  }
}

const displayPath = (file) => path.relative(root, file).split(path.sep).join("/") || file;

const options = parseArguments(process.argv.slice(2));
const logText = readText(options.log, displayPath(options.log));
const registerText = readText(options.register, displayPath(options.register));
const commitText = options.commitMessage === null ? null : options.commitMessage === "-" ? readText(0, "commit message on stdin") : readText(path.resolve(options.commitMessage), `commit message ${options.commitMessage}`);

let scripts;
try {
  scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
} catch (error) {
  fail(`cannot read package.json scripts (${error.code ?? error.message})`);
}
let workflow;
try {
  workflow = loadWorkflow(path.join(root, ".github", "workflows", "ci.yml"));
} catch (error) {
  if (!(error instanceof WorkflowLoadError)) throw error;
  fail(`source=CI_Pipeline reason=${error.message}`);
}
const resolver = createCheckResolver({ scripts, root, workflow });

function embeddedEntries(text) {
  return parseCommitMessage(text).blocks.flatMap((block) => {
    try {
      return [yaml.load(block.text, { schema: yaml.FAILSAFE_SCHEMA })];
    } catch {
      return [];
    }
  });
}

const commits = coverageCommits([...parseVerificationLog(logText).entries.map((entry) => entry.data), ...(commitText === null ? [] : embeddedEntries(commitText))]);
const coverage = await loadStaticGateCoverage(commits, { root });
const context = { resolver, coverageFor: (commit) => coverage.get(commit), file: displayPath(options.log) };

const log = validateVerificationLog(logText, context);
const register = validateAuditRegister(registerText, { resolver, vlog: log.entries, file: displayPath(options.register) });
const errors = [...log.errors, ...register.errors];
const notes = [...log.notes];

let matrixSummary = null;
let handoffSummary = null;
if (options.docsRoot !== null) {
  const docsRoot = options.docsRoot;
  const matrixText = readText(path.join(docsRoot, MATRIX_FILE), MATRIX_FILE);
  // §6.4: a log with structure errors gives no evidence; its own errors are reported above.
  const logParsedCleanly = parseVerificationLog(logText).errors.length === 0;
  for (const error of validateReadinessMatrix(matrixText, { vlog: logParsedCleanly ? log.entries : null })) {
    errors.push({ code: error.code, id: `${MATRIX_FILE}:${error.line}`, field: "", message: error.message });
  }
  const matrix = parseReadinessMatrix(matrixText);
  const files = {};
  for (const file of HANDOFF_FILES) files[file] = readText(path.join(docsRoot, file), file);
  let docNames;
  try {
    docNames = readdirSync(path.join(docsRoot, "docs")).filter((name) => name.endsWith(".md")).sort();
  } catch (error) {
    fail(`missing docs/ (${error.code ?? error.message})`);
  }
  for (const name of docNames) {
    const file = `docs/${name}`;
    if (CLAIM_EXCLUDED_FILES.includes(file) || files[file] !== undefined) continue;
    files[file] = file === MATRIX_FILE ? matrixText : readText(path.join(docsRoot, file), file);
  }
  for (const error of validateHandoffDocs({ files }, { audit: register.records, matrix, vlog: log.entries })) {
    const item = { code: error.code, id: `${error.file}:${error.line}`, field: "", message: error.message };
    if (error.code === "CLAIM" && CLAIM_PENDING_FILES.includes(error.file)) notes.push(item);
    else errors.push(item);
  }
  const counts = new Map();
  for (const row of matrix.rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  matrixSummary = `${MATRIX_FILE} has ${matrix.rows.length} rows (${[...counts].map(([status, count]) => `${status} ${count}`).join(", ")})`;
  handoffSummary = `${Object.keys(files).length} Handoff_Doc and docs files pass the claim rules`;
}
if (commitText !== null) {
  const message = validateCommitMessage(commitText, { ...context, entries: log.entries });
  errors.push(...message.errors);
  notes.push(...message.notes);
}

const describe = (item) => `${item.code} ${item.id} ${item.field ? `${item.field}: ` : ""}${item.message}`;
for (const note of notes) console.log(`NOTE ${describe(note)}`);
if (errors.length > 0) {
  for (const error of errors) console.error(describe(error));
  console.error(`FAIL  governance docs: ${errors.length} error(s) in ${displayPath(options.log)}, ${displayPath(options.register)}${matrixSummary === null ? "" : `, ${MATRIX_FILE}, the Handoff_Doc files`}${commitText === null ? "" : " and the commit message"}`);
  process.exit(1);
}
const verdicts = log.entries.map((entry) => `${entry.id} ${entry.verdict}`).join("; ");
const statuses = Object.entries(countByStatus(register.records)).filter(([, count]) => count > 0).map(([status, count]) => `${status} ${count}`).join(", ");
console.log(`PASS  governance docs: ${displayPath(options.log)} has ${log.entries.length} valid entries (${verdicts || "none"}); ${displayPath(options.register)} has ${register.records.length} valid records (${statuses || "none"})${matrixSummary === null ? "" : `; ${matrixSummary}; ${handoffSummary}`}${commitText === null ? "" : "; commit message verification claims are valid"}`);
