// In-memory stand-in for the `pg` package, used by scripts/test-channel-adapter.mjs.
// It models only the channel_webhook_replays statements issued by apps/channel-adapter: one table keyed by
// (tenant_id, channel_connection_id, external_event_id), transaction-local app.tenant_id row filtering, and a
// per-transaction id exposed as the `xmin` system column of every row version a transaction writes.
// Transactions are serialized by a single mutex, which is stricter than PostgreSQL row locks but sufficient
// for the sequential and lightly concurrent requests in the tests. Any statement or expression it does not
// recognize throws, so a SQL change in the adapter fails the test loudly instead of being silently ignored.

const tableName = "channel_webhook_replays";
const columns = new Set(["id", "tenant_id", "channel_connection_id", "external_event_id", "payload_sha256", "state", "received_at", "delivered_at", "lease_expires_at"]);

export function createFakeDatabase({ now = () => Date.now() } = {}) {
  const database = { rows: new Map(), now, nextXid: 1000, statements: [], queue: Promise.resolve() };
  database.lock = () => {
    let release;
    const acquired = database.queue.then(() => release);
    database.queue = new Promise((resolve) => { release = resolve; });
    return acquired;
  };
  database.row = (tenantId, channelConnectionId, externalEventId) => database.rows.get(rowKey(tenantId, channelConnectionId, externalEventId));
  return database;
}

export const defaultDatabase = createFakeDatabase();

export class Pool {
  constructor(options = {}, database = defaultDatabase) {
    this.options = options;
    this.database = database;
  }
  async query(sql, params = []) {
    const client = await this.connect();
    try { return await client.query(sql, params); } finally { client.release(); }
  }
  async connect() { return new Client(this.database); }
  on() { return this; }
  async end() {}
}

class Client {
  constructor(database) {
    this.database = database;
    this.transaction = null;
  }
  async query(sql, params = []) {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    this.database.statements.push(normalized);
    if (normalized === "begin") {
      const unlock = await this.database.lock();
      this.transaction = { unlock, xid: this.database.nextXid++, tenantId: null, snapshot: new Map([...this.database.rows].map(([key, row]) => [key, { ...row }])) };
      return result([]);
    }
    if (normalized === "commit" || normalized === "rollback") {
      if (!this.transaction) return result([]);
      if (normalized === "rollback") this.database.rows = this.transaction.snapshot;
      this.transaction.unlock();
      this.transaction = null;
      return result([]);
    }
    if (normalized === "select 1") return result([{ "?column?": 1 }]);
    if (!this.transaction) {
      await this.query("begin");
      try { const value = await this.query(sql, params); await this.query("commit"); return value; } catch (error) { await this.query("rollback"); throw error; }
    }
    const setConfig = normalized.match(/^select set_config\('app\.tenant_id', \$(\d+)(?:::text)?, true\)$/);
    if (setConfig) { this.transaction.tenantId = param(params, setConfig[1]); return result([{ set_config: this.transaction.tenantId }]); }
    const context = { params, now: this.database.now(), xid: this.transaction.xid };
    const insert = normalized.match(new RegExp(`^insert into ${tableName} \\((.+?)\\) values \\((.+?)\\) on conflict \\(tenant_id, channel_connection_id, external_event_id\\) do nothing(?: returning (.+))?$`));
    if (insert) return this.insert(insert, context);
    const select = normalized.match(new RegExp(`^select (.+) from ${tableName} where (.+?)(?: for update)?$`));
    if (select) return result(this.visibleRows().filter((row) => matches(row, select[2], context)).map((row) => project(row, select[1], context)));
    const update = normalized.match(new RegExp(`^update ${tableName} set (.+?) where (.+?)(?: returning (.+))?$`));
    if (update) return this.update(update, context);
    throw new Error(`fake pg does not understand: ${normalized}`);
  }
  release() {
    if (this.transaction) { this.database.rows = this.transaction.snapshot; this.transaction.unlock(); this.transaction = null; }
  }
  // The adapter listens for connection errors while a client is checked out; the fake never emits them.
  on() { return this; }
  removeListener() { return this; }
  visibleRows() { return [...this.database.rows.values()].filter((row) => this.transaction.tenantId === null || row.tenant_id === this.transaction.tenantId); }
  insert([, columnList, valueList, returning], context) {
    const names = splitTopLevel(columnList);
    const values = splitTopLevel(valueList).map((expression) => value(expression, context));
    if (names.length !== values.length) throw new Error("fake pg insert column/value mismatch");
    const row = { id: `fake-${context.xid}`, state: "pending", received_at: new Date(context.now), delivered_at: null, lease_expires_at: null };
    names.forEach((name, index) => { assertColumn(name); row[name] = values[index]; });
    row.xmin = context.xid;
    const key = rowKey(row.tenant_id, row.channel_connection_id, row.external_event_id);
    if (this.database.rows.has(key)) return result([]);
    if (this.transaction.tenantId !== null && row.tenant_id !== this.transaction.tenantId) throw new Error("new row violates row-level security policy");
    this.database.rows.set(key, row);
    return result(returning ? [project(row, returning, context)] : [], 1);
  }
  update([, assignmentList, conditions, returning], context) {
    const assignments = splitTopLevel(assignmentList).map((assignment) => {
      const match = assignment.match(/^([a-z_]+) = (.+)$/);
      if (!match) throw new Error(`fake pg does not understand assignment: ${assignment}`);
      assertColumn(match[1]);
      return [match[1], match[2]];
    });
    const changed = this.visibleRows().filter((row) => matches(row, conditions, context));
    for (const row of changed) {
      for (const [name, expression] of assignments) row[name] = value(expression, context);
      row.xmin = context.xid;
    }
    return result(returning ? changed.map((row) => project(row, returning, context)) : [], changed.length);
  }
}

function result(rows, rowCount = rows.length) { return { rows, rowCount }; }
function rowKey(tenantId, channelConnectionId, externalEventId) { return JSON.stringify([tenantId, channelConnectionId, externalEventId]); }
function param(params, index) {
  const position = Number(index) - 1;
  if (position < 0 || position >= params.length) throw new Error(`fake pg missing parameter $${index}`);
  return params[position];
}
function assertColumn(name) { if (!columns.has(name)) throw new Error(`fake pg unknown column ${name}`); }

function value(expression, context) {
  let match;
  if ((match = expression.match(/^\$(\d+)(?:::[a-z]+)?$/))) return param(context.params, match[1]);
  if ((match = expression.match(/^'([^']*)'$/))) return match[1];
  if (expression === "null") return null;
  if (expression === "now()") return new Date(context.now);
  if ((match = expression.match(/^now\(\) \+ \(\$(\d+) \* interval '1 second'\)$/))) return new Date(context.now + Number(param(context.params, match[1])) * 1000);
  throw new Error(`fake pg does not understand value: ${expression}`);
}

function matches(row, conditions, context) {
  return conditions.split(" and ").every((condition) => {
    const match = condition.match(/^([a-z_]+) (=|<>) (.+)$/);
    if (!match) throw new Error(`fake pg does not understand condition: ${condition}`);
    const [, name, operator, expression] = match;
    if (name !== "xmin") assertColumn(name);
    const actual = name === "xmin" ? String(row.xmin) : row[name];
    const expected = name === "xmin" ? String(value(expression, context)) : value(expression, context);
    return operator === "=" ? actual === expected : actual !== expected;
  });
}

const expressions = {
  "xmin::text": (row) => String(row.xmin),
  "(state = 'delivering' and lease_expires_at is not null and lease_expires_at > now())": (row, context) => row.state === "delivering" && row.lease_expires_at !== null && row.lease_expires_at.getTime() > context.now,
  "greatest(1, ceil(extract(epoch from (lease_expires_at - now()))))::int": (row, context) => row.lease_expires_at === null ? null : Math.max(1, Math.ceil((row.lease_expires_at.getTime() - context.now) / 1000))
};

function project(row, list, context) {
  const output = {};
  for (const item of splitTopLevel(list)) {
    const aliased = item.match(/^(.+) as ([a-z_]+)$/);
    const expression = aliased ? aliased[1] : item;
    const name = aliased ? aliased[2] : item;
    if (columns.has(expression)) output[name] = row[expression];
    else if (expressions[expression]) output[name] = expressions[expression](row, context);
    else throw new Error(`fake pg does not understand expression: ${expression}`);
  }
  return output;
}

function splitTopLevel(list) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const character of list) {
    if (character === "'") quoted = !quoted;
    if (!quoted && character === "(") depth += 1;
    if (!quoted && character === ")") depth -= 1;
    if (!quoted && depth === 0 && character === ",") { parts.push(current.trim()); current = ""; continue; }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export default { Pool };
