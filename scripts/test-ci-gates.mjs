// Behavioral tests for the CI gate libraries and the Local_Verification check
// list. Every assertion is about values returned or errors thrown by the code
// under test; inputs come from scripts/fixtures/ci-gates/ or inline text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { actionRefs, commands, jobs, loadWorkflow, parseWorkflow, steps, tokenize, UnparsableCommand, WorkflowLoadError } from "./lib/workflow-model.mjs";
import { InvalidInterpolation, interpolate, MissingRequiredVariable, parseEnvFile, parseInterpolations, resolveComposeEnvFiles, UnsupportedEnvSyntax } from "./lib/compose-interpolation.mjs";
import { CHECK_LABELS, covers, describeCommand, expandGlob, LOCAL_CHECKS, localChecks, validateLocalChecks } from "./verify-local-checks.mjs";
import { CI_ONLY_STEPS, GATEWAY_NOT_ENABLED, notRunCiSteps, UNREGISTERED_REASON, validateCiOnlySteps } from "./ci-required-steps.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "ci-gates", "lib");
const fixture = (...parts) => path.join(fixtures, ...parts);

test("tokenize splits words like a POSIX shell", () => {
  assert.deepEqual(tokenize("npm run deploy:check -- --allow-placeholders"), ["npm", "run", "deploy:check", "--", "--allow-placeholders"]);
  assert.deepEqual(tokenize("  a   b\tc  "), ["a", "b", "c"]);
  assert.deepEqual(tokenize("echo 'a b' \"c d\""), ["echo", "a b", "c d"]);
  assert.deepEqual(tokenize("x\"a\\\"b\"y"), ["xa\"by"]);
  assert.deepEqual(tokenize("'single \\ stays'"), ["single \\ stays"]);
  assert.deepEqual(tokenize("a\\ b"), ["a b"]);
  assert.deepEqual(tokenize("run \"\""), ["run", ""]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("a && b | c"), ["a", "&&", "b", "|", "c"]);
});

test("tokenize rejects unterminated quotes and a trailing backslash", () => {
  for (const command of ["echo 'oops", "echo \"oops", "trailing\\"]) {
    assert.throws(() => tokenize(command), (error) => error instanceof UnparsableCommand && error.command === command);
  }
});

test("loadWorkflow reads jobs and steps with every scalar kept as a string", () => {
  const workflow = loadWorkflow(fixture("workflow.yml"));
  assert.deepEqual(jobs(workflow).map((job) => job.id), ["unit", "docker"]);
  const [unit, docker] = jobs(workflow);
  const unitSteps = steps(unit);
  assert.deepEqual(unitSteps.map((step) => [step.jobId, step.index, step.isPreparation]), [
    ["unit", 0, true], ["unit", 1, true], ["unit", 2, true], ["unit", 3, true], ["unit", 4, false], ["unit", 5, false], ["unit", 6, true]
  ]);
  assert.equal(unitSteps[0].name, "Checkout");
  assert.equal(unitSteps[0].uses, "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  assert.deepEqual(unitSteps[0].with, { submodules: "recursive" });
  assert.equal(unitSteps[1].with["node-version"], "24");
  assert.equal(unitSteps[5].raw["continue-on-error"], "true");
  assert.equal(unit.definition["timeout-minutes"], "30");
  assert.equal(docker.definition.env.SHA, "0123456789");
  const dockerSteps = steps(docker);
  assert.equal(dockerSteps[1].isPreparation, false, "only a bare `npm ci` is a preparation step");
});

test("commands splits run blocks into normalized lines", () => {
  const [unit] = jobs(loadWorkflow(fixture("workflow.yml")));
  const unitSteps = steps(unit);
  assert.deepEqual(commands(unitSteps[4]), ["npm run deploy:check -- --allow-placeholders"]);
  assert.deepEqual(commands(unitSteps[5]), ["echo one two", "docker build --file a/Dockerfile ."]);
  assert.deepEqual(commands(unitSteps[0]), []);
});

test("actionRefs returns every uses reference with its trailing tag comment", () => {
  const workflow = loadWorkflow(fixture("workflow.yml"));
  assert.deepEqual(actionRefs(workflow).map(({ jobId, index, name, action, ref, tagComment }) => ({ jobId, index, name, action, ref, tagComment })), [
    { jobId: "unit", index: 0, name: "Checkout", action: "actions/checkout", ref: "3d3c42e5aac5ba805825da76410c181273ba90b1", tagComment: "v7.0.1" },
    { jobId: "unit", index: 1, name: null, action: "actions/setup-node", ref: "949feb2413d6458794dcd2491c4babbbce0c15c1", tagComment: "v7.1.0" },
    { jobId: "unit", index: 6, name: null, action: "./.github/actions/local", ref: null, tagComment: null },
    { jobId: "docker", index: 0, name: null, action: "docker/login-action", ref: "v3", tagComment: null }
  ]);
});

test("parseWorkflow gives the same model for CRLF and LF text", () => {
  const lf = readFileSync(fixture("workflow.yml"), "utf8").replace(/\r\n/g, "\n");
  const fromLf = parseWorkflow(lf, "lf.yml");
  const fromCrlf = parseWorkflow(lf.replace(/\n/g, "\r\n"), "crlf.yml");
  assert.equal(fromCrlf.rawText, fromLf.rawText);
  assert.deepEqual(fromCrlf.doc, fromLf.doc);
  assert.deepEqual(jobs(fromCrlf).flatMap((job) => steps(job).map(commands)), jobs(fromLf).flatMap((job) => steps(job).map(commands)));
  assert.deepEqual(actionRefs(fromCrlf), actionRefs(fromLf));
});

test("workflow load failures raise WorkflowLoadError", () => {
  const missing = fixture("does-not-exist.yml");
  assert.throws(() => loadWorkflow(missing), (error) => error instanceof WorkflowLoadError && error.file === missing);
  assert.throws(() => parseWorkflow("jobs:\n  a: {}\n  a: {}\n", "dup.yml"), (error) => error instanceof WorkflowLoadError && error.file === "dup.yml");
  assert.throws(() => parseWorkflow("- not\n- a mapping\n", "list.yml"), WorkflowLoadError);
  assert.throws(() => parseWorkflow("jobs: [unclosed\n", "broken.yml"), WorkflowLoadError);
});

test("parseEnvFile reads KEY=VALUE, comments, blank lines and quoted values", () => {
  const values = parseEnvFile(readFileSync(fixture("env", "sample.env"), "utf8"), "sample.env");
  assert.deepEqual(Object.fromEntries(values), {
    EMPTY: "",
    PLAIN: "value",
    TRIMMED: "padded value",
    INLINE: "value",
    HASH_IN_VALUE: "https://example.com/#fragment",
    JSON: "[{\"id\":\"a\",\"url\":\"https://x.example/#y\"}]",
    SINGLE: "literal $HOME \\n",
    DOUBLE: "line\nnext \"quoted\" $5",
    QUOTED_COMMENT: "value",
    DUP: "second",
    INDENTED: "yes"
  });
  assert.deepEqual(parseEnvFile("A=1\r\nB=  two  \r\n", "crlf.env"), new Map([["A", "1"], ["B", "two"]]));
});

test("parseEnvFile raises UnsupportedEnvSyntax with the file and line", () => {
  assert.throws(() => parseEnvFile(readFileSync(fixture("env", "multiline.env"), "utf8"), "multiline.env"), (error) => error instanceof UnsupportedEnvSyntax && error.file === "multiline.env" && error.line === 3);
  const cases = [
    ["export A=1", 1],
    ["OK=1\nA = 1", 2],
    ["NO_EQUALS", 1],
    ["A=${B}", 1],
    ["A=\"$B\"", 1],
    ["A=\"x\" trailing", 1],
    ["A='unterminated", 1]
  ];
  for (const [text, line] of cases) {
    assert.throws(() => parseEnvFile(text, "inline.env"), (error) => error instanceof UnsupportedEnvSyntax && error.line === line, text);
  }
});

test("interpolate follows compose substitution rules", () => {
  const env = { SET: "v", EMPTY: "" };
  const cases = [
    ["${SET}", "v"], ["$SET/x", "v/x"], ["${UNSET}", ""],
    ["${SET:-d}", "v"], ["${EMPTY:-d}", "d"], ["${UNSET:-d}", "d"],
    ["${SET-d}", "v"], ["${EMPTY-d}", ""], ["${UNSET-d}", "d"],
    ["${SET:?m}", "v"], ["${EMPTY?m}", ""],
    ["${SET:+alt}", "alt"], ["${EMPTY:+alt}", ""], ["${EMPTY+alt}", "alt"], ["${UNSET+alt}", ""],
    ["$$", "$"], ["$${SET}", "${SET}"], ["cost $$5", "cost $5"],
    ["${UNSET:-${SET}/x}", "v/x"], ["${UNSET:-${ALSO_UNSET:-deep}}", "deep"],
    ["${SET:-${UNSET:?never evaluated}}", "v"], ["${X:--50}", "-50"]
  ];
  for (const [template, expected] of cases) assert.equal(interpolate(template, env), expected, template);
  assert.equal(interpolate("${A}", new Map([["A", "1"]])), "1");
});

test("interpolate raises MissingRequiredVariable and InvalidInterpolation", () => {
  const env = { EMPTY: "" };
  for (const [template, variable, message] of [["${EMPTY:?m}", "EMPTY", "m"], ["${UNSET:?need it}", "UNSET", "need it"], ["${UNSET?m}", "UNSET", "m"], ["${UNSET:-${INNER:?inner}}", "INNER", "inner"]]) {
    assert.throws(() => interpolate(template, env), (error) => error instanceof MissingRequiredVariable && error.variable === variable && error.requiredMessage === message, template);
  }
  for (const template of ["${UNTERMINATED", "$ alone", "${1BAD}", "${A:x}", "${}"]) {
    assert.throws(() => interpolate(template, env), InvalidInterpolation, template);
  }
});

test("parseInterpolations returns references in order, including nested ones", () => {
  const references = parseInterpolations("a $$ $${SKIP} ${A} $B ${C:-${D:-x}} ${E:?msg} ${F:+y} ${G+z} ${X:--50} ${H-}");
  assert.deepEqual(references.map(({ name, operator, argument }) => ({ name, operator, argument })), [
    { name: "A", operator: null, argument: null },
    { name: "B", operator: null, argument: null },
    { name: "C", operator: ":-", argument: "${D:-x}" },
    { name: "D", operator: ":-", argument: "x" },
    { name: "E", operator: ":?", argument: "msg" },
    { name: "F", operator: ":+", argument: "y" },
    { name: "G", operator: "+", argument: "z" },
    { name: "X", operator: ":-", argument: "-50" },
    { name: "H", operator: "-", argument: "" }
  ]);
  assert.deepEqual(parseInterpolations("no references, only $$ escapes"), []);
});

test("resolveComposeEnvFiles applies shell > later env file > earlier env file > default", () => {
  const composeFile = fixture("compose", "infra", "compose", "compose.yml");
  const composeDir = path.dirname(composeFile);
  const base = fixture("compose", "config", "base.env");
  const override = fixture("compose", "config", "override.env");
  const summarize = (results) => results.map(({ service, entry, value, resolvedPath, required }) => ({ service, entry, value, resolvedPath, required }));

  assert.deepEqual(summarize(resolveComposeEnvFiles({ composeFile, envFiles: [base] })), [
    { service: "control-plane", entry: "${CONTROL_PLANE_ENV_FILE:?set CONTROL_PLANE_ENV_FILE}", value: "/srv/shuzhiren/control.env", resolvedPath: "/srv/shuzhiren/control.env", required: true },
    { service: "migrate", entry: "${APP_ENV_FILE:-../../config/default-app.env}", value: "../../config/base-app.env", resolvedPath: path.resolve(composeDir, "../../config/base-app.env"), required: true },
    { service: "worker", entry: "/srv/shuzhiren/worker.env", value: "/srv/shuzhiren/worker.env", resolvedPath: "/srv/shuzhiren/worker.env", required: false },
    { service: "worker", entry: "./relative.env", value: "./relative.env", resolvedPath: path.resolve(composeDir, "relative.env"), required: true }
  ]);

  const later = resolveComposeEnvFiles({ composeFile, envFiles: [base, override] });
  assert.equal(later.find((item) => item.service === "migrate").value, "../../config/override-app.env");

  const shell = resolveComposeEnvFiles({ composeFile, envFiles: [base, override], shellEnv: { CONTROL_PLANE_ENV_FILE: "../../config/control-plane.example.env", APP_ENV_FILE: "../../config/shell-app.env" } });
  assert.equal(shell[0].resolvedPath, path.resolve(composeDir, "../../config/control-plane.example.env"));
  assert.equal(shell[0].resolvedPath, fixture("compose", "config", "control-plane.example.env"));
  assert.equal(shell[1].value, "../../config/shell-app.env");

  const defaults = resolveComposeEnvFiles({ composeFile, shellEnv: new Map([["CONTROL_PLANE_ENV_FILE", "x.env"]]) });
  assert.equal(defaults[1].value, "../../config/default-app.env");

  assert.throws(() => resolveComposeEnvFiles({ composeFile }), (error) => error instanceof MissingRequiredVariable && error.variable === "CONTROL_PLANE_ENV_FILE" && error.service === "control-plane");
  assert.throws(() => resolveComposeEnvFiles({ composeFile, envFiles: [fixture("env", "multiline.env")] }), UnsupportedEnvSyntax);
});

test("every Local_Verification check has exactly one valid label and a unique id", () => {
  assert.ok(LOCAL_CHECKS.length > 0);
  const ids = LOCAL_CHECKS.map((check) => check.id);
  assert.equal(new Set(ids).size, ids.length, "check ids must be unique");
  for (const check of LOCAL_CHECKS) {
    assert.ok(CHECK_LABELS.includes(check.label), `${check.id} has label ${check.label}`);
    if (check.kind === "node-check" || check.kind === "py-compile") assert.equal(check.label, "static", check.id);
  }
  assert.deepEqual(validateLocalChecks(LOCAL_CHECKS), []);
  assert.ok(LOCAL_CHECKS.every((check) => Boolean(check.gatewayOnly) === (check.kind === "python" || check.kind === "py-compile")));
  assert.deepEqual(localChecks(), LOCAL_CHECKS.filter((check) => !check.gatewayOnly));
  assert.deepEqual(localChecks({ withGateway: true }), [...LOCAL_CHECKS]);
});

test("every CI-only step has a job, command, reason and exactly one valid label", () => {
  for (const step of CI_ONLY_STEPS) assert.ok(CHECK_LABELS.includes(step.label), `${step.job} ${step.command}`);
  assert.deepEqual(validateCiOnlySteps(CI_ONLY_STEPS), []);
});

test("check list validation reports bad labels, ids and kind fields", () => {
  const good = { id: "a", kind: "npm", script: "a", label: "static" };
  const problems = validateLocalChecks([
    good,
    { ...good },
    { id: "b", kind: "npm", script: "b" },
    { id: "c", kind: "npm", script: "c", label: "unit" },
    { id: "d", kind: "node-check", entry: "x.mjs", label: "behavioral" },
    { id: "e", kind: "python", file: "e.py", label: "behavioral" },
    { id: "", kind: "npm", script: "f", label: "static" },
    { id: "g", kind: "shell", label: "static" }
  ]);
  assert.deepEqual(problems.map((problem) => problem.split(" ")[0]), [
    "LOCAL_CHECKS[1]", "LOCAL_CHECKS[2]", "LOCAL_CHECKS[3]", "LOCAL_CHECKS[4]", "LOCAL_CHECKS[5]", "LOCAL_CHECKS[6]", "LOCAL_CHECKS[7]"
  ]);
  assert.deepEqual(validateLocalChecks([]), ["LOCAL_CHECKS is empty"]);
  const stepProblems = validateCiOnlySteps([
    { job: "j", command: "x", localReason: "r", label: "static" },
    { job: "j", command: "x", localReason: "r", label: "static" },
    { job: "j", command: "y", localReason: "", label: "static" },
    { job: "j", command: "z", localReason: "r", label: "both" }
  ]);
  assert.deepEqual(stepProblems.map((problem) => problem.split(" ")[0]), ["CI_ONLY_STEPS[1]", "CI_ONLY_STEPS[2]", "CI_ONLY_STEPS[3]"]);
});

test("describeCommand produces the RUN line command text", () => {
  assert.equal(describeCommand({ kind: "npm", script: "deploy:check", args: ["--", "--allow-placeholders"] }), "npm run deploy:check -- --allow-placeholders");
  assert.equal(describeCommand({ kind: "node-check", entry: "apps/a/index.mjs" }), "node --check apps/a/index.mjs");
  assert.equal(describeCommand({ kind: "python", file: "scripts/t.py" }, { python: "/opt/py/bin/python" }), "/opt/py/bin/python scripts/t.py");
  assert.equal(describeCommand({ kind: "py-compile", files: ["a.py", "b.py"] }), "python -m py_compile a.py b.py");
});

test("covers and expandGlob decide which CI commands cover which checks", () => {
  const scripts = { "drill:test": "bash scripts/drill.sh", "py:test": "node scripts/run-python-test.mjs scripts/t.py" };
  const npmCheck = { kind: "npm", script: "deploy:check", args: ["--", "--allow-placeholders"] };
  assert.equal(covers("npm run deploy:check -- --allow-placeholders", npmCheck), true);
  assert.equal(covers("npm run deploy:check", npmCheck), false);
  assert.equal(covers("bash scripts/drill.sh", { kind: "npm", script: "drill:test" }, { scripts }), true);
  assert.equal(covers("bash scripts/drill.sh --extra", { kind: "npm", script: "drill:test" }, { scripts }), false);
  assert.equal(covers("node --check apps/a.mjs", { kind: "node-check", entry: "apps/a.mjs" }), true);
  assert.equal(covers("python3 scripts/t.py", { kind: "python", file: "scripts/t.py" }), true);
  assert.equal(covers("npm run py:test", { kind: "python", file: "scripts/t.py" }, { scripts }), true);
  assert.equal(covers("npm run py:test", { kind: "python", file: "scripts/other.py" }, { scripts }), false);
  assert.equal(covers("echo 'unterminated", npmCheck), false);
  assert.deepEqual(expandGlob("compose/config/*.env", fixtures), ["compose/config/base.env", "compose/config/override.env"]);
  assert.deepEqual(expandGlob("compose/config/*.missing", fixtures), []);
  const compileCheck = { kind: "py-compile", files: ["compose/config/base.env", "env/sample.env"] };
  assert.equal(covers("python3 -m py_compile compose/config/*.env env/sample.env", compileCheck, { root: fixtures }), true);
  assert.equal(covers("python3 -m py_compile compose/config/*.env", compileCheck, { root: fixtures }), false);
});

test("notRunCiSteps lists uncovered CI verification steps with their reasons", () => {
  const workflow = parseWorkflow([
    "jobs:",
    "  unit:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "      - run: npm ci",
    "      - run: npm run a:test",
    "      - run: bash -n scripts/x.sh",
    "      - run: python3 scripts/test-x.py",
    "      - run: docker build .",
    "  other:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - run: bash -n scripts/x.sh",
    ""
  ].join("\n"), "inline.yml");
  const executed = [{ id: "a:test", kind: "npm", script: "a:test", label: "behavioral" }];
  const skipped = [{ id: "scripts/test-x.py", kind: "python", file: "scripts/test-x.py", label: "behavioral", gatewayOnly: true }];
  const ciOnlySteps = [{ job: "unit", command: "bash -n scripts/x.sh", localReason: "reason-x", label: "static" }];
  assert.deepEqual(notRunCiSteps({ workflow, executedChecks: executed, skippedChecks: skipped, ciOnlySteps }), [
    { job: "unit", index: 3, command: "bash -n scripts/x.sh", reason: "reason-x" },
    { job: "unit", index: 4, command: "python3 scripts/test-x.py", reason: GATEWAY_NOT_ENABLED },
    { job: "unit", index: 5, command: "docker build .", reason: UNREGISTERED_REASON },
    { job: "other", index: 0, command: "bash -n scripts/x.sh", reason: UNREGISTERED_REASON }
  ]);
  assert.deepEqual(notRunCiSteps({ workflow, executedChecks: [...executed, ...skipped], ciOnlySteps }).map((step) => step.index), [3, 5, 0]);
});
