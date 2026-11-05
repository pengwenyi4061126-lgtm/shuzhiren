// Trigger case framework (design part 8, section 2.1 "触发器覆盖", 2.3, 2.4): pure functions to decode the
// trigger catalogue and compute coverage, a shape validator for TriggerCase objects, and the case runner.
// This module does not import pg, so the pure functions run locally (scripts/test-integration-lib.mjs).
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TRIGGER_OPS = Object.freeze(["INSERT", "UPDATE", "DELETE"]);
export const CASE_ROLES = Object.freeze(["control_plane", "runtime_worker", "channel_adapter", "alert_notifier", "migration_owner"]);

/** Every row-level, non-internal trigger with its tgtype, update columns and WHEN flag. */
export const TRIGGER_CATALOGUE_SQL = `
select n.nspname as schema, c.relname as table_name, t.tgname as trigger_name, t.tgfoid::int8 as tgfoid, p.proname as function_name,
       t.tgtype::int as tgtype,
       coalesce(array(select a.attname::text from unnest(t.tgattr::int2[]) k join pg_attribute a
                      on a.attrelid = t.tgrelid and a.attnum = k), '{}') as update_columns,
       t.tgqual is not null as has_when
from pg_trigger t
join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
where not t.tgisinternal and (t.tgtype & 1) = 1
order by 1, 2, 3`;

/** Decodes pg_trigger.tgtype (TRIGGER_TYPE_* bits of pg_trigger.h). */
export function decodeTgtype(tgtype) {
  const value = Number(tgtype);
  if (!Number.isInteger(value) || value < 0 || value > 0x7fff) throw new RangeError(`tgtype must be a 16-bit unsigned integer, found ${tgtype}`);
  const before = (value & 2) !== 0;
  const insteadOf = (value & 64) !== 0;
  return {
    row: (value & 1) !== 0,
    before,
    insteadOf,
    after: !before && !insteadOf,
    insert: (value & 4) !== 0,
    delete: (value & 8) !== 0,
    update: (value & 16) !== 0,
    truncate: (value & 32) !== 0
  };
}

/**
 * Catalogue rows → the required combinations R: one entry per (table, trigger, op) for every row-level
 * trigger, ops in INSERT, UPDATE, DELETE order. Tables outside `public` are written `schema.table`.
 * @returns {Array<{ table: string, trigger: string, op: string, updateColumns: string[], functionName: string, tgfoid: number, timing: string, hasWhen: boolean }>}
 */
export function decodeTriggerRows(rows) {
  const required = [];
  for (const row of rows) {
    const type = decodeTgtype(row.tgtype);
    if (!type.row) continue;
    const table = !row.schema || row.schema === "public" ? row.table_name : `${row.schema}.${row.table_name}`;
    const timing = type.before ? "BEFORE" : type.insteadOf ? "INSTEAD OF" : "AFTER";
    const updateColumns = [...(row.update_columns ?? [])];
    for (const op of TRIGGER_OPS) {
      if (!type[op.toLowerCase()]) continue;
      required.push({ table, trigger: row.trigger_name, op, updateColumns: op === "UPDATE" ? updateColumns : [], functionName: row.function_name, tgfoid: Number(row.tgfoid), timing, hasWhen: Boolean(row.has_when) });
    }
  }
  return required.sort(compareCombination);
}

export const combinationKey = ({ table, trigger, op }) => `${table}\u0000${trigger}\u0000${op}`;
export function compareCombination(left, right) {
  return left.table.localeCompare(right.table) || left.trigger.localeCompare(right.trigger) || TRIGGER_OPS.indexOf(left.op) - TRIGGER_OPS.indexOf(right.op);
}

/** True when `triggerCase` counts for `combination` (UPDATE OF triggers need an overlapping updatedColumns). */
export function caseCovers(triggerCase, combination) {
  if (triggerCase.table !== combination.table || triggerCase.trigger !== combination.trigger || triggerCase.op !== combination.op) return false;
  if (combination.op !== "UPDATE" || combination.updateColumns.length === 0) return true;
  return (triggerCase.updatedColumns ?? []).some((column) => combination.updateColumns.includes(column));
}

/** R minus the combinations a passed case covers, sorted by (table, trigger, op). */
export function missingTriggerCases(required, passed) {
  return required
    .filter((combination) => !passed.some((triggerCase) => caseCovers(triggerCase, combination)))
    .map(({ table, trigger, op }) => ({ table, trigger, op }))
    .sort(compareCombination);
}

/** Cases whose (table, trigger, op) is not in R (trigger renamed or dropped). */
export function staleTriggerCases(required, cases) {
  const keys = new Set(required.map(combinationKey));
  return cases.filter((triggerCase) => !keys.has(combinationKey(triggerCase)));
}

/**
 * Shape check: unique id, legal op and expect, reject has message, accept has expectedAfter, functions present,
 * `as` among CASE_ROLES, and (when `required` is given) UPDATE cases on an UPDATE OF trigger declare an
 * overlapping updatedColumns. Returns one message per problem.
 */
export function validateTriggerCases(cases, { required } = {}) {
  const problems = [];
  const seen = new Set();
  if (!Array.isArray(cases)) return ["trigger cases must be an array"];
  cases.forEach((triggerCase, index) => {
    const where = typeof triggerCase?.id === "string" && triggerCase.id ? triggerCase.id : `case[${index}]`;
    if (triggerCase === null || typeof triggerCase !== "object") { problems.push(`${where} is not an object`); return; }
    if (typeof triggerCase.id !== "string" || !/^[a-z0-9_.:-]+$/.test(triggerCase.id)) problems.push(`${where} id must be a non-empty [a-z0-9_.:-] string`);
    else if (seen.has(triggerCase.id)) problems.push(`${where} duplicates id ${triggerCase.id}`);
    else seen.add(triggerCase.id);
    for (const field of ["table", "trigger"]) if (typeof triggerCase[field] !== "string" || !triggerCase[field]) problems.push(`${where} has no ${field}`);
    if (!TRIGGER_OPS.includes(triggerCase.op)) problems.push(`${where} op must be one of ${TRIGGER_OPS.join(", ")}`);
    if (triggerCase.expect !== "accept" && triggerCase.expect !== "reject") problems.push(`${where} expect must be accept or reject`);
    if (triggerCase.expect === "reject" && (typeof triggerCase.message !== "string" || !triggerCase.message)) problems.push(`${where} reject case needs a message`);
    if (triggerCase.expect === "accept" && typeof triggerCase.expectedAfter !== "function") problems.push(`${where} accept case needs expectedAfter`);
    if (triggerCase.expect === "accept" && triggerCase.expectedRowCount !== undefined && !(Number.isInteger(triggerCase.expectedRowCount) && triggerCase.expectedRowCount >= 1)) problems.push(`${where} expectedRowCount must be an integer >= 1`);
    for (const field of ["arrange", "act", "readBack"]) if (typeof triggerCase[field] !== "function") problems.push(`${where} ${field} must be a function`);
    if (triggerCase.as !== undefined && !CASE_ROLES.includes(triggerCase.as)) problems.push(`${where} as must be one of ${CASE_ROLES.join(", ")}`);
    if (triggerCase.messageExcludes !== undefined && !(triggerCase.expect === "reject" && Array.isArray(triggerCase.messageExcludes) && triggerCase.messageExcludes.every((text) => typeof text === "string" && text))) problems.push(`${where} messageExcludes must be a non-empty string array on a reject case`);
    if (triggerCase.updatedColumns !== undefined && !(Array.isArray(triggerCase.updatedColumns) && triggerCase.updatedColumns.every((column) => typeof column === "string" && column))) problems.push(`${where} updatedColumns must be an array of column names`);
    if (triggerCase.op === "UPDATE" && required) {
      const combination = required.find((candidate) => combinationKey(candidate) === combinationKey(triggerCase));
      if (combination && combination.updateColumns.length > 0 && !caseCovers(triggerCase, combination)) problems.push(`${where} must declare updatedColumns overlapping ${combination.updateColumns.join(", ")}`);
    }
  });
  return problems;
}

const normalizeValue = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (typeof value === "bigint") return value.toString();
  return value;
};
const normalizeRow = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]));
/** Keeps only the columns listed in the matching expected row. */
export function pickColumns(rows, expected) {
  return rows.map((row, index) => {
    const keys = Object.keys(expected[index] ?? row);
    return Object.fromEntries(keys.map((key) => [key, normalizeValue(row[key])]));
  });
}

export class TriggerNotObservedError extends assert.AssertionError {
  constructor(id, detail) {
    super({ message: `TRIGGER-NOT-OBSERVED ${id}: ${detail}` });
  }
}

export const TRIGGER_CASES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "trigger-cases");

/**
 * Imports every scripts/integration/trigger-cases/*.mjs module except index.mjs and returns their default
 * exports (TriggerCase arrays) flattened, each case tagged with its module file name.
 */
export async function loadTriggerCases(directory = TRIGGER_CASES_DIR) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".mjs") && name !== "index.mjs").sort();
  const cases = [];
  for (const name of names) {
    const module = await import(pathToFileURL(path.join(directory, name)).href);
    if (!Array.isArray(module.default)) throw new TypeError(`trigger case module ${name} must export a TriggerCase[] as default`);
    for (const triggerCase of module.default) cases.push({ ...triggerCase, module: name });
  }
  return cases;
}

function splitTable(table) {
  const [schema, name] = table.includes(".") ? table.split(".", 2) : ["public", table];
  return { schema, name };
}

/**
 * Runs one TriggerCase in its own superuser transaction on the harness database (section 2.1 steps 1-6) and
 * throws an AssertionError when the case does not hold. `beforeAct(ctx, arranged)` runs after the role switch
 * and tenant setting, right before act (cross-part ruling 3). Errors from arrange are rethrown unchanged.
 * @param {{ connectAs(principal: string): Promise<import("pg").Client>, seed: object, principals: Record<string, string|null> }} h
 */
export async function runTriggerCase(h, triggerCase, { beforeAct } = {}) {
  const client = await h.connectAs("superuser", { applicationName: `shz-it-trigger-${triggerCase.id}` });
  const ctx = { client, seed: h.seedFor(client), ids: {} };
  try {
    await client.query("begin");
    await client.query("set local track_functions = 'pl'");
    const arranged = (await triggerCase.arrange(ctx)) ?? {};
    // Looked up after arrange, so a case may create its own table and trigger inside the case transaction.
    const { schema, name } = splitTable(triggerCase.table);
    const trigger = await client.query("select t.tgfoid::int8 as tgfoid from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2 and t.tgname = $3 and not t.tgisinternal", [schema, name, triggerCase.trigger]);
    assert.equal(trigger.rows.length, 1, `${triggerCase.id}: trigger ${triggerCase.trigger} on ${triggerCase.table} does not exist`);
    const tgfoid = trigger.rows[0].tgfoid;
    const replica = await client.query("select current_setting('session_replication_role') as value");
    assert.equal(replica.rows[0].value, "origin", `${triggerCase.id}: arrange must restore session_replication_role to origin before act`);
    await client.query("savepoint trigger_case");
    const readBack = async () => {
      const { sql, params = [] } = triggerCase.readBack(ctx, arranged);
      return (await client.query(sql, params)).rows.map(normalizeRow);
    };
    const calls = async () => (await client.query("select pg_stat_get_xact_function_calls($1::oid) as calls", [tgfoid])).rows[0].calls;
    const before = await readBack();
    const calls0 = await calls();
    if (triggerCase.as) {
      const role = h.principals[triggerCase.as];
      assert.ok(role, `${triggerCase.id}: unknown role alias ${triggerCase.as}`);
      await client.query(`set local role "${role.replace(/"/g, '""')}"`);
    }
    if (triggerCase.tenantContext) {
      assert.ok(arranged.tenantId, `${triggerCase.id}: tenantContext needs arranged.tenantId`);
      await client.query("select set_config('app.tenant_id', $1, true)", [arranged.tenantId]);
    }
    if (beforeAct) await beforeAct(ctx, arranged);
    const { sql, params = [] } = triggerCase.act(ctx, arranged);
    let result;
    let failure;
    try {
      result = await client.query(sql, params);
    } catch (error) {
      failure = error;
    }
    if (triggerCase.expect === "reject") {
      assert.ok(failure, `${triggerCase.id}: expected the ${triggerCase.op} to be rejected with "${triggerCase.message}", but it succeeded (rowCount ${result?.rowCount})`);
      assert.ok(String(failure.message).includes(triggerCase.message), `${triggerCase.id}: expected an error containing "${triggerCase.message}", got "${failure.message}"`);
      for (const excluded of triggerCase.messageExcludes ?? []) assert.ok(!String(failure.message).includes(excluded), `${triggerCase.id}: the error must not contain "${excluded}", got "${failure.message}"`);
      await client.query("rollback to savepoint trigger_case");
      assert.deepEqual(await readBack(), before, `${triggerCase.id}: rows changed although the statement was rejected`);
      return { id: triggerCase.id, outcome: "rejected", error: failure.message };
    }
    if (failure) throw new assert.AssertionError({ message: `${triggerCase.id}: expected the ${triggerCase.op} to be accepted, but it failed: ${failure.message}` });
    const expectedRowCount = triggerCase.expectedRowCount ?? 1;
    assert.equal(result.rowCount, expectedRowCount, `${triggerCase.id}: rowCount`);
    await client.query("reset role");
    const after = await readBack();
    const expected = triggerCase.expectedAfter(arranged).map(normalizeRow);
    assert.deepEqual(pickColumns(after, expected), expected, `${triggerCase.id}: rows after the accepted ${triggerCase.op}`);
    const calls1 = await calls();
    if (calls1 === null || calls1 === undefined) throw new TriggerNotObservedError(triggerCase.id, "pg_stat_get_xact_function_calls returned null (track_functions not in effect?)");
    if (!(Number(calls1) > Number(calls0 ?? 0))) throw new TriggerNotObservedError(triggerCase.id, `function call count did not increase (${calls0 ?? 0} → ${calls1})`);
    return { id: triggerCase.id, outcome: "accepted", rowCount: result.rowCount };
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
