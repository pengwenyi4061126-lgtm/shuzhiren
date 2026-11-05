// Requirement 1.4: the PostgreSQL CI steps fail instead of skipping when the
// database is not configured or not reachable, and control-plane:integration
// fails unless RUN_CONTROL_PLANE_INTEGRATION_TESTS is exactly "true". Each
// case runs the same `npm run …` command as ci.yml in a child process whose
// environment has DATABASE_URL and every PG* variable removed, and asserts on
// the exit status and output of that process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";
const CHILD_TIMEOUT_MS = 30_000;
const UNREACHABLE_DATABASE_URL = "postgresql://u:p@127.0.0.1:1/x";
const CONNECTION_REFUSED = /connect ECONNREFUSED 127\.0\.0\.1:1\b/;
const INTEGRATION_FLAG = "RUN_CONTROL_PLANE_INTEGRATION_TESTS";

/** The five steps of Requirement 1.3 that run before control-plane:integration, as written in ci.yml. */
const DATABASE_STEPS = [
  ["db:migrate"],
  ["db:migrate:integrity:test"],
  ["service-principals:integration"],
  ["db:migrate:lock:test"],
  ["db:verify", "--", "--allow-privileged"]
];

function environment(overrides) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toUpperCase() === "DATABASE_URL" || name.toUpperCase() === INTEGRATION_FLAG || /^PG/i.test(name)) continue;
    env[name] = value;
  }
  return { ...env, ...overrides };
}

/** Runs `npm run <args>` from the repository root and resolves with its status and output. */
function runNpm(args, overrides = {}) {
  const [script] = args;
  assert.equal(typeof scripts[script], "string", `package.json must define the npm script ${script}`);
  return new Promise((resolve, reject) => {
    const child = spawn(npm, ["run", ...args], { cwd: root, env: environment(overrides), shell: isWindows, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CHILD_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

function assertFailedFast(result, command) {
  assert.equal(result.timedOut, false, `${command} must exit within ${CHILD_TIMEOUT_MS} ms instead of waiting`);
  assert.equal(typeof result.status, "number", `${command} must exit with a status, not by signal ${result.signal}`);
  assert.notEqual(result.status, 0, `${command} must exit non-zero; output:\n${result.stdout}${result.stderr}`);
}

const label = (args) => `npm run ${args.join(" ")}`;

describe("PostgreSQL CI steps fail closed", { concurrency: 4 }, () => {
  for (const args of DATABASE_STEPS) {
    test(`${label(args)} exits non-zero without DATABASE_URL or PG* variables`, async () => {
      const result = await runNpm(args);
      assertFailedFast(result, label(args));
      assert.match(`${result.stdout}${result.stderr}`, /DATABASE_URL/, `${label(args)} must name the missing DATABASE_URL`);
    });

    test(`${label(args)} exits non-zero when PostgreSQL is not reachable`, async () => {
      const result = await runNpm(args, { DATABASE_URL: UNREACHABLE_DATABASE_URL });
      assertFailedFast(result, label(args));
      assert.match(`${result.stdout}${result.stderr}`, CONNECTION_REFUSED, `${label(args)} must fail on the refused connection`);
    });
  }

  for (const [description, overrides] of [
    [`${INTEGRATION_FLAG} is not set`, {}],
    [`${INTEGRATION_FLAG} is "false"`, { [INTEGRATION_FLAG]: "false" }]
  ]) {
    test(`npm run control-plane:integration exits non-zero when ${description}`, async () => {
      const result = await runNpm(["control-plane:integration"], { DATABASE_URL: UNREACHABLE_DATABASE_URL, ...overrides });
      assertFailedFast(result, "npm run control-plane:integration");
      assert.match(result.stderr, new RegExp(INTEGRATION_FLAG), `standard error must name ${INTEGRATION_FLAG}`);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, CONNECTION_REFUSED, "the flag must be checked before connecting");
    });
  }

  test("npm run control-plane:integration exits non-zero without DATABASE_URL", async () => {
    const result = await runNpm(["control-plane:integration"], { [INTEGRATION_FLAG]: "true" });
    assertFailedFast(result, "npm run control-plane:integration");
    assert.match(`${result.stdout}${result.stderr}`, /DATABASE_URL/);
  });

  test("npm run control-plane:integration exits non-zero when PostgreSQL is not reachable", async () => {
    const result = await runNpm(["control-plane:integration"], { [INTEGRATION_FLAG]: "true", DATABASE_URL: UNREACHABLE_DATABASE_URL });
    assertFailedFast(result, "npm run control-plane:integration");
    assert.match(`${result.stdout}${result.stderr}`, CONNECTION_REFUSED);
  });
});
