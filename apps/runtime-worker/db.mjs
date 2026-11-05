// PostgreSQL access for this service. apps/runtime-worker, apps/channel-adapter and apps/alert-notifier each
// carry a byte-identical copy of this file, because every service image copies only its own directory.
// scripts/test-runtime-worker-health.mjs asserts that the three copies stay identical.
import pg from "pg";

/**
 * Creates the service connection pool with an "error" listener registered before any connection exists.
 * pg-pool emits "error" when an idle connection fails (database restart, pg_terminate_backend, a proxy closing
 * idle connections). Without a listener the EventEmitter throws and the process exits. pg-pool has already
 * discarded the broken connection and opens a new one on the next connect(), so logging is sufficient.
 */
export function createServicePool({ service, connectionString, max, timeoutMs, log }) {
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    application_name: process.env.PGAPPNAME?.trim() || `shuzhiren-${service}`
  });
  pool.on("error", (error) => log("database.pool_error", { error: describeDatabaseError(error, connectionString) }));
  return pool;
}

/**
 * Runs `operation(client)` in one transaction scoped to `tenantId` through the transaction-local app.tenant_id.
 * A connection failure while the client is checked out is recorded instead of crashing the process, and the
 * client is then released with that error so pg-pool destroys it. A failed rollback is logged but never
 * replaces the error that made the transaction fail.
 */
export async function inTenantTransaction(pool, tenantId, operation, { log } = {}) {
  const client = await pool.connect();
  let clientError;
  let releaseError;
  const onClientError = (error) => { clientError ??= error; };
  client.on("error", onClientError);
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1::text, true)", [tenantId]);
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch (rollbackError) {
      releaseError = rollbackError;
      log?.("database.rollback_failed", { error: describeDatabaseError(rollbackError, pool.options?.connectionString) });
    }
    throw error;
  } finally {
    client.removeListener("error", onClientError);
    client.release(releaseError ?? clientError);
  }
}

/** Returns `{ code?, message }` for logs, with the connection string and its password removed from the message. */
export function describeDatabaseError(error, connectionString) {
  const code = typeof error?.code === "string" && error.code ? error.code : undefined;
  let message = error instanceof Error ? error.message : String(error ?? "unknown_database_error");
  for (const secret of connectionSecrets(connectionString)) message = message.split(secret).join("[redacted]");
  message = message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1[redacted]@");
  return code ? { code, message } : { message };
}

function connectionSecrets(connectionString) {
  if (typeof connectionString !== "string" || !connectionString) return [];
  const secrets = [connectionString];
  try {
    const url = new URL(connectionString);
    if (url.password) {
      secrets.push(url.password);
      try { secrets.push(decodeURIComponent(url.password)); } catch { /* keep the encoded form only */ }
    }
  } catch { /* not a URL: only the whole string is redacted */ }
  return [...new Set(secrets.filter(Boolean))].sort((left, right) => right.length - left.length);
}
