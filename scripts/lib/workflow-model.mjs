// Parses GitHub Actions workflow files into a small, read-only model shared by
// the CI gates (Local_Verification, CI_Coverage_Gate, ci.yml structure gate,
// Release_Workflow_Gate). YAML is read with js-yaml's FAILSAFE_SCHEMA, so every
// scalar is a string: full-numeric SHAs, dates and `true` keep their spelling.
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

export class WorkflowLoadError extends Error {
  constructor(file, reason, options) {
    super(`${file}: ${reason}`, options);
    this.name = "WorkflowLoadError";
    this.file = file;
    this.reason = reason;
  }
}

export class UnparsableCommand extends Error {
  constructor(command, reason) {
    super(`unparsable command (${reason}): ${command}`);
    this.name = "UnparsableCommand";
    this.command = command;
    this.reason = reason;
  }
}

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Strips a UTF-8 BOM and normalizes CRLF/CR to LF (core.autocrlf=true checkouts are CRLF). */
export function normalizeNewlines(text) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** @returns {{ file: string, rawText: string, doc: Record<string, unknown> }} */
export function parseWorkflow(text, file = "<inline>") {
  const rawText = normalizeNewlines(text);
  let doc;
  try {
    doc = yaml.load(rawText, { schema: yaml.FAILSAFE_SCHEMA, filename: file });
  } catch (error) {
    throw new WorkflowLoadError(file, `YAML parse failed: ${error.message}`, { cause: error });
  }
  if (!isMapping(doc)) throw new WorkflowLoadError(file, "workflow root is not a mapping");
  return Object.freeze({ file, rawText, doc });
}

export function loadWorkflow(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new WorkflowLoadError(file, `cannot read file (${error.code ?? error.message})`, { cause: error });
  }
  return parseWorkflow(text, file);
}

function documentOf(workflow) {
  return isMapping(workflow) && "rawText" in workflow && "doc" in workflow ? workflow.doc : workflow;
}

/** Jobs in document order. `definition` is the raw job mapping. */
export function jobs(workflow) {
  const doc = documentOf(workflow);
  const map = isMapping(doc) && isMapping(doc.jobs) ? doc.jobs : {};
  return Object.entries(map).map(([id, definition]) => Object.freeze({ id, definition }));
}

/**
 * Splits `run:` into commands: one per line, with backslash-continued lines
 * joined, runs of whitespace collapsed, and blank and `#` comment lines dropped.
 */
export function commands(step) {
  const run = step && typeof step.run === "string" ? step.run : undefined;
  if (run === undefined) return [];
  const lines = [];
  let pending = "";
  for (const line of normalizeNewlines(run).split("\n")) {
    if (/\\\s*$/.test(line)) {
      pending += `${line.replace(/\\\s*$/, "")} `;
      continue;
    }
    lines.push(pending + line);
    pending = "";
  }
  if (pending !== "") lines.push(pending);
  return lines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function isPreparationStep(step, name, uses) {
  if (typeof uses === "string") return true;
  if (typeof name === "string" && name.startsWith("prep:")) return true;
  const lines = commands(step);
  return lines.length === 1 && lines[0] === "npm ci";
}

/**
 * Steps of one job. Preparation steps are `uses:` steps, a bare `npm ci`, and
 * steps whose name starts with `prep:`; every other step is a verification step.
 * `index` is the 0-based position in the job's `steps` list.
 */
export function steps(job) {
  const definition = job && isMapping(job.definition) ? job.definition : {};
  const list = Array.isArray(definition.steps) ? definition.steps : [];
  return list.map((raw, index) => {
    const step = isMapping(raw) ? raw : {};
    const name = typeof step.name === "string" ? step.name : undefined;
    const uses = typeof step.uses === "string" ? step.uses : undefined;
    return Object.freeze({
      jobId: job.id,
      index,
      name,
      uses,
      run: typeof step.run === "string" ? step.run : undefined,
      env: isMapping(step.env) ? step.env : undefined,
      with: isMapping(step.with) ? step.with : undefined,
      isPreparation: isPreparationStep(step, name, uses),
      raw: step
    });
  });
}

/**
 * Shell-style word splitting with single quotes, double quotes (escapes for
 * `"`, `\`, `$` and backtick) and backslash escapes outside quotes. Operators
 * such as `&&` or `|` are returned as ordinary words.
 * @throws {UnparsableCommand} on an unterminated quote or a trailing backslash.
 */
export function tokenize(command) {
  const tokens = [];
  let current = "";
  let inToken = false;
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === "\"") {
      if (ch === "\"") quote = null;
      else if (ch === "\\" && i + 1 < command.length && "\"\\$`".includes(command[i + 1])) current += command[++i];
      else current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
      continue;
    }
    inToken = true;
    if (ch === "'" || ch === "\"") {
      quote = ch;
    } else if (ch === "\\") {
      if (i + 1 >= command.length) throw new UnparsableCommand(command, "trailing backslash");
      current += command[++i];
    } else {
      current += ch;
    }
  }
  if (quote !== null) throw new UnparsableCommand(command, `unterminated ${quote === "'" ? "single" : "double"} quote`);
  if (inToken) tokens.push(current);
  return tokens;
}

const USES_LINE = /^\s*(?:-\s+)?uses:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#\s*(.*?))?\s*$/;

function splitUses(uses) {
  if (uses.startsWith("./") || uses.startsWith("docker://")) return { action: uses, ref: null };
  const at = uses.lastIndexOf("@");
  return at < 0 ? { action: uses, ref: null } : { action: uses.slice(0, at), ref: uses.slice(at + 1) };
}

/**
 * Every `uses:` reference (job-level reusable workflows and steps) in document
 * order. `tagComment` is the trailing `# <tag>` text on the matching `uses:`
 * line of the raw file, or null when that line has no comment or is not found.
 * Job-level references have `index: null`.
 */
export function actionRefs(workflow, rawText = workflow?.rawText ?? "") {
  const usesLines = normalizeNewlines(rawText).split("\n").map((line) => {
    const match = USES_LINE.exec(line);
    return match ? { value: match[1] ?? match[2] ?? match[3], comment: match[4] ? match[4] : null } : null;
  });
  let cursor = 0;
  const commentFor = (uses) => {
    for (let i = cursor; i < usesLines.length; i += 1) {
      if (usesLines[i] && usesLines[i].value === uses) {
        cursor = i + 1;
        return usesLines[i].comment;
      }
    }
    return null;
  };
  const refs = [];
  for (const job of jobs(workflow)) {
    const jobUses = isMapping(job.definition) && typeof job.definition.uses === "string" ? job.definition.uses : undefined;
    if (jobUses !== undefined) {
      refs.push(Object.freeze({ jobId: job.id, index: null, name: null, uses: jobUses, ...splitUses(jobUses), tagComment: commentFor(jobUses) }));
    }
    for (const step of steps(job)) {
      if (step.uses === undefined) continue;
      refs.push(Object.freeze({ jobId: job.id, index: step.index, name: step.name ?? null, uses: step.uses, ...splitUses(step.uses), tagComment: commentFor(step.uses) }));
    }
  }
  return refs;
}
