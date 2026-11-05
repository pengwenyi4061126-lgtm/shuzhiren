#!/usr/bin/env node
// Migration_Lint (Requirement 10): static checks of infra/postgres/migrations that need no database.
//
//   node scripts/check-migration-lint.mjs [--migrations-dir <path>] [--rules <list> | --all-rules] [--verbose]
//
// Rules (default: tgop only, which is the Migration_Lint gate of Requirement 10):
//   tgop                  A trigger function compares TG_OP with a string literal that contains a lower-case letter
//                         (TG_OP is always 'INSERT', 'UPDATE', 'DELETE' or 'TRUNCATE'; C1 and C2 were such
//                         comparisons). A definition replaced by a same-name function in a migration with a larger
//                         number is not reported: 059 is replaced by 061 and 069, 061 by 069 (C1), 062 by 070 (C2).
//   datafix               A migration numbered >= 079 changes existing rows without 079's migration_fix_* functions.
//                         This is the Migrator's own pre-check (findUnguardedDataFixStatements in
//                         apps/console/scripts/migration-integrity.mjs), run before any database is involved.
//   before-delete-return  The function of an effective BEFORE ... DELETE ... FOR EACH ROW trigger can reach
//                         "RETURN NEW;" when TG_OP is 'DELETE'. NEW is NULL for DELETE, and a BEFORE row trigger
//                         that returns NULL silently skips the row (the C2 failure mode: DELETE reported 0 rows and
//                         no error). IF branches decided by TG_OP comparisons are followed (deleteReachesReturnNew).
//
// Requirement 10.4 makes the tgop gate exit 0 whenever it finds no lower-case TG_OP comparison, so the other two
// rules run only when selected (design cross-part ruling 20 keeps the data-fix check out of the tgop gate).
//
// Exit codes: 0 no finding and no error; 1 at least one finding; 2 at least one error (findings are still printed).
// Findings go to stdout, errors to stderr as "ERROR migration-lint <reason>".
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { firstGuardedDataFixMigration, findUnguardedDataFixStatements } from "../apps/console/scripts/migration-integrity.mjs";
import { identifierName, isKeyword, lexSql, splitStatements } from "./lib/sql-lexer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_MIGRATIONS_DIR = path.join(root, "infra", "postgres", "migrations");
export const RULES = ["tgop", "datafix", "before-delete-return"];

/** Numeric prefix of a migration file name as a BigInt (so 10_x sorts after 9_y), or null. */
export function migrationNumber(fileName) {
  const match = /^(\d+)/.exec(fileName);
  return match ? BigInt(match[1]) : null;
}

function compareFiles(left, right) {
  const a = migrationNumber(left.name) ?? -1n;
  const b = migrationNumber(right.name) ?? -1n;
  if (a !== b) return a < b ? -1 : 1;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/** Function names are compared without quotes, case-insensitively and without a leading "public." schema. */
export function normalizeFunctionName(parts) {
  const names = parts.map((part) => part.toLowerCase());
  if (names.length === 2 && names[0] === "public") return names[1];
  return names.join(".");
}

/** Reads a qualified name (name or schema.name) at tokens[index]; returns { parts, next } or null. */
function readQualifiedName(tokens, index) {
  const first = tokens[index];
  if (!first || (first.type !== "ident" && first.type !== "quoted_ident")) return null;
  const parts = [first.value];
  let next = index + 1;
  while (tokens[next]?.type === "punct" && tokens[next].value === "." && (tokens[next + 1]?.type === "ident" || tokens[next + 1]?.type === "quoted_ident")) {
    parts.push(tokens[next + 1].value);
    next += 2;
  }
  return { parts, next };
}

/** Index after the parenthesized group that opens at tokens[index] (which must be "("), or tokens.length. */
function skipParens(tokens, index) {
  let depth = 0;
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token.type === "punct" && token.value === "(") depth += 1;
    else if (token.type === "punct" && token.value === ")") { depth -= 1; if (depth === 0) return cursor + 1; }
  }
  return tokens.length;
}

/**
 * Statements of one migration file with their kind:
 *   { kind: "function", def }   CREATE [OR REPLACE] FUNCTION | PROCEDURE
 *   { kind: "trigger", trigger } CREATE [OR REPLACE] [CONSTRAINT] TRIGGER
 *   { kind: "drop-trigger", table, name }, { kind: "drop-table", tables }
 */
function analyzeFile(file) {
  const { tokens, errors: lexErrors } = lexSql(file.text);
  const errors = lexErrors.map((error) => ({ file: file.name, line: error.line, reason: `lex error ${file.name}:${error.line}: ${error.message}` }));
  const defs = [];
  const triggerEvents = [];
  if (lexErrors.length) return { defs, triggerEvents, errors };
  for (const [position, statement] of splitStatements(tokens).entries()) {
    const t = statement.tokens;
    if (isKeyword(t[0], "create")) {
      let index = 1;
      if (isKeyword(t[index], "or") && isKeyword(t[index + 1], "replace")) index += 2;
      if (isKeyword(t[index], "function") || isKeyword(t[index], "procedure")) {
        const def = functionDefinition(file, t, index + 1, position);
        if (def.error) errors.push(def.error);
        else defs.push(def);
        continue;
      }
      if (isKeyword(t[index], "constraint")) index += 1;
      if (isKeyword(t[index], "trigger")) {
        const trigger = triggerDefinition(file, t, index + 1, position);
        if (trigger) triggerEvents.push({ kind: "create", ...trigger });
      }
      continue;
    }
    if (isKeyword(t[0], "drop") && isKeyword(t[1], "trigger")) {
      let index = 2;
      if (isKeyword(t[index], "if") && isKeyword(t[index + 1], "exists")) index += 2;
      const name = identifierName(t[index]);
      if (name && isKeyword(t[index + 1], "on")) {
        const table = readQualifiedName(t, index + 2);
        if (table) triggerEvents.push({ kind: "drop", name, table: normalizeFunctionName(table.parts), file: file.name, position });
      }
      continue;
    }
    if (isKeyword(t[0], "drop") && isKeyword(t[1], "table")) {
      let index = 2;
      if (isKeyword(t[index], "if") && isKeyword(t[index + 1], "exists")) index += 2;
      const tables = [];
      while (index < t.length) {
        const table = readQualifiedName(t, index);
        if (!table) break;
        tables.push(normalizeFunctionName(table.parts));
        index = table.next;
        if (t[index]?.type === "punct" && t[index].value === ",") index += 1;
        else break;
      }
      for (const table of tables) triggerEvents.push({ kind: "drop-table", table, file: file.name, position });
    }
  }
  return { defs, triggerEvents, errors };
}

function functionDefinition(file, tokens, nameIndex, position) {
  const name = readQualifiedName(tokens, nameIndex);
  const line = tokens[nameIndex]?.line ?? tokens[0].line;
  if (!name) return { error: { file: file.name, line, reason: `cannot read the function name in ${file.name}:${line}` } };
  let index = name.next;
  if (tokens[index]?.type === "punct" && tokens[index].value === "(") index = skipParens(tokens, index);
  let isTrigger = false;
  let bodyToken = null;
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token.type === "punct" && token.value === "(") { cursor = skipParens(tokens, cursor) - 1; continue; }
    if (isKeyword(token, "returns")) {
      let typeIndex = cursor + 1;
      if (isKeyword(tokens[typeIndex], "pg_catalog") && tokens[typeIndex + 1]?.value === ".") typeIndex += 2;
      if (isKeyword(tokens[typeIndex], "trigger")) isTrigger = true;
    }
    if (!bodyToken && isKeyword(token, "as") && (tokens[cursor + 1]?.type === "string" || tokens[cursor + 1]?.type === "dollar_string")) bodyToken = tokens[cursor + 1];
  }
  const displayName = name.parts.join(".");
  const def = {
    file: file.name,
    number: migrationNumber(file.name),
    name: displayName,
    normalizedName: normalizeFunctionName(name.parts),
    line,
    position,
    isTrigger,
    body: bodyToken ? bodyToken.body : null,
    bodyLine: bodyToken ? bodyToken.bodyLine : line
  };
  if (isTrigger && bodyToken === null) return { error: { file: file.name, line, reason: `trigger function ${displayName} in ${file.name}:${line} has no string body` } };
  return def;
}

function triggerDefinition(file, tokens, nameIndex, position) {
  const name = identifierName(tokens[nameIndex]);
  if (!name) return null;
  let index = nameIndex + 1;
  let timing = null;
  if (isKeyword(tokens[index], "before") || isKeyword(tokens[index], "after")) { timing = tokens[index].value.toLowerCase(); index += 1; }
  else if (isKeyword(tokens[index], "instead") && isKeyword(tokens[index + 1], "of")) { timing = "instead of"; index += 2; }
  const events = new Set();
  while (index < tokens.length && !isKeyword(tokens[index], "on")) {
    for (const event of ["insert", "update", "delete", "truncate"]) if (isKeyword(tokens[index], event)) events.add(event);
    index += 1;
  }
  const table = readQualifiedName(tokens, index + 1);
  if (!table) return null;
  let level = "statement";
  let functionName = null;
  for (let cursor = table.next; cursor < tokens.length; cursor += 1) {
    if (isKeyword(tokens[cursor], "for")) {
      const levelIndex = isKeyword(tokens[cursor + 1], "each") ? cursor + 2 : cursor + 1;
      if (isKeyword(tokens[levelIndex], "row")) level = "row";
      else if (isKeyword(tokens[levelIndex], "statement")) level = "statement";
    }
    if (isKeyword(tokens[cursor], "when") && tokens[cursor + 1]?.value === "(") { cursor = skipParens(tokens, cursor + 1) - 1; continue; }
    if (isKeyword(tokens[cursor], "execute") && (isKeyword(tokens[cursor + 1], "function") || isKeyword(tokens[cursor + 1], "procedure"))) {
      const fn = readQualifiedName(tokens, cursor + 2);
      if (fn) functionName = normalizeFunctionName(fn.parts);
      break;
    }
  }
  return { name, table: normalizeFunctionName(table.parts), timing, events: [...events], level, functionName, file: file.name, line: tokens[nameIndex].line, position };
}

/** All CREATE FUNCTION / PROCEDURE definitions of one file: { defs, errors }. */
export function findFunctionDefinitions(file, text) {
  const { defs, errors } = analyzeFile({ name: file, text });
  return { defs, errors };
}

const COMPARISON_OPERATORS = new Set(["=", "<>", "!="]);
const TYPE_WORDS = new Set(["varying", "precision", "zone", "with", "without", "time"]);

function isTgOp(token) {
  return (token?.type === "ident" && token.value.toLowerCase() === "tg_op") || (token?.type === "quoted_ident" && token.value === "tg_op");
}

/** Index after a "::type" suffix chain starting at tokens[index] (unchanged when there is none). */
function skipCasts(tokens, index) {
  let cursor = index;
  while (tokens[cursor]?.type === "punct" && tokens[cursor].value === "::") {
    const type = readQualifiedName(tokens, cursor + 1);
    if (!type) return cursor;
    cursor = type.next;
    while (tokens[cursor]?.type === "ident" && TYPE_WORDS.has(tokens[cursor].value.toLowerCase())) cursor += 1;
    if (tokens[cursor]?.type === "punct" && tokens[cursor].value === "(") cursor = skipParens(tokens, cursor);
    while (tokens[cursor]?.value === "[" && tokens[cursor + 1]?.value === "]") cursor += 2;
  }
  return cursor;
}

/** A string literal ending at tokens[index], optionally followed by a cast ("'x'::text"), looking back at most 6 tokens. */
function literalEndingAt(tokens, index) {
  let cursor = index;
  while (tokens[cursor]?.type === "punct" && tokens[cursor].value === ")") cursor -= 1;
  if (tokens[cursor]?.type === "string") return tokens[cursor];
  for (let back = cursor; back >= Math.max(0, cursor - 6); back -= 1) {
    if (tokens[back]?.type !== "string") continue;
    if (tokens[back + 1]?.type === "punct" && tokens[back + 1].value === "::" && skipCasts(tokens, back + 1) === cursor + 1) return tokens[back];
    return null;
  }
  return null;
}

/**
 * Every comparison of TG_OP with string literals in a function body (lexed from bodyLine):
 * [{ line, operator: "="|"<>"|"!="|"IN"|"NOT IN", literals }]. CASE TG_OP WHEN, IS DISTINCT FROM and LIKE are
 * not comparisons in the sense of Requirement 10.1 and are not returned.
 */
export function findTgOpLiteralComparisons(body, bodyLine = 1) {
  const { tokens } = lexSql(body, { startLine: bodyLine });
  const comparisons = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isTgOp(tokens[index])) continue;
    const line = tokens[index].line;
    const after = skipCasts(tokens, index + 1);
    const right = tokens[after];
    if (right?.type === "op" && COMPARISON_OPERATORS.has(right.value)) {
      let cursor = after + 1;
      while (tokens[cursor]?.type === "punct" && tokens[cursor].value === "(") cursor += 1;
      if (tokens[cursor]?.type === "string") comparisons.push({ line, operator: right.value, literals: [tokens[cursor].value] });
    } else if (isKeyword(right, "in") || (isKeyword(right, "not") && isKeyword(tokens[after + 1], "in"))) {
      const negated = isKeyword(right, "not");
      const open = after + (negated ? 2 : 1);
      if (tokens[open]?.type === "punct" && tokens[open].value === "(") {
        const literals = [];
        let depth = 0;
        for (let cursor = open; cursor < tokens.length; cursor += 1) {
          const token = tokens[cursor];
          if (token.type === "punct" && token.value === "(") depth += 1;
          else if (token.type === "punct" && token.value === ")") { depth -= 1; if (depth === 0) break; }
          else if (depth === 1 && token.type === "string") literals.push(token.value);
        }
        comparisons.push({ line, operator: negated ? "NOT IN" : "IN", literals });
      }
    }
    const left = tokens[index - 1];
    if (left?.type === "op" && COMPARISON_OPERATORS.has(left.value)) {
      const literal = literalEndingAt(tokens, index - 2);
      if (literal) comparisons.push({ line, operator: left.value, literals: [literal.value] });
    }
  }
  return comparisons;
}

const hasLowerCase = (value) => /\p{Ll}/u.test(value);

/** Requirement 10.1: comparisons of TG_OP with at least one literal containing a lower-case letter. */
export function findTgOpComparisons(body, bodyLine = 1) {
  return findTgOpLiteralComparisons(body, bodyLine).filter((comparison) => comparison.literals.some(hasLowerCase));
}

/** Splits tokens at top-level occurrences of the keyword (outside parentheses). */
function splitTopLevel(tokens, keyword) {
  const parts = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.type === "punct" && token.value === "(") depth += 1;
    else if (token.type === "punct" && token.value === ")") depth -= 1;
    if (depth === 0 && isKeyword(token, keyword)) { parts.push([]); continue; }
    parts[parts.length - 1].push(token);
  }
  return parts;
}

function withoutCasts(tokens) {
  const result = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type === "punct" && tokens[index].value === "::") { index = skipCasts(tokens, index) - 1; continue; }
    result.push(tokens[index]);
  }
  return result;
}

/** A condition that is exactly one TG_OP comparison, evaluated with TG_OP = 'DELETE'; null for anything else. */
function tgOpLeafOnDelete(tokens) {
  const t = withoutCasts(tokens);
  const compare = (operator, literal) => (operator === "=" ? literal === "DELETE" : literal !== "DELETE");
  if (t.length === 3 && isTgOp(t[0]) && t[1].type === "op" && COMPARISON_OPERATORS.has(t[1].value) && t[2].type === "string") return compare(t[1].value, t[2].value);
  if (t.length === 3 && t[0].type === "string" && t[1].type === "op" && COMPARISON_OPERATORS.has(t[1].value) && isTgOp(t[2])) return compare(t[1].value, t[0].value);
  const negated = isKeyword(t[1], "not");
  const open = negated ? 3 : 2;
  if (isTgOp(t[0]) && isKeyword(t[open - 1], "in") && t[open]?.value === "(" && t[t.length - 1]?.value === ")") {
    const inner = t.slice(open + 1, -1);
    if (!inner.every((token, index) => (index % 2 === 0 ? token.type === "string" : token.value === ","))) return null;
    const includes = inner.some((token) => token.type === "string" && token.value === "DELETE");
    return negated ? !includes : includes;
  }
  return null;
}

/** Three-valued value of a PL/pgSQL condition when TG_OP = 'DELETE': true, false or null (depends on other data). */
export function conditionOnDelete(tokens) {
  const disjuncts = splitTopLevel(tokens, "or").map((part) => {
    const conjuncts = splitTopLevel(part, "and").map(unaryOnDelete);
    if (conjuncts.includes(false)) return false;
    return conjuncts.every((value) => value === true) ? true : null;
  });
  if (disjuncts.includes(true)) return true;
  return disjuncts.every((value) => value === false) ? false : null;
}

function unaryOnDelete(tokens) {
  if (!tokens.length) return null;
  if (isKeyword(tokens[0], "not")) {
    const value = unaryOnDelete(tokens.slice(1));
    return value === null ? null : !value;
  }
  if (tokens[0].value === "(" && skipParens(tokens, 0) === tokens.length) return conditionOnDelete(tokens.slice(1, -1));
  return tgOpLeafOnDelete(tokens);
}

const RAISE_LEVELS_THAT_CONTINUE = new Set(["debug", "log", "info", "notice", "warning"]);

function atStatementStart(tokens, index) {
  const previous = tokens[index - 1];
  if (!previous) return true;
  if (previous.type === "punct" && previous.value === ";") return true;
  if (previous.type === "op" && previous.value === ">>") return true;
  return ["then", "else", "loop", "begin"].some((keyword) => isKeyword(previous, keyword));
}

/**
 * The first "RETURN NEW;" that a DELETE can reach in a PL/pgSQL trigger function body, as { line }, or null.
 * IF/ELSIF/ELSE branches whose condition is decided by a TG_OP comparison are followed: a branch whose condition
 * is false for TG_OP = 'DELETE' is not reached, and a top-level IF whose branch taken on DELETE raises an
 * exception or returns ends the DELETE path. Conditions that depend on other values count as reachable.
 */
export function deleteReachesReturnNew(body, bodyLine = 1) {
  const { tokens } = lexSql(body, { startLine: bodyLine });
  const stack = [];
  let deleteEnded = false;
  const ifFrames = () => stack.filter((frame) => frame.kind === "if");
  const currentBranch = () => {
    const top = stack[stack.length - 1];
    return top?.kind === "if" ? top.branches[top.branches.length - 1] : null;
  };
  const readCondition = (from) => {
    let depth = 0;
    let caseDepth = 0;
    for (let cursor = from; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token.type === "punct" && token.value === "(") depth += 1;
      else if (token.type === "punct" && token.value === ")") depth -= 1;
      else if (isKeyword(token, "case")) caseDepth += 1;
      else if (isKeyword(token, "end") && caseDepth > 0) caseDepth -= 1;
      else if (depth === 0 && caseDepth === 0 && isKeyword(token, "then")) return { condition: tokens.slice(from, cursor), next: cursor };
    }
    return { condition: tokens.slice(from), next: tokens.length };
  };
  const reachedOnDelete = () => ifFrames().every((frame) => {
    const branches = frame.branches;
    const branch = branches[branches.length - 1];
    if (branches.slice(0, -1).some((earlier) => earlier.value === true)) return false;
    return branch.kind === "else" || branch.value !== false;
  });
  const markExit = () => {
    const branch = currentBranch();
    if (branch) branch.exits = true;
    else if (!ifFrames().length) deleteEnded = true;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isKeyword(token, "if") && atStatementStart(tokens, index)) {
      const { condition, next } = readCondition(index + 1);
      stack.push({ kind: "if", branches: [{ kind: "then", value: conditionOnDelete(condition), exits: false }] });
      index = next;
      continue;
    }
    if ((isKeyword(token, "elsif") || isKeyword(token, "elseif")) && stack[stack.length - 1]?.kind === "if") {
      const { condition, next } = readCondition(index + 1);
      stack[stack.length - 1].branches.push({ kind: "elsif", value: conditionOnDelete(condition), exits: false });
      index = next;
      continue;
    }
    if (isKeyword(token, "else") && stack[stack.length - 1]?.kind === "if") {
      stack[stack.length - 1].branches.push({ kind: "else", value: null, exits: false });
      continue;
    }
    if (isKeyword(token, "case")) { stack.push({ kind: "case", statement: atStatementStart(tokens, index) }); continue; }
    if (isKeyword(token, "end")) {
      const top = stack[stack.length - 1];
      if (isKeyword(tokens[index + 1], "if") && top?.kind === "if") {
        stack.pop();
        index += 1;
        if (!deleteEnded && !ifFrames().length) {
          // The branch a DELETE takes: the first whose condition is true, after only false ones; else ELSE.
          for (const branch of top.branches) {
            if (branch.kind === "else" || branch.value === true) { if (branch.exits) deleteEnded = true; break; }
            if (branch.value !== false) break;
          }
        }
        continue;
      }
      if (isKeyword(tokens[index + 1], "case") && top?.kind === "case") { stack.pop(); index += 1; continue; }
      if (top?.kind === "case" && !top.statement) { stack.pop(); continue; }
      continue;
    }
    if (!atStatementStart(tokens, index)) continue;
    if (isKeyword(token, "raise")) {
      const level = tokens[index + 1]?.type === "ident" ? tokens[index + 1].value.toLowerCase() : null;
      if (!level || !RAISE_LEVELS_THAT_CONTINUE.has(level)) markExit();
      continue;
    }
    if (isKeyword(token, "return")) {
      const returnsNew = isKeyword(tokens[index + 1], "new") && tokens[index + 2]?.type === "punct" && tokens[index + 2].value === ";";
      if (returnsNew && !deleteEnded && reachedOnDelete()) return { line: token.line };
      markExit();
    }
  }
  return null;
}

function sortFindings(items) {
  return items.sort((left, right) => compareFiles({ name: left.file }, { name: right.file }) || left.line - right.line);
}

/**
 * Lints migration sources [{ name, text }]. Returns { findings, errors, triggerFunctions, replaced, dataFixes,
 * deleteReturns, files }: findings are the tgop findings (Requirement 10), replaced lists the tgop findings that a
 * later same-name definition replaces, dataFixes and deleteReturns are the optional rules' findings.
 */
export function lintMigrationSources(files) {
  const errors = [];
  const valid = [];
  for (const file of files) {
    if (migrationNumber(file.name) === null) errors.push({ file: file.name, reason: `file name does not start with a numeric prefix: ${file.name}` });
    else valid.push(file);
  }
  valid.sort(compareFiles);
  const analyses = valid.map((file) => ({ file, ...analyzeFile(file) }));
  for (const analysis of analyses) errors.push(...analysis.errors);
  const defs = analyses.flatMap((analysis) => analysis.defs);
  const triggerFunctions = defs.filter((def) => def.isTrigger);

  // Requirement 10.3: replaced only by a same-name definition in a file with a strictly larger number.
  const replacementFor = (def) => defs.find((other) => other.normalizedName === def.normalizedName && other.number > def.number);
  const findings = [];
  const replaced = [];
  for (const def of triggerFunctions) {
    const comparisons = findTgOpComparisons(def.body, def.bodyLine).map((comparison) => ({ file: def.file, line: comparison.line, function: def.normalizedName, operator: comparison.operator, literals: comparison.literals }));
    if (!comparisons.length) continue;
    const replacement = replacementFor(def);
    if (replacement) replaced.push(...comparisons.map((comparison) => ({ ...comparison, replacedBy: replacement.file })));
    else findings.push(...comparisons);
  }

  const dataFixes = [];
  for (const file of valid) {
    if (migrationNumber(file.name) < BigInt(firstGuardedDataFixMigration)) continue;
    for (const violation of findUnguardedDataFixStatements(file.text.replaceAll("\r\n", "\n"))) dataFixes.push({ file: file.name, line: violation.line, statement: violation.statement });
  }

  // Effective triggers after every migration in order, and the last definition of each function.
  const triggers = new Map();
  for (const analysis of analyses) {
    for (const event of analysis.triggerEvents) {
      if (event.kind === "create") triggers.set(`${event.table}\u0000${event.name}`, event);
      else if (event.kind === "drop") triggers.delete(`${event.table}\u0000${event.name}`);
      else if (event.kind === "drop-table") for (const key of [...triggers.keys()]) if (key.startsWith(`${event.table}\u0000`)) triggers.delete(key);
    }
  }
  const latestDef = new Map();
  for (const def of defs) latestDef.set(def.normalizedName, def);
  const deleteReturns = [];
  for (const trigger of triggers.values()) {
    if (trigger.timing !== "before" || trigger.level !== "row" || !trigger.events.includes("delete") || !trigger.functionName) continue;
    const def = latestDef.get(trigger.functionName);
    if (!def?.body) continue;
    const problem = deleteReachesReturnNew(def.body, def.bodyLine);
    if (problem) deleteReturns.push({ file: def.file, line: problem.line, function: def.normalizedName, trigger: trigger.name, table: trigger.table, triggerFile: trigger.file });
  }

  return { findings: sortFindings(findings), replaced: sortFindings(replaced), errors, triggerFunctions, dataFixes: sortFindings(dataFixes), deleteReturns: sortFindings(deleteReturns), files: valid.length };
}

/** Reads every entry whose name ends in .sql: { files: [{ name, text }], errors }. */
export async function readMigrationDirectory(directory) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { files: [], errors: [{ file: null, reason: `directory not found: ${directory}` }] };
    return { files: [], errors: [{ file: null, reason: `cannot read directory ${directory}: ${error?.code ?? error}` }] };
  }
  const sqlNames = names.filter((name) => name.endsWith(".sql")).sort();
  if (!sqlNames.length) return { files: [], errors: [{ file: null, reason: `no .sql files in ${directory}` }] };
  const files = [];
  const errors = [];
  for (const name of sqlNames) {
    try {
      files.push({ name, text: await readFile(path.join(directory, name), "utf8") });
    } catch (error) {
      errors.push({ file: name, reason: `cannot read ${name}: ${error?.code ?? error}` });
    }
  }
  return { files, errors };
}

function parseArguments(argv) {
  const options = { migrationsDir: DEFAULT_MIGRATIONS_DIR, rules: ["tgop"], verbose: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--migrations-dir") {
      if (!argv[index + 1]) throw new Error("--migrations-dir requires a directory");
      options.migrationsDir = path.resolve(argv[index + 1]);
      index += 1;
    } else if (argument === "--rules") {
      const rules = String(argv[index + 1] ?? "").split(",").map((rule) => rule.trim()).filter(Boolean);
      const unknown = rules.filter((rule) => !RULES.includes(rule));
      if (!rules.length || unknown.length) throw new Error(`--rules takes a comma-separated subset of ${RULES.join(", ")}`);
      options.rules = rules;
      index += 1;
    } else if (argument === "--all-rules") {
      options.rules = [...RULES];
    } else if (argument === "--verbose") {
      options.verbose = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`ERROR migration-lint ${error.message}\n`);
    return 2;
  }
  const directory = await readMigrationDirectory(options.migrationsDir);
  const result = lintMigrationSources(directory.files);
  const errors = sortFindings([...directory.errors, ...result.errors].map((error) => ({ ...error, file: error.file ?? "", line: error.line ?? 0 })));
  const out = [];
  let findingCount = 0;
  const rules = new Set(options.rules);
  if (rules.has("tgop")) {
    if (options.verbose) for (const item of result.replaced) out.push(`REPLACED ${item.file}:${item.line} function=${item.function} operator="${item.operator}" literals=${item.literals.map((literal) => `'${literal}'`).join(",")} replaced-by=${item.replacedBy}`);
    for (const finding of result.findings) out.push(`TGOP ${finding.file}:${finding.line} function=${finding.function} operator="${finding.operator}" literals=${finding.literals.map((literal) => `'${literal}'`).join(",")}`);
    if (result.findings.length) out.push(`FAIL  ${result.findings.length} lower-case TG_OP comparison(s)`);
    else if (!errors.length) out.push(`PASS  ${result.triggerFunctions.length} trigger functions in ${result.files} migration files compare TG_OP only with upper-case literals`);
    findingCount += result.findings.length;
  }
  if (rules.has("datafix")) {
    for (const item of result.dataFixes) out.push(`DATAFIX ${item.file}:${item.line} ${item.statement.split("\n")[0].trim().slice(0, 120)}`);
    if (result.dataFixes.length) out.push(`FAIL  ${result.dataFixes.length} data-fix statement(s) in migrations numbered >= ${String(firstGuardedDataFixMigration).padStart(3, "0")} bypass migration_fix_update, migration_fix_delete or migration_fix_insert`);
    else if (!errors.length) out.push(`PASS  migrations numbered >= ${String(firstGuardedDataFixMigration).padStart(3, "0")} change existing rows only through migration_fix_*`);
    findingCount += result.dataFixes.length;
  }
  if (rules.has("before-delete-return")) {
    for (const item of result.deleteReturns) out.push(`DELRET ${item.file}:${item.line} function=${item.function} trigger=${item.trigger} table=${item.table} can return NEW on DELETE in a BEFORE ROW trigger`);
    if (result.deleteReturns.length) out.push(`FAIL  ${result.deleteReturns.length} BEFORE ROW DELETE trigger function(s) return NEW on DELETE`);
    else if (!errors.length) out.push("PASS  no BEFORE ROW DELETE trigger function can return NEW when TG_OP is 'DELETE'");
    findingCount += result.deleteReturns.length;
  }
  if (out.length) stdout.write(`${out.join("\n")}\n`);
  for (const error of errors) stderr.write(`ERROR migration-lint ${error.reason}\n`);
  if (errors.length) return 2;
  return findingCount ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
