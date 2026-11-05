// Behavioral tests for Migration_Lint (scripts/check-migration-lint.mjs) and the SQL lexer it uses
// (scripts/lib/sql-lexer.mjs): Requirement 10.10 to 10.13 with the fixture directories in
// scripts/fixtures/migration-lint, error directories built in os.tmpdir(), the real 001-067 subset, the optional
// datafix and before-delete-return rules, and fast-check properties 37 to 40.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { deleteReachesReturnNew, findTgOpComparisons, lintMigrationSources, migrationNumber } from "./check-migration-lint.mjs";
import { findPsqlVariables, lexSql, maskSql, splitStatements, substitutePsqlIdentifierVariable } from "./lib/sql-lexer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "scripts", "check-migration-lint.mjs");
const fixtures = path.join(root, "scripts", "fixtures", "migration-lint");
const migrations = path.join(root, "infra", "postgres", "migrations");
const SEED = 20261105;

function lint(directory, ...extra) {
  const result = spawnSync(process.execPath, [cli, "--migrations-dir", directory, ...extra], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, lines: result.stdout.split("\n").filter(Boolean) };
}
const tgopLines = (lines) => lines.filter((line) => line.startsWith("TGOP "));

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "migration-lint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("R10.10: one lower-case delete comparison exits 1 with file, line and function", () => {
  const result = lint(path.join(fixtures, "r10-10-lowercase-delete"));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(tgopLines(result.lines), [`TGOP 001_lowercase_delete.sql:6 function=guard_fixture operator="=" literals='delete'`]);
  assert.match(result.stdout, /FAIL {2}1 lower-case TG_OP comparison\(s\)/);
});

test("R10.11: upper-case-only comparisons exit 0", () => {
  const result = lint(path.join(fixtures, "r10-11-uppercase-only"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS {2}1 trigger functions in 1 migration files compare TG_OP only with upper-case literals$/m);
});

test("R10.12: a larger number replaces by numeric order, ignoring case and the public. prefix", () => {
  // Lexicographically 10_new.sql sorts before 9_old.sql; only numeric order makes 10 the replacement.
  const result = lint(path.join(fixtures, "r10-12-replaced-fixed"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const verbose = lint(path.join(fixtures, "r10-12-replaced-fixed"), "--verbose");
  assert.match(verbose.stdout, /^REPLACED 9_old\.sql:6 function=enforce_x .* replaced-by=10_new\.sql$/m);
});

test("R10.13: a replacement that still compares lower-case is the only one reported", () => {
  const result = lint(path.join(fixtures, "r10-13-replaced-still-lower"));
  assert.equal(result.status, 1);
  assert.deepEqual(tgopLines(result.lines), [`TGOP 10_new.sql:6 function=enforce_x operator="=" literals='Delete'`]);
  assert.doesNotMatch(result.stdout, /9_old\.sql/);
});

test("R10.1/10.2: every comparison form is reported once with its line; upper case, non-trigger and CASE WHEN are not", () => {
  const result = lint(path.join(fixtures, "all-forms"));
  assert.equal(result.status, 1);
  assert.deepEqual(tgopLines(result.lines), [
    `TGOP 001_forms.sql:6 function=all_forms operator="=" literals='delete'`,
    `TGOP 001_forms.sql:7 function=all_forms operator="=" literals='update'`,
    `TGOP 001_forms.sql:8 function=all_forms operator="<>" literals='insert'`,
    `TGOP 001_forms.sql:9 function=all_forms operator="!=" literals='Insert'`,
    `TGOP 001_forms.sql:10 function=all_forms operator="=" literals='delete'`,
    `TGOP 001_forms.sql:11 function=all_forms operator="IN" literals='INSERT','update'`,
    `TGOP 001_forms.sql:12 function=all_forms operator="NOT IN" literals='delete'`,
    `TGOP 001_forms.sql:13 function=all_forms operator="=" literals='truncate'`,
    `TGOP 001_forms.sql:16 function=all_forms operator="=" literals='delete'`
  ]);
});

test("R10.1: comments, strings and nested dollar quotes hide comparisons", () => {
  const result = lint(path.join(fixtures, "comments-strings-dollar"));
  assert.equal(result.status, 1);
  assert.deepEqual(tgopLines(result.lines), [`TGOP 001_x.sql:14 function=x_guard operator="=" literals='update'`]);
});

test("R10.3: neither a second definition in the same file nor a file with the same number replaces", () => {
  assert.deepEqual(tgopLines(lint(path.join(fixtures, "same-file-twice")).lines), [`TGOP 001_x.sql:6 function=twice_guard operator="=" literals='delete'`]);
  assert.deepEqual(tgopLines(lint(path.join(fixtures, "same-number")).lines), [
    `TGOP 005_a.sql:6 function=same_number_guard operator="=" literals='delete'`,
    `TGOP 005_b.sql:7 function=same_number_guard operator="=" literals='update'`
  ]);
});

test("R10.5: unusable directories and files exit 2 with the reason and file name", async (t) => {
  const base = await temporaryDirectory(t);
  const missing = lint(path.join(base, "does-not-exist"));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /ERROR migration-lint directory not found: .*does-not-exist/);

  const readmeOnly = path.join(base, "readme-only");
  await mkdir(readmeOnly);
  await writeFile(path.join(readmeOnly, "README.txt"), "not a migration\n");
  const empty = lint(readmeOnly);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /ERROR migration-lint no \.sql files in /);

  const unnumbered = path.join(base, "unnumbered");
  await mkdir(unnumbered);
  await writeFile(path.join(unnumbered, "abc.sql"), "select 1;\n");
  await copyFile(path.join(fixtures, "r10-10-lowercase-delete", "001_lowercase_delete.sql"), path.join(unnumbered, "001_lowercase_delete.sql"));
  const prefix = lint(unnumbered);
  assert.equal(prefix.status, 2);
  assert.match(prefix.stderr, /ERROR migration-lint file name does not start with a numeric prefix: abc\.sql/);
  assert.match(prefix.stdout, /TGOP 001_lowercase_delete\.sql:6 /, "the valid file in the same directory is still analyzed");

  const directoryEntry = path.join(base, "directory-entry");
  await mkdir(path.join(directoryEntry, "002_dir.sql"), { recursive: true });
  await writeFile(path.join(directoryEntry, "001_ok.sql"), "select 1;\n");
  const unreadable = lint(directoryEntry);
  assert.equal(unreadable.status, 2);
  assert.match(unreadable.stderr, /ERROR migration-lint cannot read 002_dir\.sql: E/);

  const unterminated = path.join(base, "unterminated");
  await mkdir(unterminated);
  await writeFile(path.join(unterminated, "001_open.sql"), "create function f() returns trigger language plpgsql as $fn$\nbegin\n  return new;\nend;\n");
  const lexError = lint(unterminated);
  assert.equal(lexError.status, 2);
  assert.match(lexError.stderr, /ERROR migration-lint lex error 001_open\.sql:1: unterminated dollar-quoted string \$fn\$/);
});

test("R10.1/10.3: the real 001-067 migrations report exactly the seven historical comparisons", async (t) => {
  const subset = await temporaryDirectory(t);
  for (const name of await readdir(migrations)) {
    if (name.endsWith(".sql") && migrationNumber(name) <= 67n) await copyFile(path.join(migrations, name), path.join(subset, name));
  }
  const result = lint(subset);
  assert.equal(result.status, 1);
  assert.deepEqual(result.lines, [
    `TGOP 061_channel_verification_remediation.sql:10 function=enforce_channel_connection_verification operator="=" literals='delete'`,
    `TGOP 061_channel_verification_remediation.sql:14 function=enforce_channel_connection_verification operator="=" literals='insert'`,
    `TGOP 062_settlement_reconciliation.sql:100 function=govern_settlement_batch operator="=" literals='delete'`,
    `TGOP 062_settlement_reconciliation.sql:101 function=govern_settlement_batch operator="=" literals='update'`,
    `TGOP 062_settlement_reconciliation.sql:117 function=govern_settlement_line operator="<>" literals='insert'`,
    `TGOP 062_settlement_reconciliation.sql:126 function=govern_settlement_exception operator="=" literals='delete'`,
    `TGOP 062_settlement_reconciliation.sql:127 function=govern_settlement_exception operator="=" literals='update'`,
    "FAIL  7 lower-case TG_OP comparison(s)"
  ]);
});

test("R10.4: the repository's migrations pass every rule; 069 and 070 replace the 059, 061 and 062 definitions", () => {
  const result = lint(migrations, "--all-rules", "--verbose");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(tgopLines(result.lines).length, 0);
  const replaced = result.lines.filter((line) => line.startsWith("REPLACED "));
  assert.equal(replaced.length, 9, replaced.join("\n"));
  for (const line of replaced) {
    if (/^REPLACED 059_/.test(line)) assert.match(line, /replaced-by=061_/);
    if (/^REPLACED 061_/.test(line)) assert.match(line, /replaced-by=069_/);
    if (/^REPLACED 062_/.test(line)) assert.match(line, /replaced-by=070_/);
  }
});

test("datafix rule: top-level data changes in migrations >= 079 are reported, guarded ones are not", () => {
  const result = lint(path.join(fixtures, "datafix"), "--rules", "datafix");
  assert.equal(result.status, 1);
  assert.deepEqual(result.lines.filter((line) => line.startsWith("DATAFIX ")).map((line) => line.split(" ").slice(0, 2).join(" ")), ["DATAFIX 080_unguarded.sql:2", "DATAFIX 080_unguarded.sql:3", "DATAFIX 080_unguarded.sql:4"]);
  // The default rule set is the Requirement 10 gate only, so the same directory passes it.
  assert.equal(lint(path.join(fixtures, "datafix")).status, 0);
});

test("before-delete-return rule: BEFORE ROW DELETE functions that can return NEW on DELETE are reported", () => {
  const result = lint(path.join(fixtures, "before-delete-return"), "--rules", "before-delete-return");
  assert.equal(result.status, 1);
  assert.deepEqual(result.lines.filter((line) => line.startsWith("DELRET ")).map((line) => line.split(" ").slice(0, 3).join(" ")), [
    "DELRET 001_triggers.sql:8 function=lock_guard",
    "DELRET 001_triggers.sql:19 function=lower_guard"
  ]);
});

test("before-delete-return rule reports the C2 functions of 062 when 070 is absent", async (t) => {
  const subset = await temporaryDirectory(t);
  for (const name of await readdir(migrations)) {
    if (name.endsWith(".sql") && migrationNumber(name) <= 69n) await copyFile(path.join(migrations, name), path.join(subset, name));
  }
  const functions = lint(subset, "--rules", "before-delete-return").lines.filter((line) => line.startsWith("DELRET ")).map((line) => /function=(\S+)/.exec(line)[1]);
  assert.deepEqual(functions, ["govern_settlement_batch", "govern_settlement_exception"]);
});

test("deleteReachesReturnNew follows TG_OP branches", () => {
  const body = (text) => `\nbegin\n${text}\nend;\n`;
  assert.equal(deleteReachesReturnNew(body("  if TG_OP = 'DELETE' then return old; end if;\n  return new;")), null);
  assert.equal(deleteReachesReturnNew(body("  if TG_OP = 'DELETE' then raise notice 'x'; end if;\n  return new;"))?.line, 4, "RAISE NOTICE does not end the DELETE path");
  assert.equal(deleteReachesReturnNew(body("  if TG_OP <> 'DELETE' then return new; else return old; end if;")), null);
  assert.equal(deleteReachesReturnNew(body("  if not (TG_OP = 'DELETE') then return new; end if;\n  return old;")), null);
  assert.equal(deleteReachesReturnNew(body("  if TG_OP = 'INSERT' or new.x then return new; end if;\n  return old;"))?.line, 3);
  assert.equal(deleteReachesReturnNew(body("  perform case when TG_OP = 'DELETE' then 1 else 0 end;\n  return new;"))?.line, 4, "a CASE expression is not an IF branch");
});

test("lexSql: parameters, identifiers with $, E strings, signed numbers, CRLF lines", () => {
  const { tokens, errors } = lexSql("select $1, foo$bar, E'a\\'b', a=-1;");
  assert.deepEqual(errors, []);
  assert.deepEqual(tokens.map((token) => [token.type, token.value]), [["ident", "select"], ["param", "$1"], ["punct", ","], ["ident", "foo$bar"], ["punct", ","], ["string", "a'b"], ["punct", ","], ["ident", "a"], ["op", "="], ["number", "-1"], ["punct", ";"]]);
  const lf = lexSql("a\n/* x\n y */ b\n'c\nd' e").tokens.map((token) => token.line);
  const crlf = lexSql("a\r\n/* x\r\n y */ b\r\n'c\r\nd' e").tokens.map((token) => token.line);
  assert.deepEqual(crlf, lf);
  assert.deepEqual(lf, [1, 3, 4, 5]);
  assert.deepEqual(lexSql("\uFEFFselect").tokens.map((token) => [token.value, token.start]), [["select", 0]]);
  assert.deepEqual(lexSql("x::text := y <=> z[1:2]").tokens.map((token) => token.value), ["x", "::", "text", ":=", "y", "<=>", "z", "[", "1", ":", "2", "]"]);
  assert.deepEqual(lexSql("for i in 1..10 loop").tokens.slice(3, 4).map((token) => [token.type, token.value]), [["number", "1"]], "a FOR range does not glue the dot to the number");
  assert.deepEqual(lexSql("a+-b").tokens.map((token) => token.value), ["a", "+", "-", "b"], "an operator does not end in + or - unless it contains ~ ! @ # % ^ & | ` ?");
  assert.deepEqual(lexSql("a @- b").tokens.map((token) => token.value), ["a", "@-", "b"]);
  assert.deepEqual(lexSql("a=--c\nb").tokens.map((token) => token.value), ["a", "=", "b"], "a comment start ends an operator");
  assert.deepEqual(lexSql("U&'d\\0061t' N'x' X'1F' B'01' \"q\"\"i\"").tokens.map((token) => [token.type, token.value]), [["string", "d\\0061t"], ["string", "x"], ["string", "1F"], ["string", "01"], ["quoted_ident", "q\"i"]]);
  for (const source of ["'open", "\"open", "/* open /* nested */", "$x$ open"]) assert.equal(lexSql(source).errors.length, 1, source);
});

test("splitStatements and maskSql keep literal and body content out of the code", () => {
  const source = "create function f() returns void as $$ begin perform 1; end; $$ language plpgsql;\n-- ; comment\nselect ';', (1;2);";
  const statements = splitStatements(lexSql(source).tokens);
  assert.equal(statements.length, 2);
  assert.equal(statements[1].line, 3);
  const { masked } = maskSql("select 'a;b' -- c\n, $q$x$q$;");
  assert.equal(masked.length, "select 'a;b' -- c\n, $q$x$q$;".length);
  assert.doesNotMatch(masked, /a;b|-- c|\$q\$/);
  assert.match(masked, /^select\s+\n,\s+;$/);
});

test("psql variables: only :\"control_plane_role\" is substituted, outside literals", async () => {
  assert.deepEqual(findPsqlVariables("select x::text, :'v', :w, :\"r\" from t where a := 1 and '…:\"r\"'").variables.map((variable) => [variable.name, variable.form]), [["v", "literal"], ["w", "bare"], ["r", "identifier"]]);
  assert.equal(substitutePsqlIdentifierVariable("grant select on t to :\"role\"; -- :\"role\"\n", "role", "a\"b"), "grant select on t to \"a\"\"b\"; -- :\"role\"\n");
  assert.throws(() => substitutePsqlIdentifierVariable("grant select on t to :\"role\", :other;", "role", "x"), /only the psql variable/);
  assert.throws(() => substitutePsqlIdentifierVariable("\\set x 1\ngrant select on t to :\"role\";", "role", "x"), /meta-commands/);
  const script = await readFile(path.join(root, "infra", "postgres", "control-plane-principal.sql"), "utf8");
  const substituted = substitutePsqlIdentifierVariable(script, "control_plane_role", "shuzhiren_control_plane");
  assert.doesNotMatch(maskSql(substituted).masked, /:"control_plane_role"/);
  assert.match(substituted, /^revoke all privileges on all tables in schema public from "shuzhiren_control_plane";$/m);
});

// Property 40: a dollar-quoted string is one token whose body is exact, and line numbers continue after it.
test("Property 40: dollar-quote delimitation", () => {
  const tagArbitrary = fc.oneof(fc.constant(""), fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,6}$/));
  const bodyArbitrary = fc.array(fc.constantFrom("a", " ", "\n", "$", "'", ";", "--", "/*", "*/", "$x", "\"", "1"), { maxLength: 30 }).map((parts) => parts.join(""));
  fc.assert(fc.property(tagArbitrary, bodyArbitrary, (tag, body) => {
    const delimiter = `$${tag}$`;
    // b must not contain $tag$, including across its boundary with the closing delimiter.
    fc.pre(`${body}${delimiter}`.indexOf(delimiter) === body.length);
    const { tokens, errors } = lexSql(`${delimiter}${body}${delimiter} next`);
    assert.deepEqual(errors, []);
    assert.equal(tokens[0].type, "dollar_string");
    assert.equal(tokens[0].body, body);
    assert.equal(tokens[1].value, "next");
    assert.equal(tokens[1].line, 1 + (body.match(/\n/g) ?? []).length);
  }), { numRuns: 300, seed: SEED });
});

const OPERATORS = ["=", "<>", "!=", "IN", "NOT IN"];
const LITERALS = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"];
const separatorArbitrary = fc.constantFrom(" ", "  ", "\n", " /* c */ ", " -- c\n", "\t");
const randomCase = (word) => fc.array(fc.boolean(), { minLength: word.length, maxLength: word.length }).map((flags) => [...word].map((ch, index) => (flags[index] ? ch.toLowerCase() : ch.toUpperCase())).join(""));
const comparisonArbitrary = fc.record({
  tgOp: randomCase("TG_OP"),
  operator: fc.constantFrom(...OPERATORS),
  reversed: fc.boolean(),
  literals: fc.array(fc.constantFrom(...LITERALS).chain(randomCase), { minLength: 1, maxLength: 3 }),
  gaps: fc.array(separatorArbitrary, { minLength: 3, maxLength: 3 })
});
function renderComparison({ tgOp, operator, reversed, literals, gaps }) {
  if (operator === "IN" || operator === "NOT IN") return `${tgOp}${gaps[0]}${operator.replace(" ", gaps[1])}${gaps[2]}(${literals.map((literal) => `'${literal}'`).join(", ")})`;
  return reversed ? `'${literals[0]}'${gaps[0]}${operator}${gaps[1]}${tgOp}` : `${tgOp}${gaps[0]}${operator}${gaps[1]}'${literals[0]}'`;
}
const linesOf = (text) => (text.match(/\n/g) ?? []).length;

// Property 37: the reported lines are exactly the lines of TG_OP in comparisons with a lower-case literal.
test("Property 37: lower-case comparisons are reported exactly", () => {
  fc.assert(fc.property(fc.array(comparisonArbitrary, { minLength: 1, maxLength: 6 }), (comparisons) => {
    let body = "\nbegin\n";
    const expected = [];
    for (const comparison of comparisons) {
      const statement = renderComparison(comparison);
      const used = comparison.operator === "IN" || comparison.operator === "NOT IN" ? comparison.literals : [comparison.literals[0]];
      const binary = !comparison.operator.includes("IN");
      const tgOpOffset = binary && comparison.reversed ? statement.length - comparison.tgOp.length : 0;
      const line = 1 + linesOf(body) + linesOf(statement.slice(0, tgOpOffset));
      if (used.some((literal) => /\p{Ll}/u.test(literal))) expected.push(line);
      body += `  if ${statement} then null; end if;\n`;
    }
    body += "  return new;\nend;\n";
    assert.deepEqual(findTgOpComparisons(body, 1).map((finding) => finding.line), expected);
  }), { numRuns: 200, seed: SEED });
});

// Property 38: a comparison only inside comments or string literals is never reported.
test("Property 38: comparisons in comments and strings are not reported", () => {
  fc.assert(fc.property(comparisonArbitrary, fc.constantFrom("line", "block", "string", "dollar"), (comparison, wrapper) => {
    const text = renderComparison({ ...comparison, gaps: comparison.gaps.map((gap) => (gap.includes("--") || gap.includes("/*") ? " " : gap)) });
    const wrapped = { line: `-- ${text.replaceAll("\n", " ")}\n`, block: `/* ${text} */`, string: `raise notice '${text.replaceAll("'", "''")}';`, dollar: `perform $q$${text}$q$;` }[wrapper];
    assert.deepEqual(findTgOpComparisons(`\nbegin\n  ${wrapped}\n  return new;\nend;\n`, 1), []);
  }), { numRuns: 200, seed: SEED });
});

// Property 39: reported definitions are exactly the lower-case trigger definitions with no same-name
// definition in a file with a strictly larger number.
test("Property 39: only effective trigger definitions are reported", () => {
  const definitionArbitrary = fc.record({ name: fc.constantFrom("alpha_guard", "beta_guard", "gamma_guard"), upper: fc.boolean(), prefix: fc.boolean(), lower: fc.boolean() });
  const fileArbitrary = fc.record({ number: fc.integer({ min: 1, max: 12 }), definitions: fc.array(definitionArbitrary, { minLength: 1, maxLength: 3 }) });
  fc.assert(fc.property(fc.array(fileArbitrary, { minLength: 1, maxLength: 5 }), (generated) => {
    const files = generated.map((file, index) => ({
      name: `${file.number}_f${index}.sql`,
      number: file.number,
      definitions: file.definitions,
      text: file.definitions.map((definition) => `create or replace function ${definition.prefix ? "public." : ""}${definition.upper ? definition.name.toUpperCase() : definition.name}()\nreturns trigger language plpgsql as $$\nbegin\n  if TG_OP = '${definition.lower ? "delete" : "DELETE"}' then null; end if;\n  return new;\nend;\n$$;\n`).join("")
    }));
    const expected = new Set();
    for (const file of files) {
      for (const definition of file.definitions) {
        if (!definition.lower) continue;
        if (files.some((other) => other.number > file.number && other.definitions.some((candidate) => candidate.name === definition.name))) continue;
        expected.add(`${file.name}:${definition.name}`);
      }
    }
    const reported = new Set(lintMigrationSources(files.map(({ name, text }) => ({ name, text }))).findings.map((finding) => `${finding.file}:${finding.function}`));
    assert.deepEqual([...reported].sort(), [...expected].sort());
  }), { numRuns: 200, seed: SEED });
});
