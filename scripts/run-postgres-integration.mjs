// npm run postgres:integration — runs every scripts/integration/*.test.mjs against a real PostgreSQL cluster
// (design part 8, section 1.1). Prepares the cluster once (roles, migrated template), then calls
// `node --test --test-concurrency=<n>` with the sorted, explicit file list; each test file clones its own
// database from the template through scripts/integration/harness.mjs.
//
// Usage: node scripts/run-postgres-integration.mjs [--only <file>]... [--concurrency <n>]
//          [--test-reporter=<reporter>]... [--test-reporter-destination=<dest>]...
//   DATABASE_URL            PostgreSQL superuser connection string (required).
//   INTEGRATION_CONCURRENCY default for --concurrency (default 3).
//   SHZ_IT_KEEP=true        keep the template and the per-file databases for inspection.
// Exit codes: the exit code of `node --test`; 2 when setup fails (missing DATABASE_URL, connection failure,
// not a superuser, template migration or grant script failure, role check failure), with the first line
// `ERROR postgres:integration setup <reason>` and without running any test.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { cleanupRun, newRunId, prepareCluster, redact, REPO_ROOT, SetupError } from "./integration/lib/cluster.mjs";

const INTEGRATION_DIR = path.join(REPO_ROOT, "scripts", "integration");

function setupFailure(reason, secrets = []) {
  process.stderr.write(`ERROR postgres:integration setup ${redact(reason, secrets)}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { only: [], concurrency: undefined, passthrough: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--only") {
      const value = argv[index + 1];
      if (!value) setupFailure("--only requires a test file");
      options.only.push(value);
      index += 1;
    } else if (arg.startsWith("--only=")) {
      options.only.push(arg.slice("--only=".length));
    } else if (arg === "--concurrency") {
      options.concurrency = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--concurrency=")) {
      options.concurrency = arg.slice("--concurrency=".length);
    } else if (/^--test-reporter(-destination)?=./.test(arg)) {
      options.passthrough.push(arg);
    } else {
      setupFailure(`unknown argument ${arg}; usage: [--only <file>]... [--concurrency <n>] [--test-reporter=<r>] [--test-reporter-destination=<d>]`);
    }
  }
  return options;
}

function resolveFiles(only) {
  if (only.length === 0) {
    const names = existsSync(INTEGRATION_DIR) ? readdirSync(INTEGRATION_DIR).filter((name) => name.endsWith(".test.mjs")).sort() : [];
    if (names.length === 0) setupFailure("no scripts/integration/*.test.mjs files found");
    return names.map((name) => path.join(INTEGRATION_DIR, name));
  }
  const files = only.map((file) => {
    const absolute = path.resolve(REPO_ROOT, file);
    const relative = path.relative(INTEGRATION_DIR, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !absolute.endsWith(".test.mjs")) setupFailure(`--only ${file} is not a scripts/integration/*.test.mjs file`);
    if (!existsSync(absolute)) setupFailure(`--only ${file} does not exist`);
    return absolute;
  });
  return [...new Set(files)].sort();
}

function parseConcurrency(value) {
  const text = value ?? process.env.INTEGRATION_CONCURRENCY ?? "3";
  if (!/^[1-9]\d*$/.test(String(text))) setupFailure(`concurrency must be a positive integer, found ${JSON.stringify(text)}`);
  return Number(text);
}

const options = parseArgs(process.argv.slice(2));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) setupFailure("DATABASE_URL is not set; set it to a PostgreSQL superuser connection string");
const files = resolveFiles(options.only);
const concurrency = parseConcurrency(options.concurrency);
const keep = process.env.SHZ_IT_KEEP === "true";
const log = (line) => process.stdout.write(`postgres:integration ${line}\n`);

let prepared;
try {
  prepared = await prepareCluster({ databaseUrl, runId: newRunId(), log });
} catch (error) {
  setupFailure(error instanceof SetupError ? error.message : `unexpected error: ${error.message}`, [safePassword(databaseUrl)]);
}
const secrets = [...Object.values(prepared.secrets), safePassword(databaseUrl)];
log(`run ${prepared.runId}: template ${prepared.template}, ${prepared.migrations} migrations, ${files.length} test file(s), concurrency ${concurrency}`);
if (prepared.skippedGrantScripts.length) log(`NOTE skipped missing grant scripts: ${prepared.skippedGrantScripts.join(", ")}`);

let status = 1;
try {
  status = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", `--test-concurrency=${concurrency}`, ...options.passthrough, ...files], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SHZ_IT_RUN_ID: prepared.runId,
        SHZ_IT_TEMPLATE: prepared.template,
        SHZ_IT_ROLE_SECRETS: JSON.stringify(prepared.secrets),
        SHZ_IT_KEEP: keep ? "true" : "false",
        SHZ_IT_SKIPPED_GRANT_SCRIPTS: JSON.stringify(prepared.skippedGrantScripts)
      },
      stdio: "inherit"
    });
    child.on("error", (error) => { process.stderr.write(`ERROR postgres:integration cannot start node --test: ${error.message}\n`); resolve(1); });
    child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
} finally {
  await cleanupRun({ databaseUrl, runId: prepared.runId, keep, log }).catch((error) => process.stderr.write(`WARN postgres:integration cleanup failed: ${redact(error.message, secrets)}\n`));
}
process.exit(status);

function safePassword(url) {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return "";
  }
}
