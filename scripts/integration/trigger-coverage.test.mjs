// Trigger case execution and coverage enumeration (design part 8, section 2.1 "触发器覆盖", Requirement
// 36.7-36.9). Every case in scripts/integration/trigger-cases/ runs as its own subtest; a failing case does not
// stop the others. Missing combinations are reported as diagnostics only: the failing `coverage` subtest is
// added once every combination has a passing case (tasks.md 11.3).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { createHarness, MIGRATIONS_DIR, runTriggerCase } from "./harness.mjs";
import { decodeTriggerRows, loadTriggerCases, missingTriggerCases, staleTriggerCases, TRIGGER_CATALOGUE_SQL, TriggerNotObservedError, validateTriggerCases } from "./lib/trigger-coverage.mjs";

const cases = await loadTriggerCases();
let h;
let catalogue;
let required;
const passed = [];

before(async () => {
  h = await createHarness(import.meta.url);
  catalogue = await h.snapshot(TRIGGER_CATALOGUE_SQL);
  required = decodeTriggerRows(catalogue);
});
after(async () => { await h?.close(); });

test("the trigger catalogue has no WHEN-qualified row trigger without a dedicated case", () => {
  const qualified = catalogue.filter((row) => row.has_when).map((row) => `${row.table_name}.${row.trigger_name}`);
  assert.deepEqual(qualified, [], `triggers with a WHEN clause need their own cases: ${qualified.join(", ")}`);
});

test("every trigger case has a valid shape", () => {
  assert.deepEqual(validateTriggerCases(cases, { required }), []);
});

describe("trigger cases", () => {
  for (const triggerCase of cases) {
    test(triggerCase.id, async () => {
      await runTriggerCase(h, triggerCase);
      passed.push(triggerCase);
    });
  }
});

test("stale-cases: every case points at an existing (table, trigger, op)", (t) => {
  const stale = staleTriggerCases(required, cases);
  for (const triggerCase of stale) t.diagnostic(`STALE ${triggerCase.id}`);
  assert.deepEqual(stale.map((triggerCase) => `STALE ${triggerCase.id}`), []);
});

test("coverage report: combinations without a passing case (reported, not enforced yet)", (t) => {
  const missing = missingTriggerCases(required, passed);
  const combos = required.length;
  t.diagnostic(`trigger coverage: ${combos - missing.length}/${combos} combinations of ${new Set(required.map((r) => `${r.table}.${r.trigger}`)).size} row triggers have a passing case (${passed.length}/${cases.length} cases passed)`);
  for (const { table, trigger, op } of missing) t.diagnostic(`MISSING ${table} ${trigger} ${op}`);
  assert.ok(required.length > 0, "the catalogue must list row triggers");
});

test("applying only migrations 001-067 yields the 33 triggers and 72 combinations of the design baseline", async () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
  const baseline = files.filter((name) => Number(name.slice(0, 3)) <= 67).length;
  const empty = await h.createEmptyDatabase({ owner: "migration_owner" });
  const migrated = await h.migrate({ as: "migration_owner", database: empty.name, migrationsDir: await h.migrationsSubset(baseline) });
  assert.equal(migrated.status, 0, migrated.stderr);
  const admin = await empty.admin();
  try {
    const rows = (await admin.query(TRIGGER_CATALOGUE_SQL)).rows;
    const combinations = decodeTriggerRows(rows);
    assert.equal(rows.length, 33, `row triggers after ${baseline} migrations`);
    assert.equal(combinations.length, 72, "(table, trigger, op) combinations after 001-067");
  } finally {
    await admin.end();
  }
});

describe("runTriggerCase self-test", () => {
  // Each case creates its own table and trigger inside the case transaction, so the rollback removes them.
  const table = `it_runner_${randomUUID().slice(0, 8)}`;
  const arrange = async ({ client }) => {
    await client.query(`create table ${table} (id int primary key, note text not null)`);
    await client.query(`create function ${table}_guard() returns trigger language plpgsql as $$ begin if new.note = 'bad' then raise exception 'runner self-test rejects bad notes'; end if; return new; end $$`);
    await client.query(`create trigger ${table}_guard before insert or update on ${table} for each row execute function ${table}_guard()`);
    await client.query(`create sequence ${table}_seq`);
    return {};
  };
  const base = { table, trigger: `${table}_guard`, arrange, readBack: () => ({ sql: `select id, note from ${table} order by id`, params: [] }) };

  test("an accepted statement that fires the trigger passes", async () => {
    const result = await runTriggerCase(h, { ...base, id: "self.accept", op: "INSERT", expect: "accept", act: () => ({ sql: `insert into ${table} values (1, 'good')`, params: [] }), expectedAfter: () => [{ id: 1, note: "good" }] });
    assert.equal(result.outcome, "accepted");
  });

  test("a reject case with a different message fails", async () => {
    await assert.rejects(runTriggerCase(h, { ...base, id: "self.message", op: "INSERT", expect: "reject", message: "some other text", act: () => ({ sql: `insert into ${table} values (1, 'bad')`, params: [] }) }), (error) => error instanceof assert.AssertionError && /expected an error containing "some other text"/.test(error.message));
  });

  test("a reject case whose read-back differs after the rollback fails", async () => {
    const drifting = { ...base, readBack: () => ({ sql: `select nextval('${table}_seq') as n`, params: [] }) };
    await assert.rejects(runTriggerCase(h, { ...drifting, id: "self.readback", op: "INSERT", expect: "reject", message: "runner self-test rejects bad notes", act: () => ({ sql: `insert into ${table} values (1, 'bad')`, params: [] }) }), (error) => error instanceof assert.AssertionError && /rows changed although the statement was rejected/.test(error.message));
  });

  test("an accept case whose trigger function is not called reports TRIGGER-NOT-OBSERVED", async () => {
    await assert.rejects(runTriggerCase(h, { ...base, id: "self.unobserved", op: "DELETE", expect: "accept", expectedRowCount: 1, arrange: async (ctx) => { await arrange(ctx); await ctx.client.query(`alter table ${table} disable trigger ${table}_guard`); await ctx.client.query(`insert into ${table} values (1, 'good')`); await ctx.client.query(`alter table ${table} enable trigger ${table}_guard`); return {}; }, act: () => ({ sql: `delete from ${table} where id = 1`, params: [] }), expectedAfter: () => [] }), (error) => error instanceof TriggerNotObservedError && /^TRIGGER-NOT-OBSERVED self\.unobserved/.test(error.message));
  });
});
