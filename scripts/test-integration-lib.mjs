// npm run integration:lib:test — the parts of the PostgreSQL integration harness that run without a database
// (tasks.md 6.1, 6.4): url() derivation (Property 145), database name length, psql variable substitution, the
// trigger coverage functions (Properties 147-149), trigger case shapes, and the runner's exit code 2 when
// DATABASE_URL is missing or unreachable (Requirement 1.4). fast-check runs with a fixed seed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import pgConnectionString from "pg-connection-string";
import {
  databaseNameFor, deriveUrl, fileSlug, MAX_IDENTIFIER_BYTES, newRunId, PRINCIPALS, PsqlScriptError, redact, roleAttributeProblems,
  ROLE_SPECS, roleStatements, substitutePsqlVariables, templateName, temporaryRoleName, truncateUtf8, UNREPRESENTABLE_DATABASE_CHARS
} from "./integration/lib/cluster.mjs";
import { caseCovers, decodeTgtype, decodeTriggerRows, loadTriggerCases, missingTriggerCases, staleTriggerCases, validateTriggerCases } from "./integration/lib/trigger-coverage.mjs";

const SEED = 20261105;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "scripts", "run-postgres-integration.mjs");
const { parse } = pgConnectionString;

const identifierText = fc.string({ unit: "grapheme", minLength: 1, maxLength: 40 });
const baseUrl = fc.record({
  host: fc.constantFrom("localhost", "127.0.0.1", "db.internal.example", "[::1]"),
  port: fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
  database: fc.stringMatching(/^[a-z][a-z0-9_]{0,20}$/),
  query: fc.dictionary(fc.constantFrom("sslmode", "connect_timeout", "options", "keepalives", "target_session_attrs"), fc.stringMatching(/^[A-Za-z0-9_=-]{1,12}$/), { maxKeys: 3 })
}).map(({ host, port, database, query }) => {
  if (query.sslmode !== undefined) query.sslmode = ["disable", "no-verify", "verify-full"][query.sslmode.length % 3];
  const search = new URLSearchParams(query).toString();
  return `postgresql://postgres:secret@${host}${port ? `:${port}` : ""}/${database}${search ? `?${search}` : ""}`;
});
const withoutIdentity = (config) => {
  const { user, password, database, application_name: _app, ...rest } = config;
  return JSON.parse(JSON.stringify(rest));
};

const databaseText = identifierText.filter((name) => !UNREPRESENTABLE_DATABASE_CHARS.test(name));

test("Property 145: url() keeps host, port and query parameters and sets user, password and database", () => {
  fc.assert(fc.property(baseUrl, fc.oneof(fc.constantFrom(...Object.values(PRINCIPALS).filter(Boolean)), identifierText), identifierText, databaseText, fc.option(identifierText, { nil: undefined }), (base, user, password, database, applicationName) => {
    const derived = deriveUrl(base, { user, password, database, applicationName });
    const before = parse(base);
    const after = parse(derived);
    assert.equal(after.host, before.host);
    assert.equal(after.port, before.port);
    assert.deepEqual(withoutIdentity(after), withoutIdentity(before));
    assert.equal(after.user, user);
    assert.equal(after.password, password);
    assert.equal(after.database, database);
    const original = new URL(base).searchParams;
    const changed = new URL(derived).searchParams;
    for (const [key, value] of original) assert.equal(changed.get(key), value, key);
    if (applicationName !== undefined) {
      assert.equal(changed.get("application_name"), truncateUtf8(applicationName));
      assert.ok(Buffer.byteLength(changed.get("application_name"), "utf8") <= MAX_IDENTIFIER_BYTES);
    }
  }), { seed: SEED, numRuns: 300 });
  // node-postgres decodes the path with decodeURI, so names with reserved characters are refused up front.
  for (const name of ["a#b", "a/b", "a?b", "a@b"]) assert.throws(() => deriveUrl("postgresql://u:p@h/db", { database: name }), /cannot decode/);
});

test("database and role names stay within 63 bytes for any test file name", () => {
  const runId = newRunId(new Date("2026-11-05T01:02:03Z"), Buffer.from([0xab, 0xcd]));
  assert.equal(runId, "20261105010203_abcd");
  assert.equal(templateName(runId), "shz_it_20261105010203_abcd_tpl");
  fc.assert(fc.property(fc.string({ unit: "grapheme", maxLength: 200 }), fc.integer({ min: 1, max: 2 ** 40 }), (name, counter) => {
    const suffix = counter.toString(36);
    const database = databaseNameFor(runId, `${name}.test.mjs`, suffix);
    assert.ok(Buffer.byteLength(database, "utf8") <= MAX_IDENTIFIER_BYTES, database);
    assert.match(database, /^shz_it_20261105010203_abcd_[a-z0-9_]+_[a-z0-9]+$/);
    const role = temporaryRoleName(runId, suffix, name);
    assert.ok(Buffer.byteLength(role, "utf8") <= MAX_IDENTIFIER_BYTES, role);
  }), { seed: SEED, numRuns: 300 });
  assert.notEqual(fileSlug("a-very-long-integration-test-file-name-one.test.mjs"), fileSlug("a-very-long-integration-test-file-name-two.test.mjs"));
  assert.equal(truncateUtf8("数".repeat(30)).length, 21);
});

test("psql variable substitution accepts only :\"control_plane_role\"", () => {
  const sql = "-- uses :\"control_plane_role\" in a comment\ngrant select on t to :\"control_plane_role\";\nselect '::text :x', $$ :\"other\" $$, $tag$ \\x $tag$, x::int, \"a:b\";";
  assert.equal(substitutePsqlVariables(sql), "-- uses :\"control_plane_role\" in a comment\ngrant select on t to \"shuzhiren_control_plane\";\nselect '::text :x', $$ :\"other\" $$, $tag$ \\x $tag$, x::int, \"a:b\";");
  for (const bad of ["grant select on t to :\"other_role\";", "grant select on t to :role;", "select :'literal';", "\\set role x", "select 1;\n\\i other.sql", "select :{?role};"]) {
    assert.throws(() => substitutePsqlVariables(bad), PsqlScriptError, bad);
  }
  assert.throws(() => substitutePsqlVariables("select 'unterminated"), PsqlScriptError);
});

test("role statements write every attribute and the attribute check reports each difference", () => {
  for (const spec of ROLE_SPECS) {
    const [create, alter] = roleStatements(spec, "A".repeat(32));
    assert.match(create, new RegExp(`create role "${spec.name}" login noinherit nosuperuser nocreatedb nocreaterole noreplication ${spec.bypassRls ? "bypassrls" : "nobypassrls"};`));
    assert.equal(alter, `alter role "${spec.name}" with login noinherit nosuperuser nocreatedb nocreaterole noreplication ${spec.bypassRls ? "bypassrls" : "nobypassrls"} password '${"A".repeat(32)}'`);
  }
  assert.throws(() => roleStatements(ROLE_SPECS[0], "short'"), /unexpected format/);
  const good = ROLE_SPECS.map((spec) => ({ rolname: spec.name, rolcanlogin: true, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: spec.bypassRls, memberships: 0 }));
  assert.deepEqual(roleAttributeProblems(good), []);
  const bad = good.map((row) => (row.rolname === PRINCIPALS.runtime_worker ? { ...row, rolbypassrls: true, memberships: 1 } : row)).filter((row) => row.rolname !== PRINCIPALS.backup);
  assert.deepEqual(roleAttributeProblems(bad), ["shuzhiren_runtime_worker rolbypassrls is true, expected false", "shuzhiren_runtime_worker is a member of 1 role(s)", "shuzhiren_backup is missing"]);
  assert.equal(redact("postgresql://u:p%40ss@h/db and p@ss", ["p@ss"]), "postgresql://u:[redacted]@h/db and [redacted]");
});

// Property 149: decodeTgtype agrees with the TRIGGER_TYPE_* bit definitions for every 16-bit value.
test("Property 149: tgtype decoding matches the pg_trigger bit layout", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 0x7fff }), (tgtype) => {
    const type = decodeTgtype(tgtype);
    assert.equal(type.row, (tgtype & 1) === 1);
    assert.equal(type.before, (tgtype & 2) === 2);
    assert.equal(type.insert, (tgtype & 4) === 4);
    assert.equal(type.delete, (tgtype & 8) === 8);
    assert.equal(type.update, (tgtype & 16) === 16);
    assert.equal(type.truncate, (tgtype & 32) === 32);
    assert.equal(type.insteadOf, (tgtype & 64) === 64);
    assert.equal(type.after, !type.before && !type.insteadOf);
    const combos = decodeTriggerRows([{ schema: "public", table_name: "t", trigger_name: "g", tgfoid: 1, function_name: "f", tgtype, update_columns: ["c"], has_when: false }]);
    const expectedOps = type.row ? ["INSERT", "UPDATE", "DELETE"].filter((op) => type[op.toLowerCase()]) : [];
    assert.deepEqual(combos.map((combo) => combo.op), expectedOps);
  }), { seed: SEED, numRuns: 500 });
  assert.throws(() => decodeTgtype(-1), RangeError);
  assert.deepEqual(decodeTriggerRows([{ schema: "audit", table_name: "t", trigger_name: "g", tgfoid: 1, function_name: "f", tgtype: 1 | 2 | 16, update_columns: ["a"], has_when: false }])[0], { table: "audit.t", trigger: "g", op: "UPDATE", updateColumns: ["a"], functionName: "f", tgfoid: 1, timing: "BEFORE", hasWhen: false });
});

const combination = fc.record({ table: fc.constantFrom("a", "b", "c"), trigger: fc.constantFrom("t1", "t2"), op: fc.constantFrom("INSERT", "UPDATE", "DELETE"), updateColumns: fc.subarray(["x", "y", "z"]) });
const triggerCase = fc.record({ table: fc.constantFrom("a", "b", "c"), trigger: fc.constantFrom("t1", "t2"), op: fc.constantFrom("INSERT", "UPDATE", "DELETE"), updatedColumns: fc.option(fc.subarray(["x", "y", "z"]), { nil: undefined }) });

// Property 147: missingTriggerCases returns exactly the required combinations no passed case covers, sorted.
// Property 148: adding a covering case never adds a missing entry (monotonic), and an empty R has no gaps.
test("Properties 147-148: missingTriggerCases is exact, sorted and monotonic", () => {
  fc.assert(fc.property(fc.array(combination, { maxLength: 12 }), fc.array(triggerCase, { maxLength: 12 }), triggerCase, (required, passed, extra) => {
    const missing = missingTriggerCases(required, passed);
    const expected = required.filter((combo) => !passed.some((c) => caseCovers(c, combo))).map(({ table, trigger, op }) => `${table}|${trigger}|${op}`);
    assert.deepEqual(missing.map(({ table, trigger, op }) => `${table}|${trigger}|${op}`).sort(), expected.sort());
    const order = ["INSERT", "UPDATE", "DELETE"];
    for (let index = 1; index < missing.length; index += 1) {
      const [left, right] = [missing[index - 1], missing[index]];
      assert.ok(left.table < right.table || (left.table === right.table && (left.trigger < right.trigger || (left.trigger === right.trigger && order.indexOf(left.op) <= order.indexOf(right.op)))), "sorted");
    }
    assert.ok(missingTriggerCases(required, [...passed, extra]).length <= missing.length);
    assert.deepEqual(missingTriggerCases([], passed), []);
    for (const combo of required) {
      const covered = passed.some((c) => caseCovers(c, combo));
      if (combo.op === "UPDATE" && combo.updateColumns.length > 0 && covered) assert.ok(passed.some((c) => c.table === combo.table && c.trigger === combo.trigger && c.op === "UPDATE" && (c.updatedColumns ?? []).some((column) => combo.updateColumns.includes(column))));
    }
    const stale = staleTriggerCases(required, passed);
    for (const c of stale) assert.ok(!required.some((combo) => combo.table === c.table && combo.trigger === c.trigger && combo.op === c.op));
  }), { seed: SEED, numRuns: 500 });
});

test("trigger case modules in the repository have a valid shape; malformed cases are reported", async () => {
  const cases = await loadTriggerCases();
  assert.ok(cases.length > 0);
  assert.deepEqual(validateTriggerCases(cases), []);
  const modules = new Set(cases.map((c) => c.module));
  for (const name of ["approved-insert.mjs", "audit-chain.mjs", "channel-connections.mjs", "memberships.mjs", "settlement.mjs"]) assert.ok(modules.has(name), name);
  const noop = () => ({ sql: "select 1", params: [] });
  const valid = { id: "x.accept", table: "t", trigger: "g", op: "UPDATE", expect: "accept", arrange: async () => ({}), act: noop, readBack: noop, expectedAfter: () => [] };
  const problems = validateTriggerCases([
    valid,
    { ...valid },
    { ...valid, id: "x.reject", expect: "reject", expectedAfter: undefined },
    { ...valid, id: "x.op", op: "TRUNCATE" },
    { ...valid, id: "x.after", expectedAfter: undefined },
    { ...valid, id: "x.role", as: "superuser" },
    { ...valid, id: "x.cols", updatedColumns: ["y"] }
  ], { required: [{ table: "t", trigger: "g", op: "UPDATE", updateColumns: ["x"] }] });
  assert.deepEqual(problems, [
    "x.accept must declare updatedColumns overlapping x",
    "x.accept duplicates id x.accept",
    "x.accept must declare updatedColumns overlapping x",
    "x.reject reject case needs a message",
    "x.reject must declare updatedColumns overlapping x",
    "x.op op must be one of INSERT, UPDATE, DELETE",
    "x.after accept case needs expectedAfter",
    "x.after must declare updatedColumns overlapping x",
    "x.role as must be one of control_plane, runtime_worker, channel_adapter, alert_notifier, migration_owner",
    "x.role must declare updatedColumns overlapping x",
    "x.cols must declare updatedColumns overlapping x"
  ]);
});

function runRunner(env) {
  return spawnSync(process.execPath, [runner], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
}

test("the runner exits 2 with ERROR postgres:integration setup when DATABASE_URL is missing (Requirement 1.4)", () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const result = runRunner(env);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^ERROR postgres:integration setup .*DATABASE_URL/);
  assert.doesNotMatch(result.stdout, /# tests|ℹ tests/);
});

test("the runner exits 2 with ERROR postgres:integration setup when DATABASE_URL points at a port nobody listens on", async () => {
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port: free } = server.address();
      server.close(() => resolve(free));
    });
  });
  const result = runRunner({ ...process.env, DATABASE_URL: `postgresql://postgres:not-a-real-password@127.0.0.1:${port}/postgres` });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^ERROR postgres:integration setup cannot connect to DATABASE_URL/);
  assert.doesNotMatch(result.stderr, /not-a-real-password/);
});

test("the runner refuses a DATABASE_URL that points at a shz_it_ database and rejects unknown arguments", () => {
  const own = runRunner({ ...process.env, DATABASE_URL: "postgresql://postgres:x@127.0.0.1:1/shz_it_20261105010203_abcd_tpl" });
  assert.equal(own.status, 2, own.stderr);
  assert.match(own.stderr, /^ERROR postgres:integration setup DATABASE_URL must not point at a shz_it_\* database/);
  const unknown = spawnSync(process.execPath, [runner, "--bogus"], { cwd: root, env: { ...process.env, DATABASE_URL: "postgresql://postgres:x@127.0.0.1:1/postgres" }, encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /^ERROR postgres:integration setup unknown argument --bogus/);
  const outside = spawnSync(process.execPath, [runner, "--only", "scripts/test-integration-lib.mjs"], { cwd: root, env: { ...process.env, DATABASE_URL: "postgresql://postgres:x@127.0.0.1:1/postgres" }, encoding: "utf8" });
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /is not a scripts\/integration\/\*\.test\.mjs file/);
});
