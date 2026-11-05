// Pure classification of one regression-test run (Requirement 36.2; design
// part 8 §2.3 classifyRun). A run before the fix counts as evidence only when it
// fails because an assertion about the violated behavior does not hold; import
// errors, syntax errors, missing services and failed preparation are "invalid".
//
//   classifyRun({ runner, exitCode, reporterEvents, stderr, timedOut, prepareFailed })
//     → { outcome: "pass" | "assertion-failure" | "invalid", reason, failing: Array<{ name, code }> }
//
// runner:
//   "node-test"  node --test with scripts/lib/regression-reporter.mjs; reporterEvents are its JSON lines
//   "script"     a plain Node script (node:assert, no node:test); stderr is inspected
//   "python"     a Python script; the last traceback in stderr is inspected

export const OUTCOMES = Object.freeze(["pass", "assertion-failure", "invalid"]);

/** Error codes and names that mean the test could not run, not that an assertion failed. */
export const INVALID_CAUSE_CODES = Object.freeze(["ERR_MODULE_NOT_FOUND", "ERR_IMPORT_ATTRIBUTE_MISSING", "ERR_UNKNOWN_FILE_EXTENSION", "ECONNREFUSED", "ENOTFOUND", "ERR_REQUIRE_ESM"]);
export const INVALID_CAUSE_NAMES = Object.freeze(["SyntaxError", "HarnessPrerequisiteError", "ReferenceError"]);
const INVALID_TEXT = [/\bSyntaxError\b/, /\bERR_MODULE_NOT_FOUND\b/, /Cannot find module/, /\bERR_IMPORT_ATTRIBUTE_MISSING\b/, /\bHarnessPrerequisiteError\b/, /\bERR_UNKNOWN_FILE_EXTENSION\b/];
const PYTHON_INVALID = [/\bModuleNotFoundError\b/, /\bImportError\b/, /\bSyntaxError\b/, /\bIndentationError\b/];

function isAssertionCause(event) {
  return event.causeCode === "ERR_ASSERTION" || event.causeName === "AssertionError";
}

function invalidCause(event) {
  if (INVALID_CAUSE_CODES.includes(event.causeCode)) return event.causeCode;
  if (INVALID_CAUSE_NAMES.includes(event.causeName)) return event.causeName;
  return null;
}

function classifyNodeTest({ exitCode, reporterEvents = [] }) {
  const failures = reporterEvents.filter((event) => event?.type === "test:fail");
  // A subtest cancelled because its parent failed carries no information of its own.
  const relevant = failures.filter((event) => event.failureType !== "cancelledByParent");
  const failing = relevant.map((event) => ({ name: String(event.name ?? ""), code: event.causeCode ?? event.causeName ?? event.failureType ?? null }));
  if (exitCode === 0 && failures.length === 0) return { outcome: "pass", reason: "exit 0 and no test:fail event", failing };
  if (failures.length === 0) return { outcome: "invalid", reason: `exit ${exitCode} without any test:fail event`, failing };
  const hook = relevant.find((event) => event.failureType === "hookFailed");
  if (hook) return { outcome: "invalid", reason: `hook failed in ${hook.name} (preparation failure)`, failing };
  for (const event of relevant) {
    const cause = invalidCause(event);
    if (cause) return { outcome: "invalid", reason: `${event.name} failed with ${cause}`, failing };
  }
  const stderr = reporterEvents.filter((event) => event?.type === "test:stderr").map((event) => String(event.message ?? "")).join("");
  const assertions = relevant.filter(isAssertionCause);
  if (assertions.length === 0) {
    const hint = INVALID_TEXT.find((pattern) => pattern.test(stderr));
    return { outcome: "invalid", reason: hint ? `no ERR_ASSERTION failure; test stderr matches ${hint.source}` : "no test:fail event is caused by ERR_ASSERTION or AssertionError", failing };
  }
  const others = relevant.filter((event) => !isAssertionCause(event));
  const reason = others.length === 0 ? "every failing test failed with ERR_ASSERTION" : `ERR_ASSERTION in ${assertions.length} test(s); ${others.length} other failure(s) without an import, syntax or connection cause`;
  return { outcome: "assertion-failure", reason, failing };
}

const ERROR_HEADER = /^(?:Uncaught )?((?:[A-Za-z_$][\w$]*)?Error|[A-Za-z_$][\w$]*Exception)(?: \[([A-Z0-9_]+)\])?(?::|$)/;

/** The last uncaught-error block of stderr: from the last unindented header such as `AssertionError [ERR_ASSERTION]: …` to the end (indented headers belong to nested `actual`/`cause` values). */
export function lastErrorBlock(stderr) {
  const lines = String(stderr ?? "").split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) if (ERROR_HEADER.test(lines[index])) start = index;
  if (start < 0) return null;
  const header = ERROR_HEADER.exec(lines[start]);
  return { name: header[1], code: header[2] ?? null, text: lines.slice(start).join("\n"), headerLine: lines[start].trim() };
}

function classifyScript({ exitCode, stderr = "" }) {
  if (exitCode === 0) return { outcome: "pass", reason: "exit 0", failing: [] };
  const block = lastErrorBlock(stderr);
  if (!block) return { outcome: "invalid", reason: `exit ${exitCode} without an error block in stderr`, failing: [] };
  const failing = [{ name: block.headerLine.slice(0, 300), code: block.code ?? block.name, detail: block.text.slice(0, 2000) }];
  const marker = INVALID_TEXT.find((pattern) => pattern.test(block.text));
  if (marker) return { outcome: "invalid", reason: `last error block matches ${marker.source}`, failing };
  if (block.name === "AssertionError" || /code: 'ERR_ASSERTION'/.test(block.text)) return { outcome: "assertion-failure", reason: "last error block is an AssertionError", failing };
  return { outcome: "invalid", reason: `last error block is ${block.name}, not AssertionError`, failing };
}

function classifyPython({ exitCode, stderr = "" }) {
  if (exitCode === 0) return { outcome: "pass", reason: "exit 0", failing: [] };
  const text = String(stderr ?? "");
  const start = text.lastIndexOf("Traceback (most recent call last):");
  if (start < 0) return { outcome: "invalid", reason: `exit ${exitCode} without a Python traceback`, failing: [] };
  const traceback = text.slice(start);
  const last = traceback.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line && !line.startsWith(" ") && !line.startsWith("Traceback") && !/^\^+$/.test(line.trim())).pop() ?? "";
  const failing = [{ name: last.slice(0, 300), code: last.split(":")[0], detail: traceback.slice(-2000) }];
  const marker = PYTHON_INVALID.find((pattern) => pattern.test(traceback));
  if (marker) return { outcome: "invalid", reason: `traceback contains ${marker.source.replace(/\\b/g, "")}`, failing };
  if (/^AssertionError\b/.test(last)) return { outcome: "assertion-failure", reason: "traceback ends with AssertionError", failing };
  return { outcome: "invalid", reason: `traceback ends with ${failing[0].code || "an unknown error"}, not AssertionError`, failing };
}

/**
 * @param {{ runner: "node-test"|"script"|"python", exitCode: number|null, reporterEvents?: object[], stderr?: string, timedOut?: boolean, prepareFailed?: string|null, unavailable?: string|null }} run
 */
export function classifyRun(run) {
  if (run.unavailable) return { outcome: "invalid", reason: run.unavailable, failing: [] };
  if (run.prepareFailed) return { outcome: "invalid", reason: `preparation failed: ${run.prepareFailed}`, failing: [] };
  if (run.timedOut) return { outcome: "invalid", reason: "timed out", failing: [] };
  if (run.exitCode === null || run.exitCode === undefined) return { outcome: "invalid", reason: "process did not exit normally", failing: [] };
  switch (run.runner) {
    case "node-test":
      return classifyNodeTest(run);
    case "script":
      return classifyScript(run);
    case "python":
      return classifyPython(run);
    default:
      return { outcome: "invalid", reason: `unknown runner ${String(run.runner)}`, failing: [] };
  }
}

/**
 * Whether a failing case matches the registered assertion: a substring of a failing
 * node:test name, or of the error block / traceback of a plain script. null when
 * the entry has no assertion.
 */
export function assertionMatched(result, assertion) {
  if (!assertion) return null;
  return result.failing.some((item) => String(item.name ?? "").includes(assertion) || String(item.detail ?? "").includes(assertion));
}

/**
 * Expected outcome for a mode. fix: pass. parent: assertion-failure whose failing case
 * contains the entry's assertion; an entry without a pinned assertion never meets the
 * parent expectation, because an assertion failure elsewhere in the test (for example
 * in a baseline case) is not evidence about the issue (Requirement 36.2).
 */
export function meetsExpectation(mode, result, assertion) {
  if (mode === "fix") return result.outcome === "pass";
  return result.outcome === "assertion-failure" && assertionMatched(result, assertion) === true;
}
