import pg from "pg";

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) argumentsByName.set(process.argv[index], process.argv[index + 1]);
const databaseUrl = process.env.DATABASE_URL;
const tenantId = argumentsByName.get("--tenant-id");
const subject = argumentsByName.get("--subject");
const displayName = argumentsByName.get("--display-name");

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!isUuid(tenantId)) throw new Error("--tenant-id must be a UUID");
if (!isText(subject, 500)) throw new Error("--subject is required and must be at most 500 characters");
if (!isText(displayName, 200)) throw new Error("--display-name is required and must be at most 200 characters");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query("begin");
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [`shuzhiren-membership-bootstrap:${tenantId}`]);
  await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
  const tenant = await client.query("select id from tenants where id = $1::uuid", [tenantId]);
  if (!tenant.rows[0]) throw new Error("tenant does not exist");
  // Filter by tenant explicitly: a superuser or BYPASSRLS account (the D4 migration owner) is not limited by RLS.
  const activeAdmins = await client.query("select count(*)::integer as count from memberships where tenant_id = $1::uuid and status = 'active' and role = 'admin'", [tenantId]);
  if (activeAdmins.rows[0].count > 0) throw new Error("tenant already has an active admin; use the governed memberships API instead");
  // users is shared by every tenant (L8): an existing subject keeps its display name, so bootstrapping another
  // tenant never renames that person elsewhere; --display-name only names a subject seen for the first time.
  const inserted = await client.query(
    `insert into users (external_subject, display_name) values ($1, $2)
     on conflict (external_subject) do nothing
     returning id`,
    [subject.trim(), displayName.trim()]
  );
  const userId = inserted.rows[0]?.id ?? (await client.query("select id from users where external_subject = $1", [subject.trim()])).rows[0]?.id;
  if (!userId) throw new Error("the supplied subject is being provisioned concurrently; retry");
  const membership = await client.query(
    `insert into memberships (tenant_id, user_id, role) values ($1::uuid, $2::uuid, 'admin')
     on conflict (tenant_id, user_id) do nothing returning id`,
    [tenantId, userId]
  );
  if (!membership.rows[0]) throw new Error("the supplied subject already has a historical membership; reactivate it through an active administrator or controlled database recovery");
  await client.query(
    `insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_id, resource_key, detail)
     values ($1::uuid, $2::uuid, 'membership.bootstrap_admin', 'membership', $3::uuid, $3, $4::jsonb)`,
    [tenantId, userId, membership.rows[0].id, JSON.stringify({ externalSubject: subject.trim(), role: "admin", status: "active", source: "deployment_bootstrap" })]
  );
  await client.query("commit");
  console.log(`Bootstrapped active admin membership ${membership.rows[0].id} for tenant ${tenantId}`);
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

function isUuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isText(value, max) { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
