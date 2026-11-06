// Static gate for apps/console/lib/shared/, the directory of pure modules that the console and the runtime
// worker both run (design.md module B, B.1). Six rules:
//   1  the directory holds only *.mjs files and the same-named *.d.mts files, one of each per module;
//   2  a shared .mjs imports only node: built-ins and sibling ./*.mjs files;
//   3  each .d.mts declares exactly the value exports of its .mjs;
//   4  apps/runtime-worker has no policy-engine.mjs and defines no evaluatePolicy, and imports shared code
//      only as ../console/lib/shared/<name>.mjs;
//   5  apps/runtime-worker/Dockerfile copies the shared directory exactly once, before the worker sources,
//      and Dockerfile.dockerignore does not exclude it;
//   6  the console defines evaluatePolicy only in lib/shared/policy-engine.mjs (lib/policy-engine.ts re-exports).
//
// The CLI first runs the rules over every fixture tree in scripts/fixtures/shared-modules/ (exit 2 when a
// counter-example is not reported, or the valid tree is), then over the repository (exit 1 on violations).
//   node scripts/check-shared-modules.mjs
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHARED_DIR = "apps/console/lib/shared";
const WORKER_DIR = "apps/runtime-worker";
const CONSOLE_DIR = "apps/console";
const SHARED_COPY = "COPY --chown=node:node apps/console/lib/shared apps/console/lib/shared";
const WORKER_COPY = "COPY --chown=node:node apps/runtime-worker apps/runtime-worker";
const SKIPPED_DIRS = new Set(["node_modules", ".next", ".git"]);
const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** @typedef {{ rule: number, file: string, message: string }} Violation */

/** `<rule> <file> <message>`, the line the gate prints. */
export const formatViolation = ({ rule, file, message }) => `${rule} ${file} ${message}`;

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Every file under `dir` (posix-style paths relative to `root`), skipping node_modules, .next and .git. */
async function walk(root, dir) {
  const result = [];
  let entries;
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) result.push(...(await walk(root, relative)));
    } else if (entry.isFile()) result.push(relative);
  }
  return result;
}

/** Specifiers of static imports, `export … from`, side-effect imports and literal dynamic imports, and the
 * number of dynamic imports whose specifier is not a string literal. */
export function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /^[ \t]*(?:import|export)\b[^'";]*?\bfrom\s*["']([^"']+)["']/gm,
    /^[ \t]*import\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  const nonLiteralDynamicImports = [...source.matchAll(/\bimport\s*\(\s*(?!["'\s])/g)].length;
  return { specifiers, nonLiteralDynamicImports };
}

const definesEvaluatePolicy = (source) => /\bfunction\s*\*?\s*evaluatePolicy\b|\b(?:const|let|var)\s+evaluatePolicy\s*=/.test(source);

/** Value export names declared by a .d.mts (types and interfaces are not runtime exports). */
function declaredExportNames(ts, file, source) {
  const names = new Set();
  const problems = [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hasModifier = (node, kind) => (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (!statement.exportClause) problems.push("uses `export * from`, which cannot be compared with the .mjs exports");
      else if (ts.isNamespaceExport(statement.exportClause)) names.add(statement.exportClause.name.text);
      else for (const element of statement.exportClause.elements) if (!element.isTypeOnly) names.add(element.name.text);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      names.add("default");
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      names.add("default");
      continue;
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isModuleDeclaration(statement)) continue;
    if (ts.isEnumDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.ConstKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
        else problems.push("declares an exported destructuring pattern");
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) names.add(statement.name.text);
  }
  return { names, problems };
}

const escapeRegExp = (text) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** Docker ignore pattern → anchored regular expression (`**` crosses directories, `*` and `?` do not). */
function dockerIgnorePatternToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
        if (pattern[index + 1] === "/") index += 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

/** Whether a .dockerignore leaves `target` out of the build context (the last matching pattern wins). */
export function dockerIgnoreExcludes(ignoreText, target) {
  const segments = target.split("/");
  const paths = segments.map((_, index) => segments.slice(0, index + 1).join("/"));
  let excluded = false;
  for (const raw of ignoreText.split(/\r?\n/)) {
    let pattern = raw.trim();
    if (pattern === "" || pattern.startsWith("#")) continue;
    const negated = pattern.startsWith("!");
    if (negated) pattern = pattern.slice(1).trim();
    pattern = path.posix.normalize(pattern.replace(/^\/+/, "")).replace(/\/+$/, "");
    if (pattern === "" || pattern === ".") continue;
    const regexp = dockerIgnorePatternToRegExp(pattern);
    if (paths.some((candidate) => regexp.test(candidate))) excluded = !negated;
  }
  return excluded;
}

async function checkSharedDirectory(root, report) {
  const dir = path.join(root, SHARED_DIR);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    report(1, SHARED_DIR, "the shared directory does not exist");
    return;
  }
  const modules = new Set();
  const declarations = new Set();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `${SHARED_DIR}/${entry.name}`;
    if (!entry.isFile()) report(1, file, "the shared directory may contain only *.mjs and *.d.mts files, not subdirectories");
    else if (entry.name.endsWith(".d.mts")) declarations.add(entry.name.slice(0, -".d.mts".length));
    else if (entry.name.endsWith(".mjs")) modules.add(entry.name.slice(0, -".mjs".length));
    else report(1, file, "the shared directory may contain only *.mjs and *.d.mts files");
  }
  for (const name of [...modules].sort()) if (!declarations.has(name)) report(1, `${SHARED_DIR}/${name}.mjs`, `has no ${name}.d.mts`);
  for (const name of [...declarations].sort()) if (!modules.has(name)) report(1, `${SHARED_DIR}/${name}.d.mts`, `has no ${name}.mjs`);

  const importable = [];
  for (const name of [...modules].sort()) {
    const file = `${SHARED_DIR}/${name}.mjs`;
    const { specifiers, nonLiteralDynamicImports } = importSpecifiers(await readFile(path.join(root, file), "utf8"));
    let clean = nonLiteralDynamicImports === 0;
    if (!clean) report(2, file, "uses a dynamic import with a non-literal specifier");
    for (const specifier of specifiers) {
      if (specifier.startsWith("node:") || /^\.\/[^/]+\.mjs$/.test(specifier)) continue;
      clean = false;
      report(2, file, `imports ${JSON.stringify(specifier)}; shared modules may import only node: built-ins and sibling ./*.mjs files`);
    }
    if (clean && declarations.has(name)) importable.push(name);
  }

  if (importable.length === 0) return;
  const { default: ts } = await import("typescript");
  for (const name of importable) {
    const mjs = `${SHARED_DIR}/${name}.mjs`;
    const dts = `${SHARED_DIR}/${name}.d.mts`;
    const { names: declared, problems } = declaredExportNames(ts, dts, await readFile(path.join(root, dts), "utf8"));
    for (const problem of problems) report(3, dts, problem);
    let actual;
    try {
      actual = new Set(Object.keys(await import(pathToFileURL(path.join(root, mjs)).href)));
    } catch (error) {
      report(3, mjs, `cannot be imported to read its exports: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const exported of [...actual].sort()) if (!declared.has(exported)) report(3, dts, `does not declare the export ${exported} of ${name}.mjs`);
    for (const exported of [...declared].sort()) if (!actual.has(exported)) report(3, dts, `declares ${exported}, which ${name}.mjs does not export`);
  }
}

async function checkWorker(root, report) {
  const files = (await walk(root, WORKER_DIR)).filter((file) => file.endsWith(".mjs"));
  for (const file of files) {
    if (path.posix.basename(file) === "policy-engine.mjs") report(4, file, "the worker must not carry its own policy engine; import ../console/lib/shared/policy-engine.mjs");
    const source = await readFile(path.join(root, file), "utf8");
    if (definesEvaluatePolicy(source)) report(4, file, "defines evaluatePolicy; the only definition lives in apps/console/lib/shared/policy-engine.mjs");
    for (const specifier of importSpecifiers(source).specifiers) {
      if (/^\.\.\/console\/lib\/shared\/[^/]+\.mjs$/.test(specifier)) continue;
      if (specifier.includes("console/lib/") || /(?:^|\/)policy-engine(?:\.m?[jt]s)?$/.test(specifier)) {
        report(4, file, `imports ${JSON.stringify(specifier)}; shared logic must be imported as ../console/lib/shared/<name>.mjs`);
      }
    }
  }
}

async function checkWorkerImage(root, report) {
  const dockerfile = `${WORKER_DIR}/Dockerfile`;
  const ignoreFile = `${WORKER_DIR}/Dockerfile.dockerignore`;
  if (await exists(path.join(root, dockerfile))) {
    const lines = (await readFile(path.join(root, dockerfile), "utf8")).split(/\r?\n/).map((line) => line.trim().replace(/\s+/g, " "));
    const sharedCopies = lines.flatMap((line, index) => (/^COPY\b/i.test(line) && line.includes(SHARED_DIR) ? [index] : []));
    const workerCopy = lines.indexOf(WORKER_COPY);
    if (sharedCopies.length !== 1) report(5, dockerfile, `must contain exactly one line copying ${SHARED_DIR}, found ${sharedCopies.length}`);
    else if (lines[sharedCopies[0]] !== SHARED_COPY) report(5, dockerfile, `the shared copy line must be exactly: ${SHARED_COPY}`);
    if (workerCopy === -1) report(5, dockerfile, `has no line: ${WORKER_COPY}`);
    else if (sharedCopies.length === 1 && sharedCopies[0] > workerCopy) report(5, dockerfile, "copies the shared directory after the worker sources; it must come first");
  } else report(5, dockerfile, "does not exist");
  if (await exists(path.join(root, ignoreFile))) {
    if (dockerIgnoreExcludes(await readFile(path.join(root, ignoreFile), "utf8"), SHARED_DIR)) report(5, ignoreFile, `excludes ${SHARED_DIR} from the worker build context`);
  } else report(5, ignoreFile, "does not exist");
}

async function checkConsole(root, report) {
  const allowed = new Set([`${CONSOLE_DIR}/lib/policy-engine.ts`, `${SHARED_DIR}/policy-engine.mjs`, `${SHARED_DIR}/policy-engine.d.mts`]);
  for (const file of await walk(root, CONSOLE_DIR)) {
    if (allowed.has(file) || !SOURCE_EXTENSION.test(file)) continue;
    if (definesEvaluatePolicy(await readFile(path.join(root, file), "utf8"))) report(6, file, "defines evaluatePolicy; the console must use apps/console/lib/shared/policy-engine.mjs");
  }
}

/**
 * Runs the six rules over the tree rooted at `root`.
 * @returns {Promise<Violation[]>} violations ordered by rule, then file.
 */
export async function checkSharedModules(root) {
  /** @type {Violation[]} */
  const violations = [];
  const report = (rule, file, message) => violations.push({ rule, file, message });
  await checkSharedDirectory(root, report);
  await checkWorker(root, report);
  await checkWorkerImage(root, report);
  await checkConsole(root, report);
  return violations.sort((a, b) => a.rule - b.rule || a.file.localeCompare(b.file));
}

/**
 * Fixture trees under `fixturesRoot`: `valid` must report nothing; `rule-<n>-*` must report rule n.
 * @returns {Promise<string[]>} one message per fixture that behaves differently.
 */
export async function verifyFixtures(fixturesRoot) {
  const problems = [];
  const names = (await readdir(fixturesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const covered = new Set();
  for (const name of names) {
    const violations = await checkSharedModules(path.join(fixturesRoot, name));
    if (name === "valid") {
      for (const violation of violations) problems.push(`fixture valid: unexpected violation ${formatViolation(violation)}`);
      continue;
    }
    const expected = /^rule-(\d)-/.exec(name)?.[1];
    if (!expected) {
      problems.push(`fixture ${name}: the directory name must be "valid" or start with rule-<1-6>-`);
      continue;
    }
    covered.add(Number(expected));
    if (!violations.some((violation) => violation.rule === Number(expected))) problems.push(`fixture ${name}: rule ${expected} was not reported`);
  }
  if (!names.includes("valid")) problems.push("fixture valid: missing");
  for (let rule = 1; rule <= 6; rule += 1) if (!covered.has(rule)) problems.push(`rule ${rule} has no counter-example fixture`);
  return problems;
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const fixtureProblems = await verifyFixtures(path.join(repoRoot, "scripts", "fixtures", "shared-modules"));
  if (fixtureProblems.length > 0) {
    for (const problem of fixtureProblems) console.error(problem);
    console.error("shared:modules:check: the gate's own fixtures do not behave as expected");
    process.exit(2);
  }
  const violations = await checkSharedModules(repoRoot);
  if (violations.length > 0) {
    for (const violation of violations) console.error(formatViolation(violation));
    console.error(`shared:modules:check failed: ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log("shared:modules:check passed (apps/console/lib/shared, apps/runtime-worker, worker image context)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
