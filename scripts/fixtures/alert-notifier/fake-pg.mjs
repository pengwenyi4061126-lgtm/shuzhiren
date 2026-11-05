// Stand-in for the `pg` package, loaded into apps/alert-notifier/index.mjs by register-fake-pg.mjs.
// It reproduces the PostgreSQL behavior that scripts/test-alert-notifier.mjs depends on:
// - bind values that include a parameter the SQL never references fail with 42P18 ("could not determine data
//   type of parameter $n"), and SQL that references more parameters than it receives fails with 08P01;
// - set_config(name, value, true) lasts until the end of the transaction.
// The fake has no runtime_alerts rows, so enqueue inserts nothing and claim finds nothing.
// Statements it does not recognize fail, so a test never passes on SQL the fake silently ignored.
// Every statement is appended to the file named by FAKE_PG_LOG as one JSON line: { client, sql, values, rowCount | error, code }.
import { appendFileSync } from "node:fs";

const logFile = process.env.FAKE_PG_LOG;
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
  }

  async query(text, values = []) {
    const sql = String(text).replace(/\s+/g, " ").trim();
    try {
      const result = execute(this, sql, values);
      log({ client: this.id, sql, values, rowCount: result.rowCount });
      return result;
    } catch (error) {
      log({ client: this.id, sql, values, error: error.message, code: error.code });
      throw error;
    }
  }

  release() {}
}

export class Pool {
  constructor(options = {}) {
    this.options = options;
  }

  async connect() {
    return new Client();
  }

  async query(text, values) {
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
  if (/^begin$/i.test(sql)) return result([]);
  if (/^(commit|rollback)$/i.test(sql)) {
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
  throw new DatabaseError(`fake pg does not handle this statement: ${sql}`, "XX000");
}

function checkParameters(sql, values) {
  const referenced = new Set([...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));
  for (let index = 1; index <= values.length; index += 1) {
    if (!referenced.has(index)) throw new DatabaseError(`could not determine data type of parameter $${index}`, "42P18");
  }
  const highest = Math.max(0, ...referenced);
  if (highest > values.length) throw new DatabaseError(`bind message supplies ${values.length} parameters, but prepared statement "" requires ${highest}`, "08P01");
}

function result(rows) {
  return { rows, rowCount: rows.length };
}

function log(entry) {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}
