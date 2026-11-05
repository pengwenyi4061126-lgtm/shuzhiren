// Behavioral tests for the Release_Workflow_Gate, scripts/check-release-workflow.mjs
// and scripts/lib/release-workflow-gate.mjs (Requirement 3.5-3.7, 13; audit H1).
// Every gate case runs the CLI in a child process on a variant of
// scripts/fixtures/release-workflow/pinned.yml (the compliant sample) written
// to a temporary directory and passed with --workflow. Each variant changes one
// place of the fixture and must produce violations of exactly one rule, with
// the expected job= and step= labels. The scanner of
// scripts/lib/shell-quote-scan.mjs is tested in-process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { expressionContexts, RULES } from "./lib/release-workflow-gate.mjs";
import { scanShellQuotes } from "./lib/shell-quote-scan.mjs";
// Runs the scripts/release-environment.mjs tests in the same `node --test`
// process until package.json has its own release:environment:test script.
import "./test-release-environment.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");
const gate = path.join(scriptsDir, "check-release-workflow.mjs");
const pinnedFixture = path.join(scriptsDir, "fixtures", "release-workflow", "pinned.yml");
const pinnedText = readFileSync(pinnedFixture, "utf8").replace(/\r\n?/g, "\n");

const REQUIRED_ACTIONS = ["docker/setup-buildx-action", "docker/login-action", "docker/build-push-action", "actions/upload-artifact", "actions/download-artifact"];
const NON_SHA_REFS = ["v4", "main", "3d3c42e"];

const tempDir = mkdtempSync(path.join(os.tmpdir(), "release-workflow-gate-"));
after(() => rmSync(tempDir, { recursive: true, force: true }));

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Parses `ERROR [<rule>] job=<id> step=<label>: <detail>` lines. */
function parseViolations(output) {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^ERROR \[([a-z-]+)\](?: job=(\S+))?(?: step=(.+?))?: (.*)$/.exec(line);
    return match ? [{ rule: match[1], jobId: match[2], step: match[3], detail: match[4], line }] : [];
  });
}

/** Runs the gate and returns its exit code, full output and parsed violations. */
function runGate(args = []) {
  const result = spawnSync(process.execPath, [gate, ...args], { cwd: repoRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  const output = `${result.stdout}${result.stderr}`;
  return { status: result.status, output, violations: parseViolations(output) };
}

let variantCounter = 0;
function writeVariant(text, name = "variant") {
  const file = path.join(tempDir, `${(variantCounter += 1)}-${name}.yml`);
  writeFileSync(file, text);
  return file;
}

function runVariant(text, name) {
  return runGate(["--workflow", writeVariant(text, name)]);
}

/** Replaces the only occurrence of `from`. */
function replaceOnce(text, from, to) {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0) throw new Error(`fixture must contain exactly one ${JSON.stringify(from)}`);
  return `${text.slice(0, at)}${to}${text.slice(at + from.length)}`;
}

/** Replaces the ref of the first `uses: <action>@…` line. */
function withRef(text, action, ref) {
  const pattern = new RegExp(`^(\\s*-\\s+uses:\\s*${escapeRegExp(action)})@[^\\s#]+`, "m");
  if (!pattern.test(text)) throw new Error(`fixture does not reference ${action}`);
  return text.replace(pattern, `$1@${ref}`);
}

/** Removes the whole step whose first line matches `firstLine` (the n-th match, 0-based). */
function withoutStep(text, firstLine, nth = 0) {
  const lines = text.split("\n");
  const starts = lines.map((line, index) => (firstLine.test(line) ? index : -1)).filter((index) => index >= 0);
  const start = starts[nth];
  if (start === undefined) throw new Error(`fixture has no step matching ${firstLine}`);
  const indent = lines[start].indexOf("-");
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || lines[end].search(/\S/) > indent)) end += 1;
  lines.splice(start, end - start);
  return lines.join("\n");
}

const actionStep = (action) => new RegExp(`^\\s*-\\s+uses:\\s*${escapeRegExp(action)}@`);

/** Asserts a failing run whose violations all belong to `rule`, with the expected labels of the first one. */
function assertOnly(result, rule, { jobId, step, detail, count } = {}, label = rule) {
  assert.equal(result.status, 1, `${label}\n${result.output}`);
  assert.ok(result.violations.length > 0, `${label}\n${result.output}`);
  assert.deepEqual([...new Set(result.violations.map((item) => item.rule))], [rule], `${label}\n${result.output}`);
  if (count !== undefined) assert.equal(result.violations.length, count, `${label}\n${result.output}`);
  const [first] = result.violations;
  if (jobId !== undefined) assert.equal(first.jobId, jobId, `${label}\n${result.output}`);
  if (step !== undefined) assert.equal(first.step, step, `${label}\n${result.output}`);
  if (detail !== undefined) assert.match(first.detail, detail, `${label}\n${result.output}`);
}

// Fixture anchors (each occurs exactly once in pinned.yml).
const MANIFEST_ISSUER = "--issuer \"$RELEASE_ISSUER\"";
const BUILD_ARGS_RUN = "run: node scripts/release-environment.mjs build-args --matrix-key \"$MATRIX_KEY\" --miniforge runtime/cosyvoice/miniforge.json";
const WRITE_RESULT_KEY = "--key \"$MATRIX_KEY\"";
const WRITE_RESULT_RUN = "run: >-\n          node scripts/write-release-image-result.mjs\n          --key \"$MATRIX_KEY\"\n          --digest \"$IMAGE_DIGEST\"\n          --output \"$RUNNER_TEMP/$MATRIX_KEY.json\"";
const BUILD_JOB_ENV = "    runs-on: ubuntu-24.04\n    environment: release-production\n";
const SIGN_JOB_ENV = "    runs-on: [self-hosted, linux, x64, shuzhiren-release]\n    environment: release-production\n";
const DISPATCH = "on:\n  workflow_dispatch: {}\n";
const MANIFEST_STEP = { jobId: "assemble-and-sign", step: "Create signed release manifest" };

test("passes on the compliant fixture and on the repository release workflow", () => {
  for (const args of [["--workflow", pinnedFixture], []]) {
    const result = runGate(args);
    assert.deepEqual(result.violations, [], result.output);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, new RegExp(`^PASS {2}release workflow gate \\(${RULES.length} rules\\)`, "m"));
  }
});

test("pinned-actions: a tag, a branch or a short SHA is one ACTION_REF violation naming the action and ref", () => {
  for (const action of [...REQUIRED_ACTIONS, "actions/checkout"]) {
    for (const ref of NON_SHA_REFS) {
      const result = runVariant(withRef(pinnedText, action, ref), `ref-${action.replace("/", "__")}-${ref}`);
      assertOnly(result, "pinned-actions", { count: 1, detail: new RegExp(`^ACTION_REF action=${escapeRegExp(action)} ref=${escapeRegExp(ref)}$`) }, `${action}@${ref}`);
      assert.ok(result.violations[0].jobId && result.violations[0].step, result.output);
    }
  }
});

test("pinned-actions: removing a required action is MISSING_ACTION", () => {
  for (const action of REQUIRED_ACTIONS) {
    const result = runVariant(withoutStep(pinnedText, actionStep(action)), `missing-${action.replace("/", "__")}`);
    assertOnly(result, "pinned-actions", { count: 1, detail: new RegExp(`^MISSING_ACTION ${escapeRegExp(action)}$`) }, action);
  }
});

test("dispatch-inputs: any workflow_dispatch input, used or not, is rejected", () => {
  for (const name of ["miniforge_url", "miniforge_sha256", "signing_key_path", "release_issuer", "release_key_id", "image_namespace", "registry"]) {
    const text = replaceOnce(pinnedText, DISPATCH, `on:\n  workflow_dispatch:\n    inputs:\n      ${name}:\n        type: string\n        required: true\n`);
    assertOnly(runVariant(text, `input-${name}`), "dispatch-inputs", { count: 1, detail: new RegExp(`input "${name}"`) }, name);
  }
  assertOnly(runVariant(replaceOnce(pinnedText, DISPATCH, "on:\n  workflow_dispatch:\n    inputs: {}\n"), "input-empty"), "dispatch-inputs", { count: 1 });
});

test("run-expression: any ${{ }} in run: is rejected whatever the context, spacing, case or block style", () => {
  const cases = [
    ["inputs-folded", MANIFEST_ISSUER, "--issuer \"${{ inputs.release_issuer }}\"", MANIFEST_STEP, /inputs \(workflow input or event payload\)/],
    ["event-inputs-folded", MANIFEST_ISSUER, "--issuer \"${{github.event.inputs.registry}}\"", MANIFEST_STEP, /github\.event/],
    ["event-index", MANIFEST_ISSUER, "--issuer \"${{ github['event'].inputs.registry }}\"", MANIFEST_STEP, /github\.event/],
    ["inputs-upper", MANIFEST_ISSUER, "--issuer \"${{ INPUTS.release_issuer }}\"", MANIFEST_STEP, /inputs/],
    ["inputs-index", MANIFEST_ISSUER, "--issuer \"${{ inputs['release_issuer'] }}\"", MANIFEST_STEP, /inputs/],
    ["inputs-function", MANIFEST_ISSUER, "--issuer \"${{ format('{0}', inputs.release_issuer) }}\"", MANIFEST_STEP, /inputs/],
    ["event-payload", MANIFEST_ISSUER, "--issuer \"${{ github.event.sender.login }}\"", MANIFEST_STEP, /github\.event/],
    ["vars", MANIFEST_ISSUER, "--issuer \"${{ vars.RELEASE_ISSUER }}\"", MANIFEST_STEP, /reading vars;/],
    ["secrets", MANIFEST_ISSUER, "--issuer \"${{ secrets.REGISTRY_PASSWORD }}\"", MANIFEST_STEP, /reading secrets;/],
    ["matrix", WRITE_RESULT_KEY, "--key \"${{ matrix.key }}\"", { jobId: "build-and-push", step: "Write image result" }, /reading other;/],
    ["single-line-inputs", WRITE_RESULT_RUN, "run: echo ${{ inputs.image_namespace }}", { jobId: "build-and-push", step: "Write image result" }, /inputs/],
    ["literal-block-vars", WRITE_RESULT_RUN, "run: |\n          echo \"${{ vars.RELEASE_REGISTRY }}\"", { jobId: "build-and-push", step: "Write image result" }, /vars/]
  ];
  for (const [name, from, to, labels, detail] of cases) {
    assertOnly(runVariant(replaceOnce(pinnedText, from, to), `run-${name}`), "run-expression", { count: 1, ...labels, detail }, name);
  }
});

test("run-expression: the word inputs outside an expression and ${{ }} in env: or with: are allowed", () => {
  const text = replaceOnce(pinnedText, MANIFEST_ISSUER, `${MANIFEST_ISSUER} --note inputs.registry --other 'github.event'`);
  const result = runVariant(text, "run-allowed");
  assert.deepEqual(result.violations, [], result.output);
  assert.equal(result.status, 0, result.output);
});

test("input-env-scope: workflow- or job-level env: reading inputs or github.event is rejected", () => {
  const workflowEnv = replaceOnce(pinnedText, "permissions:\n  contents: read\n\njobs:", "permissions:\n  contents: read\n\nenv:\n  RELEASE_NOTE: ${{ github.event.inputs.note }}\n\njobs:");
  assertOnly(runVariant(workflowEnv, "scope-workflow"), "input-env-scope", { count: 1, detail: /^workflow env RELEASE_NOTE/ });
  const jobEnv = replaceOnce(pinnedText, BUILD_JOB_ENV, `${BUILD_JOB_ENV}    env:\n      RELEASE_NOTE: \${{ inputs.note }}\n`);
  assertOnly(runVariant(jobEnv, "scope-job"), "input-env-scope", { count: 1, jobId: "build-and-push", detail: /^job env RELEASE_NOTE/ });
});

test("env-quote: an env: variable mapped from ${{ }} read outside double quotes is rejected", () => {
  for (const [name, to] of [["bare", "--key $MATRIX_KEY"], ["braces", "--key ${MATRIX_KEY}"], ["single-quoted", "--key '$MATRIX_KEY'x\"$MATRIX_KEY\" --k2 $MATRIX_KEY"], ["substitution", "--key \"$(printf %s $MATRIX_KEY)\""]]) {
    assertOnly(runVariant(replaceOnce(pinnedText, WRITE_RESULT_KEY, to), `quote-${name}`), "env-quote", { count: 1, jobId: "build-and-push", step: "Write image result", detail: /\$MATRIX_KEY outside double quotes/ }, name);
  }
  // Runner-provided variables (not mapped from ${{ }}) and quoted references pass.
  const ok = replaceOnce(pinnedText, WRITE_RESULT_KEY, "--key \"${MATRIX_KEY}\" --sha $GITHUB_SHA --both \"$(printf %s \"$MATRIX_KEY\")\"");
  const result = runVariant(ok, "quote-ok");
  assert.deepEqual(result.violations, [], result.output);
});

test("run-shell-syntax: backtick substitution and heredocs are rejected", () => {
  for (const [name, to, kind] of [["backtick", "--key \"$MATRIX_KEY\" --uid `id -u`", /backtick/], ["heredoc", "--key \"$MATRIX_KEY\" <<EOF", /heredoc/]]) {
    assertOnly(runVariant(replaceOnce(pinnedText, WRITE_RESULT_KEY, to), `syntax-${name}`), "run-shell-syntax", { count: 1, jobId: "build-and-push", step: "Write image result", detail: kind }, name);
  }
  const hereString = runVariant(replaceOnce(pinnedText, WRITE_RESULT_KEY, `${WRITE_RESULT_KEY} <<< "x"`), "syntax-here-string");
  assert.deepEqual(hereString.violations, [], hereString.output);
});

test("registry-source: login and tags must use vars.RELEASE_REGISTRY", () => {
  const login = replaceOnce(pinnedText, "          registry: ${{ vars.RELEASE_REGISTRY }}\n", "          registry: ${{ inputs.registry }}\n");
  assertOnly(runVariant(login, "registry-login-input"), "registry-source", { count: 1, jobId: "build-and-push", step: "#4", detail: /with\.registry must be exactly/ });
  const literal = replaceOnce(pinnedText, "          registry: ${{ vars.RELEASE_REGISTRY }}\n", "          registry: docker.io\n");
  assertOnly(runVariant(literal, "registry-login-literal"), "registry-source", { count: 1 });
  const tags = replaceOnce(pinnedText, "tags: ${{ vars.RELEASE_REGISTRY }}/", "tags: docker.io/");
  assertOnly(runVariant(tags, "registry-tags"), "registry-source", { count: 1, detail: /every docker\/build-push-action tag/ });
});

test("registry-validation: validate-registry must run unconditionally before the first registry use", () => {
  const validateStep = /^\s*- name: Validate release registry$/;
  assertOnly(runVariant(withoutStep(pinnedText, validateStep, 0), "validation-missing-build"), "registry-validation", { count: 1, jobId: "build-and-push" });
  assertOnly(runVariant(withoutStep(pinnedText, validateStep, 1), "validation-missing-sign"), "registry-validation", { count: 1, jobId: "assemble-and-sign" });
  const conditional = pinnedText.replace("        id: validate-registry\n", "        id: validate-registry\n        continue-on-error: true\n");
  assertOnly(runVariant(conditional, "validation-continue"), "registry-validation", { count: 1, jobId: "build-and-push", step: "Validate release registry" });
  const otherCommand = pinnedText.replace("run: node scripts/release-environment.mjs registry --allowlist .github/release-registry-allowlist.json", "run: echo skip");
  assertOnly(runVariant(otherCommand, "validation-command"), "registry-validation", { count: 1, jobId: "build-and-push" });
  const loginIf = replaceOnce(pinnedText, "      - uses: docker/login-action@e0e1e2e3e4e5e6e7e8e9f0f1f2f3f4f5f6f7f8f9\n", "      - uses: docker/login-action@e0e1e2e3e4e5e6e7e8e9f0f1f2f3f4f5f6f7f8f9\n        if: always()\n");
  assertOnly(runVariant(loginIf, "validation-login-if"), "registry-validation", { count: 1, detail: /docker\/login-action must not have if:/ });
});

test("release-vars-source: signing values from vars validated first; build arguments from the Miniforge pin", () => {
  assertOnly(runVariant(withoutStep(pinnedText, /^\s*- name: Validate signing configuration$/), "vars-no-signing"), "release-vars-source", { count: 1, jobId: "assemble-and-sign", detail: /validate-signing must run before/ });
  const literal = pinnedText.replace("          RELEASE_KEY_ID: ${{ vars.RELEASE_KEY_ID }}\n        run: >-", "          RELEASE_KEY_ID: release-2026-01\n        run: >-");
  assertOnly(runVariant(literal, "vars-literal-key-id"), "release-vars-source", { count: 1, ...MANIFEST_STEP, detail: /RELEASE_KEY_ID/ });
  const miniforgeEnv = replaceOnce(pinnedText, "          MATRIX_KEY: ${{ matrix.key }}\n        run: node scripts/release-environment.mjs build-args", "          MATRIX_KEY: ${{ matrix.key }}\n          MINIFORGE_URL: ${{ vars.MINIFORGE_URL }}\n        run: node scripts/release-environment.mjs build-args");
  assertOnly(runVariant(miniforgeEnv, "vars-miniforge-env"), "release-vars-source", { count: 1, jobId: "build-and-push", step: "#5", detail: /must not take Miniforge values from env:/ });
  const noPin = replaceOnce(pinnedText, BUILD_ARGS_RUN, "run: node scripts/release-environment.mjs build-args --matrix-key \"$MATRIX_KEY\"");
  assertOnly(runVariant(noPin, "vars-no-pin"), "release-vars-source", { count: 1, step: "#5" });
  const directArgs = replaceOnce(pinnedText, "build-args: ${{ steps.build-args.outputs.value }}", "build-args: MINIFORGE_URL=https://example.com/x.sh");
  assertOnly(runVariant(directArgs, "vars-direct-build-args"), "release-vars-source", { count: 1, detail: /build-args must be/ });
});

test("credentials-environment: both jobs must declare environment: release-production", () => {
  assertOnly(runVariant(replaceOnce(pinnedText, BUILD_JOB_ENV, "    runs-on: ubuntu-24.04\n"), "env-missing-build"), "credentials-environment", { count: 1, jobId: "build-and-push" });
  assertOnly(runVariant(replaceOnce(pinnedText, SIGN_JOB_ENV, "    runs-on: [self-hosted, linux, x64, shuzhiren-release]\n"), "env-missing-sign"), "credentials-environment", { count: 1, jobId: "assemble-and-sign" });
  assertOnly(runVariant(replaceOnce(pinnedText, BUILD_JOB_ENV, "    runs-on: ubuntu-24.04\n    environment: staging\n"), "env-other"), "credentials-environment", { count: 1, jobId: "build-and-push" });
  const mapping = replaceOnce(pinnedText, BUILD_JOB_ENV, "    runs-on: ubuntu-24.04\n    environment:\n      name: release-production\n");
  assert.deepEqual(runVariant(mapping, "env-mapping").violations, []);
});

test("allowlist-format: a malformed allowlist file is rejected", () => {
  for (const [name, text] of [["empty", '{"schemaVersion":1,"registries":[]}'], ["scheme", '{"schemaVersion":1,"registries":["https://ghcr.io"]}'], ["upper", '{"schemaVersion":1,"registries":["GHCR.IO"]}'], ["not-json", "ghcr.io"]]) {
    const file = path.join(tempDir, `allowlist-${name}.json`);
    writeFileSync(file, text);
    assertOnly(runGate(["--workflow", pinnedFixture, "--allowlist", file]), "allowlist-format", { count: 1 }, name);
  }
});

test("release-structure: protected refs, ten images and persist-credentials: false are kept", () => {
  assertOnly(runVariant(replaceOnce(pinnedText, "          - key: COSYVOICE_IMAGE\n", ""), "structure-nine"), "release-structure", { count: 1, jobId: "build-and-push" });
  assertOnly(runVariant(pinnedText.replace("    if: github.ref_protected\n    needs: build-and-push", "    needs: build-and-push"), "structure-unprotected"), "release-structure", { count: 1, jobId: "assemble-and-sign" });
  assertOnly(runVariant(pinnedText.replace("          persist-credentials: false\n", "          persist-credentials: true\n"), "structure-credentials"), "release-structure", { count: 1, jobId: "build-and-push" });
});

test("yaml-parse: an unparsable workflow or one without jobs exits 1; an unreadable file exits 2", () => {
  assertOnly(runVariant("on: [\n", "yaml-broken"), "yaml-parse", { count: 1 });
  assertOnly(runVariant("name: x\non:\n  workflow_dispatch: {}\n", "yaml-no-jobs"), "yaml-parse", { count: 1, detail: /no jobs mapping/ });
  assertOnly(runVariant(`${pinnedText}\nname: duplicate\n`, "yaml-duplicate-key"), "yaml-parse", { count: 1 });
  const missing = runGate(["--workflow", path.join(tempDir, "does-not-exist.yml")]);
  assert.equal(missing.status, 2, missing.output);
  assert.match(missing.output, /^ERROR source=.*does-not-exist\.yml reason=cannot read file/m);
  const usage = runGate(["--workflow"]);
  assert.equal(usage.status, 2, usage.output);
});

test("expressionContexts names the contexts of every ${{ }} expression", () => {
  assert.deepEqual(expressionContexts("echo ${{ inputs.a }} ${{ vars.B }}"), ["inputs", "vars"]);
  assert.deepEqual(expressionContexts("${{ github['event'].x }}"), ["github.event"]);
  assert.deepEqual(expressionContexts("${{ matrix.key }}"), ["other"]);
  assert.deepEqual(expressionContexts("${{ secrets.X"), ["secrets"]);
  assert.deepEqual(expressionContexts("inputs.registry"), []);
  assert.deepEqual(expressionContexts("${{ my_inputs.x }}"), ["other"]);
});

test("shell-quote-scan: references are classified as quoted or unquoted", () => {
  const quotedOf = (script) => scanShellQuotes(script).refs.map(({ name, quoted }) => [name, quoted]);
  assert.deepEqual(quotedOf('"$A"'), [["A", true]]);
  assert.deepEqual(quotedOf('"${A}"'), [["A", true]]);
  assert.deepEqual(quotedOf('"$RESULT_DIR/$MATRIX_KEY.json"'), [["RESULT_DIR", true], ["MATRIX_KEY", true]]);
  assert.deepEqual(quotedOf('"$(cmd "$A")"'), [["A", true]]);
  assert.deepEqual(quotedOf("$A"), [["A", false]]);
  assert.deepEqual(quotedOf("${A}"), [["A", false]]);
  assert.deepEqual(quotedOf("$(cmd $A)"), [["A", false]]);
  assert.deepEqual(quotedOf('"$(cmd $A)"'), [["A", false]]);
  assert.deepEqual(quotedOf("'$A'"), []);
  assert.deepEqual(quotedOf("\\$A"), []);
  assert.deepEqual(quotedOf("echo x # $A\necho \"$B\""), [["B", true]]);
  assert.deepEqual(quotedOf("echo x#$A"), [["A", false]]);
  assert.deepEqual(quotedOf('"${A:-$B}"'), [["A", true]]);
  assert.deepEqual(scanShellQuotes("echo `id`").unsupported.map(({ kind }) => kind), ["backtick", "backtick"]);
  assert.deepEqual(scanShellQuotes("cat <<EOF").unsupported.map(({ kind }) => kind), ["heredoc"]);
  assert.deepEqual(scanShellQuotes('cat <<< "$A"').unsupported, []);
  assert.deepEqual(scanShellQuotes('echo "<<EOF"').unsupported, []);
});

test("shell-quote-scan: 2000 random scripts agree with the segment reference", () => {
  // Each segment has a known classification; joining segments with separators
  // does not change it, so the concatenation is its own reference result.
  const segments = [
    ['"$A"', [["A", true]]],
    ["$B", [["B", false]]],
    ["'$C'", []],
    ['"x ${D} y"', [["D", true]]],
    ["${E}", [["E", false]]],
    ['"$(cmd "$F")"', [["F", true]]],
    ["$(cmd $G)", [["G", false]]],
    ['"$(cmd $H)"', [["H", false]]],
    ["\\$I", []],
    ['"\\"$J\\""', [["J", true]]],
    ["--flag=\"$K\"", [["K", true]]],
    ["'a \"$L\" b'", []],
    ["$((1 + 2))", []],
    ['"$(printf "%s" "$(echo $M)")"', [["M", false]]],
    ['plain-word', []],
    ['"$N"x$O', [["N", true], ["O", false]]]
  ];
  const separators = [" ", "; ", " && ", "\n", " | "];
  let seed = 49;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let n = 0; n < 2000; n += 1) {
    const count = 1 + (next() % 6);
    let script = "echo";
    const expected = [];
    for (let k = 0; k < count; k += 1) {
      const [text, refs] = segments[next() % segments.length];
      script += `${separators[next() % separators.length]}echo ${text}`;
      expected.push(...refs);
    }
    const actual = scanShellQuotes(script).refs.map(({ name, quoted }) => [name, quoted]);
    assert.deepEqual(actual, expected, script);
  }
});
