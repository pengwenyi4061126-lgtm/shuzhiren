// Self-test of the shared PostgreSQL harness (design part 8, section 1.5). Runs in postgres-integration.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { checkSessionIdentity, createHarness, MIGRATIONS_DIR, PRINCIPALS, SERVICE_PRINCIPALS } from "./harness.mjs";
import { REPO_ROOT, ROLE_SPECS } from "./lib/cluster.mjs";

let h;
before(async () => { h = await createHarness(import.meta.url); });
after(async () => { await h?.close(); });

describe("cluster roles", () => {
  test("role attributes match the section 1.1 role table and no managed role is a member of any role", async () => {
    const rows = await h.snapshot(`select r.rolname, r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
      (select count(*)::int from pg_auth_members m where m.member = r.oid) as memberships
      from pg_roles r where r.rolname = any($1::text[]) order by r.rolname`, [ROLE_SPECS.map((spec) => spec.name)]);
    const expected = ROLE_SPECS.map((spec) => ({ rolname: spec.name, rolcanlogin: true, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: spec.bypassRls, memberships: 0 })).sort((a, b) => a.rolname.localeCompare(b.rolname));
    assert.deepEqual(rows, expected);
    assert.deepEqual(Object.keys(PRINCIPALS).sort(), ["alert_notifier", "backup", "channel_adapter", "control_plane", "migration_owner", "owner_nobypass", "runtime_worker", "superuser"]);
  });

  test("connectAs logs in as each managed role and checks service principal sessions automatically", async () => {
    for (const spec of ROLE_SPECS) {
      const client = await h.connectAs(spec.alias, { applicationName: `shz-it-${spec.alias}` });
      try {
        const identity = await client.query("select session_user::text as session_user, current_setting('application_name') as app");
        assert.deepEqual(identity.rows[0], { session_user: spec.name, app: `shz-it-${spec.alias}` });
      } finally {
        await client.end();
      }
    }
    assert.deepEqual([...SERVICE_PRINCIPALS].sort(), ["alert_notifier", "channel_adapter", "control_plane", "runtime_worker"]);
  });

  // Property 146: only a role that is neither superuser nor BYPASSRLS nor a member of any role passes.
  test("assertSessionIdentity accepts only the combination without superuser, BYPASSRLS and memberships", async () => {
    const group = h.roleName("group");
    await h.admin.query(`create role "${group}" nologin`);
    for (const superuser of [false, true]) {
      for (const bypass of [false, true]) {
        for (const member of [false, true]) {
          const name = h.roleName(`s${+superuser}b${+bypass}m${+member}`);
          const password = `pw_${name.slice(-12)}_0123456789abcdef`;
          await h.admin.query(`create role "${name}" login noinherit ${superuser ? "superuser" : "nosuperuser"} ${bypass ? "bypassrls" : "nobypassrls"} password '${password}'`);
          if (member) await h.admin.query(`grant "${group}" to "${name}"`);
          const client = await h.connectAs(name, { password });
          try {
            const shouldPass = !superuser && !bypass && !member;
            if (shouldPass) await h.assertSessionIdentity(client, name);
            else await assert.rejects(h.assertSessionIdentity(client, name), assert.AssertionError, `${name} must fail the identity check`);
            await assert.rejects(h.assertSessionIdentity(client, PRINCIPALS.runtime_worker), /session_user must be shuzhiren_runtime_worker|must not/, "a different session_user must fail");
          } finally {
            await client.end();
          }
        }
      }
    }
    assert.throws(() => checkSessionIdentity({ session_user: "x", rolsuper: false, rolbypassrls: false, memberships: 0 }, "y"), /session_user must be y/);
  });
});

describe("template clone", () => {
  test("schema_migrations equals the Migration_Set and every public table is owned by the migration owner", async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
    const recorded = (await h.snapshot("select name from schema_migrations order by name")).map((row) => row.name);
    assert.deepEqual(recorded, files);
    const owners = await h.snapshot("select distinct tableowner from pg_tables where schemaname = 'public'");
    assert.deepEqual(owners, [{ tableowner: PRINCIPALS.migration_owner }]);
    const database = await h.snapshot("select pg_get_userbyid(datdba) as owner from pg_database where datname = current_database()");
    assert.deepEqual(database, [{ owner: PRINCIPALS.migration_owner }]);
  });

  test("rows written in one file's database are not visible in another clone", async () => {
    const other = await createHarness(new URL("./other-clone.test.mjs", import.meta.url).href);
    try {
      assert.notEqual(other.databaseName, h.databaseName);
      const tenantId = await h.seed.tenant();
      assert.equal((await h.snapshot("select count(*)::int as n from tenants where id = $1", [tenantId]))[0].n, 1);
      assert.equal((await other.snapshot("select count(*)::int as n from tenants where id = $1", [tenantId]))[0].n, 0);
    } finally {
      await other.close();
    }
  });

  test("the template refuses connections", async () => {
    const rows = await h.snapshot("select datallowconn from pg_database where datname = $1", [h.template]);
    assert.deepEqual(rows, [{ datallowconn: false }]);
  });

  test("control_plane owns no table; its privileges come only from control-plane-principal.sql", async () => {
    const owned = await h.snapshot("select count(*)::int as n from pg_tables where tableowner = $1", [PRINCIPALS.control_plane]);
    assert.equal(owned[0].n, 0);
    const privilege = async (table, kind) => (await h.snapshot("select has_table_privilege($1, $2, $3) as ok", [PRINCIPALS.control_plane, table, kind]))[0].ok;
    assert.equal(await privilege("schema_migrations", "insert"), false);
    assert.equal(await privilege("schema_migrations", "update"), false);
    if (h.skippedGrantScripts.includes("infra/postgres/control-plane-principal.sql")) {
      // The grant script is not in this checkout yet: the role must then hold no table privilege at all.
      const granted = await h.snapshot("select count(*)::int as n from information_schema.role_table_grants where grantee = $1", [PRINCIPALS.control_plane]);
      assert.equal(granted[0].n, 0);
    } else {
      for (const table of ["channel_connections", "settlement_batches", "settlement_reconciliation_exceptions"]) {
        for (const kind of ["insert", "update", "delete"]) assert.equal(await privilege(table, kind), true, `${table} ${kind}`);
      }
    }
  });
});

describe("transaction helpers", () => {
  test("withTriggersDisabled restores tgenabled = 'O' after the callback throws", async () => {
    await assert.rejects(h.withTriggersDisabled("audit_events", async (c) => {
      const inside = await c.query("select distinct tgenabled from pg_trigger where tgrelid = 'audit_events'::regclass and not tgisinternal");
      assert.deepEqual(inside.rows, [{ tgenabled: "D" }]);
      throw new Error("callback failure");
    }), /callback failure/);
    const rows = await h.snapshot("select distinct tgenabled from pg_trigger where tgrelid = 'audit_events'::regclass and not tgisinternal");
    assert.deepEqual(rows, [{ tgenabled: "O" }]);
  });

  test("withReplicaRole leaves the session at origin", async () => {
    const inside = await h.withReplicaRole(async (c) => (await c.query("select current_setting('session_replication_role') as v")).rows[0].v);
    assert.equal(inside, "replica");
    assert.equal((await h.snapshot("select current_setting('session_replication_role') as v"))[0].v, "origin");
    await assert.rejects(h.withReplicaRole(async () => { throw new Error("replica failure"); }), /replica failure/);
    assert.equal((await h.snapshot("select current_setting('session_replication_role') as v"))[0].v, "origin");
  });

  test("withTenant sets app.tenant_id for the transaction only", async () => {
    const client = await h.connectAs("runtime_worker");
    try {
      const tenantId = await h.seed.tenant();
      const seen = await h.withTenant(client, tenantId, async (c) => (await c.query("select current_setting('app.tenant_id', true) as t")).rows[0].t);
      assert.equal(seen, tenantId);
      const afterwards = (await client.query("select coalesce(current_setting('app.tenant_id', true), '') as t")).rows[0].t;
      assert.equal(afterwards, "");
    } finally {
      await client.end();
    }
  });
});

describe("seed builders", () => {
  test("every Seed method writes rows that read back by the returned ID", async () => {
    const tenantId = await h.seed.tenant();
    const approver = await h.seed.member({ tenantId, role: "admin" });
    assert.equal((await h.snapshot("select role::text, status::text, access_scope::text from memberships where tenant_id = $1 and user_id = $2", [tenantId, approver]))[0].role, "admin");
    const productVersionId = await h.seed.productVersion({ tenantId, approver });
    assert.equal((await h.snapshot("select approval_status::text as s from product_versions where id = $1", [productVersionId]))[0].s, "approved");
    const releaseId = await h.seed.modelRelease({ tenantId, approver, component: "voice" });
    assert.equal((await h.snapshot("select approval_status::text as s from model_releases where id = $1", [releaseId]))[0].s, "approved");
    const policyId = await h.seed.policyProfile({ tenantId, approver });
    assert.equal((await h.snapshot("select approval_status::text as s from policy_profiles where id = $1", [policyId]))[0].s, "approved");
    const assetId = await h.seed.mediaAsset({ tenantId, approver, kind: "voice" });
    assert.equal((await h.snapshot("select approval_status::text as s, verification_evidence_ref is not null as verified from media_assets where id = $1", [assetId]))[0].verified, true);
    const revision = await h.seed.revision({ tenantId, approver });
    assert.equal((await h.snapshot("select approval_status::text as s from show_revisions where id = $1", [revision.revisionId]))[0].s, "approved");
    assert.equal((await h.snapshot("select count(*)::int as n from show_revision_media_assets where show_revision_id = $1", [revision.revisionId]))[0].n, 4);
    assert.equal((await h.snapshot("select count(*)::int as n from show_revision_segments where show_revision_id = $1", [revision.revisionId]))[0].n, 1);
    const channelId = await h.seed.channelConnection({ tenantId, verifier: approver });
    assert.equal((await h.snapshot("select status::text as s from channel_connections where id = $1", [channelId]))[0].s, "connected");
    const runId = await h.seed.liveRun({ tenantId, revisionId: revision.revisionId, channelId, productVersionId: revision.productVersionId });
    assert.equal((await h.snapshot("select state::text as s from live_runs where id = $1", [runId]))[0].s, "DRAFT");
    const sampleId = await h.seed.healthSample({ tenantId, liveRunId: runId });
    assert.equal((await h.snapshot("select count(*)::int as n from runtime_health_samples where id = $1", [sampleId]))[0].n, 1);
    const alertId = await h.seed.runtimeAlert({ tenantId, liveRunId: runId });
    assert.equal((await h.snapshot("select count(*)::int as n from runtime_alerts where id = $1", [alertId]))[0].n, 1);
    const eventId = await h.seed.outboxEvent({ tenantId, aggregateId: runId });
    assert.equal((await h.snapshot("select event_type from outbox_events where id = $1", [eventId]))[0].event_type, "media.dispatch");
    const interactionId = await h.seed.interaction({ tenantId, liveRunId: runId, channelId });
    assert.equal((await h.snapshot("select count(*)::int as n from live_interactions where id = $1", [interactionId]))[0].n, 1);
    const replyId = await h.seed.replyDraft({ tenantId, liveRunId: runId, interactionId, channelId, createdBy: approver });
    assert.equal((await h.snapshot("select status::text as s from channel_reply_drafts where id = $1", [replyId]))[0].s, "draft");
  });
});

describe("HTTP and OIDC stubs", () => {
  test("a hang route does not answer within 3 seconds and close() drops the connection", async () => {
    const stub = await h.stub();
    stub.hang("POST", "/hang");
    stub.route("GET", "/ok", () => ({ status: 200, json: { ok: true } }));
    assert.deepEqual(await (await fetch(`${stub.baseUrl}/ok`)).json(), { ok: true });
    const pending = fetch(`${stub.baseUrl}/hang`, { method: "POST", body: "x" });
    const outcome = await Promise.race([pending.then(() => "answered", () => "failed"), new Promise((resolve) => setTimeout(() => resolve("pending"), 3000))]);
    assert.equal(outcome, "pending");
    assert.equal(stub.requests.at(-1).rawBody, "x");
    assert.ok(stub.requests.at(-1).receivedAt instanceof Date);
    await stub.close();
    await assert.rejects(pending, TypeError, "the hanging request must fail once the stub closes its connections");
  });

  test("signOperatorToken tokens verify against the published JWKS with the harness issuer and audience", async () => {
    assert.equal(h.oidc.audience, "shuzhiren-integration");
    assert.ok(h.oidc.issuer.endsWith("/issuer"));
    const token = await h.oidc.signOperatorToken({ tenantId: "00000000-0000-4000-8000-000000000001", subject: "it-operator", role: "admin", name: "IT Admin" });
    const { payload, protectedHeader } = await jwtVerify(token, createRemoteJWKSet(new URL(h.oidc.jwksUrl)), { issuer: h.oidc.issuer, audience: h.oidc.audience, algorithms: ["RS256"] });
    assert.equal(protectedHeader.alg, "RS256");
    assert.deepEqual({ sub: payload.sub, tenant_id: payload.tenant_id, role: payload.role, name: payload.name }, { sub: "it-operator", tenant_id: "00000000-0000-4000-8000-000000000001", role: "admin", name: "IT Admin" });
    const foreignKid = await h.oidc.signOperatorToken({ tenantId: "t", subject: "s", header: { kid: "unknown-key" } });
    await assert.rejects(jwtVerify(foreignKid, createRemoteJWKSet(new URL(h.oidc.jwksUrl)), { issuer: h.oidc.issuer, audience: h.oidc.audience }));
  });
});

describe("runner", () => {
  test("without DATABASE_URL the runner exits 2 and names DATABASE_URL (Requirement 1.4)", () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "run-postgres-integration.mjs")], { cwd: REPO_ROOT, env, encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /^ERROR postgres:integration setup .*DATABASE_URL/);
  });
});
