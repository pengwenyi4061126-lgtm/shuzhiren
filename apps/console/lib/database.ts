import { Pool, TypeOverrides, type PoolClient } from "pg";
import { controlPlaneConfig } from "@/lib/control-plane/config";

declare global {
  var shuzhirenDatabasePool: Pool | undefined;
}

export function databasePool() {
  const config = controlPlaneConfig();
  if (config.demoMode || !config.databaseUrl) return null;
  globalThis.shuzhirenDatabasePool ??= createDatabasePool({ connectionString: config.databaseUrl, timeoutMs: databaseTimeoutMs() });
  return globalThis.shuzhirenDatabasePool;
}

// node-postgres parses a PostgreSQL `date` as local midnight of the process time zone, so toISOString() moves
// it to the previous day east of UTC. The pool returns `date` values as their `YYYY-MM-DD` text instead; other
// types keep the node-postgres parsers.
const postgresDateOid = 1082;

function controlPlaneTypeParsers() {
  const types = new TypeOverrides();
  types.setTypeParser(postgresDateOid, (value: string) => value);
  return types;
}

export function createDatabasePool(input: { connectionString: string; timeoutMs: number; max?: number }) {
  const pool = new Pool({
    connectionString: input.connectionString,
    max: input.max ?? 10,
    connectionTimeoutMillis: input.timeoutMs,
    query_timeout: input.timeoutMs,
    application_name: process.env.PGAPPNAME?.trim() || "shuzhiren-control-plane",
    types: controlPlaneTypeParsers()
  });
  // pg-pool emits "error" when an idle client fails (server restart, terminated
  // or reaped connection). It has already removed that client and opens a new
  // one on the next connect(); without a listener the EventEmitter would throw
  // and terminate the process.
  pool.on("error", (error) => logDatabaseError("database.pool_error", error, input.connectionString));
  return pool;
}

function databaseTimeoutMs() {
  const configured = Number.parseInt(process.env.DATABASE_QUERY_TIMEOUT_MS ?? "5000", 10);
  return Number.isInteger(configured) && configured >= 100 && configured <= 60_000 ? configured : 5000;
}

export type TenantTransactionOptions = {
  isolationLevel?: "read committed" | "repeatable read" | "serializable";
  readOnly?: boolean;
};

export async function withTenantTransaction<T>(tenantId: string, operation: (client: PoolClient) => Promise<T>, options: TenantTransactionOptions = {}) {
  const pool = databasePool();
  if (!pool) throw new Error("PostgreSQL is not configured; use demo mode only for local development");
  const client = await pool.connect();
  // pg-pool detaches its idle listener while a client is checked out, so a
  // connection lost between two queries would otherwise be an unhandled error.
  let clientError: Error | undefined;
  let releaseError: Error | undefined;
  const onClientError = (error: Error) => {
    clientError ??= error;
    logDatabaseError("database.client_error", error);
  };
  client.on("error", onClientError);

  try {
    const isolation = options.isolationLevel ?? "read committed";
    await client.query(`begin isolation level ${isolation}${options.readOnly ? " read only" : ""}`);
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    // A failed rollback (for example on a broken connection) must not replace
    // the error that aborted the transaction.
    try {
      await client.query("rollback");
    } catch (rollbackError) {
      releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      logDatabaseError("database.rollback_failed", rollbackError);
    }
    throw error;
  } finally {
    client.removeListener("error", onClientError);
    // Releasing with an error destroys the connection instead of reusing it.
    client.release(releaseError ?? clientError);
  }
}

export async function databaseHealth() {
  const pool = databasePool();
  if (!pool) return { status: "demo" as const };
  await pool.query("select 1");
  return { status: "ok" as const };
}

export function describeDatabaseError(error: unknown, connectionString = process.env.DATABASE_URL) {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
  const message = redactDatabaseSecrets(error instanceof Error ? error.message : String(error), connectionString);
  return code ? { code, message } : { message };
}

function redactDatabaseSecrets(message: string, connectionString?: string) {
  const secrets = new Set<string>();
  if (connectionString) {
    secrets.add(connectionString);
    try {
      const password = new URL(connectionString).password;
      if (password) {
        secrets.add(password);
        try { secrets.add(decodeURIComponent(password)); } catch { /* keep the encoded form only */ }
      }
    } catch {
      // not a URL; the full string is still redacted
    }
  }
  let redacted = message;
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) redacted = redacted.split(secret).join("[redacted]");
  return redacted.replace(/[^\s/:@]+:[^\s/@]*@/g, "[redacted]@");
}

function logDatabaseError(event: string, error: unknown, connectionString?: string) {
  console.error(JSON.stringify({ service: "control-plane", event, error: describeDatabaseError(error, connectionString) }));
}
