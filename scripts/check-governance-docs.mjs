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
// With --commit-msg it also validates a commit message: each
// `Verification-Log: V-YYYYMMDD-NN` trailer must name a valid log entry, and
// each embedded ```yaml block must be a valid entry, where `提交: 本提交` is
// allowed. Run it before every commit:
//   npm run docs:governance:check -- --commit-msg <file>   (or - for stdin)
//
// Usage: node scripts/check-governance-docs.mjs [--log <path>] [--register <path>] [--commit-msg <file|->]
//   --log       log to validate, default docs/VERIFICATION_LOG.md (tests point it at fixtures).
//   --register  register to validate, default docs/AUDIT_REGISTER.md.
// Labels, Static_Gates and named CI steps are read from this repository's
// scripts/verify-local-checks.mjs, scripts/ci-required-steps.mjs, package.json
// and .github/workflows/ci.yml.
// Output: one `<code> <entry|record|file:line> <field>: <message>` line per
// error (codes VLOG, VLOG-LABEL-UNKNOWN, AR-*, SECRET) and `NOTE ...` lines for
// coverage that could not be checked because git cannot resolve the commit
// (for example in a shallow CI checkout).
// Exit codes: 0 no errors; 1 errors; 2 an input cannot be read (`ERROR ...`).
import { readFileSync } from "node:fs";
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`ERROR ${message}`);
  process.exit(2);
}

function parseArguments(argv) {
  const options = { log: path.join(root, DEFAULT_LOG_FILE), register: path.join(root, DEFAULT_REGISTER_FILE), commitMessage: null };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (name !== "--log" && name !== "--register" && name !== "--commit-msg") fail(`usage: unknown argument ${name}; expected [--log <path>] [--register <path>] [--commit-msg <file|->]`);
    const value = argv[i + 1];
    if (value === undefined || (value.startsWith("--") && value !== "-")) fail(`usage: ${name} requires a value`);
    if (name === "--log") options.log = path.resolve(value);
    else if (name === "--register") options.register = path.resolve(value);
    else options.commitMessage = value;
    i += 1;
  }
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
if (commitText !== null) {
  const message = validateCommitMessage(commitText, { ...context, entries: log.entries });
  errors.push(...message.errors);
  notes.push(...message.notes);
}

const describe = (item) => `${item.code} ${item.id} ${item.field ? `${item.field}: ` : ""}${item.message}`;
for (const note of notes) console.log(`NOTE ${describe(note)}`);
if (errors.length > 0) {
  for (const error of errors) console.error(describe(error));
  console.error(`FAIL  governance docs: ${errors.length} error(s) in ${displayPath(options.log)}, ${displayPath(options.register)}${commitText === null ? "" : " and the commit message"}`);
  process.exit(1);
}
const verdicts = log.entries.map((entry) => `${entry.id} ${entry.verdict}`).join("; ");
const statuses = Object.entries(countByStatus(register.records)).filter(([, count]) => count > 0).map(([status, count]) => `${status} ${count}`).join(", ");
console.log(`PASS  governance docs: ${displayPath(options.log)} has ${log.entries.length} valid entries (${verdicts || "none"}); ${displayPath(options.register)} has ${register.records.length} valid records (${statuses || "none"})${commitText === null ? "" : "; commit message verification claims are valid"}`);
