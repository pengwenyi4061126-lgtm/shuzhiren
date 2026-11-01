import { Pool, type PoolClient } from "pg";
import { controlPlaneConfig } from "@/lib/control-plane/config";

declare global {
  var shuzhirenDatabasePool: Pool | undefined;
}

export function databasePool() {
  const config = controlPlaneConfig();
  if (config.demoMode || !config.databaseUrl) return null;
  globalThis.shuzhirenDatabasePool ??= new Pool({ connectionString: config.databaseUrl, max: 10 });
  return globalThis.shuzhirenDatabasePool;
}

export async function withTenantTransaction<T>(tenantId: string, operation: (client: PoolClient) => Promise<T>) {
  const pool = databasePool();
  if (!pool) throw new Error("PostgreSQL is not configured; use demo mode only for local development");
  const client = await pool.connect();

  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function databaseHealth() {
  const pool = databasePool();
  if (!pool) return { status: "demo" as const };
  await pool.query("select 1");
  return { status: "ok" as const };
}
