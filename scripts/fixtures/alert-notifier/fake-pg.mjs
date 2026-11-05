// Stand-in for the `pg` package, loaded into apps/alert-notifier/index.mjs by register-fake-pg.mjs.
// It reproduces the PostgreSQL behavior that scripts/test-alert-notifier.mjs depends on:
// - bind values that include a parameter the SQL never references fail with 42P18 ("could not determine data
//   type of parameter $n"), and SQL that references more parameters than it receives fails with 08P01;
// - set_config(name, value, true) lasts until the end of the transaction, and rollback undoes the transaction;
// - row-level security: an UPDATE only sees alert_notification_deliveries rows of the tenant in app.tenant_id;
// - Pool#query times the wait for a connection (connectionTimeoutMillis) and the query (query_timeout) separately,
//   as pg does.
// FAKE_PG_SCENARIO is a JSON object:
// - "poolQuery": { "connectDelayMs": n, "queryDelayMs": n | null } sets how long Pool#query waits for the
//   connection and for the answer (null: the server never answers);
// - "deliveries": [{ id, tenant_id, target_id, state, attempts, leaseOffsetMs }] seeds alert_notification_deliveries;
//   lease_expires_at is now + leaseOffsetMs, or null when leaseOffsetMs is null or missing.
// The fake has no runtime_alerts rows, so enqueue inserts nothing and claim (which joins runtime_alerts) finds nothing.
// UPDATE statements on alert_notification_deliveries are evaluated when they consist of `column = value`
// assignments and `column <op> value` conditions joined by `and`, where a value is null, now(), a string literal
// or a typed parameter. Statements the fake does not recognize fail, so a test never passes on SQL it ignored.
// Every statement is appended to the file named by FAKE_PG_LOG as one JSON line: { client, sql, values, rowCount | error, code }.
// With seeded deliveries, every commit also appends { client, committed: <all delivery rows> }.
import { appendFileSync } from "node:fs";

const logFile = process.env.FAKE_PG_LOG;
const scenario = JSON.parse(process.env.FAKE_PG_SCENARIO || "{}");
let deliveries = (scenario.deliveries ?? []).map(({ leaseOffsetMs = null, ...row }) => ({ last_error: null, ...row, lease_expires_at: leaseOffsetMs === null ? null : Date.now() + leaseOffsetMs }));
let nextClientId = 1;

class DatabaseError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

class Client {
  constructor() {
    this.id = nextClientId++;
    this.settings = {};
    this.snapshot = null;
  }

  async query(text, values = []) {
    const sql = String(text).replace(/\s+/g, " ").trim();
    try {
      const result = execute(this, sql, values);
      log({ client: this.id, sql, values, rowCount: result.rowCount });
      if (/^commit$/i.test(sql) && scenario.deliveries) log({ client: this.id, committed: deliveries });
      return result;
    } catch (error) {
      log({ client: this.id, sql, values, error: error.message, code: error.code });
      throw error;
    }
  }

  release() {}

  // The notifier listens for connection errors while a client is checked out; the fake never emits them.
  on() { return this; }

  removeListener() { return this; }
}

export class Pool {
  constructor(options = {}) {
    this.options = options;
  }

  on() { return this; }

  async connect() {
    return new Client();
  }

  async query(text, values) {
    const timing = scenario.poolQuery;
    if (timing) {
      const { connectionTimeoutMillis, query_timeout: queryTimeout } = this.options;
      if (timing.connectDelayMs >= connectionTimeoutMillis) {
        await sleep(connectionTimeoutMillis);
        throw new Error("timeout exceeded when trying to connect");
      }
      await sleep(timing.connectDelayMs);
      if (timing.queryDelayMs === null || timing.queryDelayMs >= queryTimeout) {
        await sleep(queryTimeout);
        throw new Error("Query read timeout");
      }
      await sleep(timing.queryDelayMs);
    }
    const client = await this.connect();
    try {
      return await client.query(text, values);
    } finally {
      client.release();
    }
  }

  async end() {}
}

export default { Pool };

function execute(client, sql, values) {
  checkParameters(sql, values);
  if (/^begin$/i.test(sql)) {
    client.snapshot = structuredClone(deliveries);
    return result([]);
  }
  if (/^(commit|rollback)$/i.test(sql)) {
    if (/^rollback$/i.test(sql) && client.snapshot) deliveries = client.snapshot;
    client.snapshot = null;
    client.settings = {};
    return result([]);
  }
  if (/^select 1$/i.test(sql)) return result([{ "?column?": 1 }]);
  const setting = /^select set_config\('([a-z_.]+)', \$1(?:::text)?, true\)$/i.exec(sql);
  if (setting) {
    client.settings[setting[1]] = String(values[0]);
    return result([{ set_config: String(values[0]) }]);
  }
  if (/^insert into alert_notification_deliveries \(tenant_id, runtime_alert_id, target_id\) select /i.test(sql)) return result([]);
  if (/^select d\.id, .* from alert_notification_deliveries d join runtime_alerts a /i.test(sql)) return result([]);
  const update = /^update alert_notification_deliveries set (.+?) where (.+)$/i.exec(sql);
  if (update) return updateDeliveries(client, update[1], update[2], values);
  throw new DatabaseError(`fake pg does not handle this statement: ${sql}`, "XX000");
}

function updateDeliveries(client, assignments, conditions, values) {
  const now = Date.now();
  const sets = assignments.split(/, (?=[a-z_]+ = )/i).map((part) => {
    const match = /^([a-z_]+) = (.+)$/i.exec(part) ?? unsupported(part);
    return [match[1], evaluate(match[2], values, now)];
  });
  const predicates = conditions.split(/ and /i).map((part) => {
    const match = /^([a-z_]+) (=|<=|>=|<|>) (.+)$/i.exec(part) ?? unsupported(part);
    return { column: match[1], operator: match[2], value: evaluate(match[3], values, now) };
  });
  const tenantId = client.settings["app.tenant_id"];
  let rowCount = 0;
  for (const row of deliveries) {
    if (row.tenant_id !== tenantId) continue;
    if (!predicates.every(({ column, operator, value }) => compare(row[column], operator, value))) continue;
    for (const [column, value] of sets) row[column] = value;
    rowCount += 1;
  }
  return { rows: [], rowCount };
}

function evaluate(expression, values, now) {
  if (/^null$/i.test(expression)) return null;
  if (/^now\(\)$/i.test(expression)) return now;
  const literal = /^'([^']*)'$/.exec(expression);
  if (literal) return literal[1];
  const parameter = /^\$(\d+)::(uuid|text|integer|alert_notification_state)$/.exec(expression);
  if (parameter) {
    const value = values[Number(parameter[1]) - 1];
    return parameter[2] === "integer" ? Number(value) : String(value);
  }
  return unsupported(expression);
}

// SQL comparison: anything compared with null is not true.
function compare(left, operator, right) {
  if (left === null || left === undefined || right === null) return false;
  if (operator === "=") return left === right;
  if (operator === "<=") return left <= right;
  if (operator === ">=") return left >= right;
  if (operator === "<") return left < right;
  return left > right;
}

function unsupported(fragment) {
  throw new DatabaseError(`fake pg cannot evaluate: ${fragment}`, "XX000");
}

function checkParameters(sql, values) {
  const referenced = new Set([...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));
  for (let index = 1; index <= values.length; index += 1) {
    if (!referenced.has(index)) throw new DatabaseError(`could not determine data type of parameter $${index}`, "42P18");
  }
  const highest = Math.max(0, ...referenced);
  if (highest > values.length) throw new DatabaseError(`bind message supplies ${values.length} parameters, but prepared statement "" requires ${highest}`, "08P01");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function result(rows) {
  return { rows, rowCount: rows.length };
}

function log(entry) {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}
