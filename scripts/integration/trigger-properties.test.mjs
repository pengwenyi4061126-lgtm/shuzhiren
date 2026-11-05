// Property tests for the C1 (069) and C2 (070) triggers under random inputs, with fast-check and a fixed
// seed. Each generated input runs in a savepoint that is rolled back, inside one transaction per property.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import fc from "fast-check";
import { createHarness } from "./harness.mjs";

const SEED = 20261105;
const RUNS = 100;
const IMMUTABLE = "configuration is immutable";
let h;
before(async () => { h = await createHarness(import.meta.url); });
after(async () => { await h?.close(); });

/** Runs `fn(client, run)` for every generated value, each inside `savepoint`/`rollback to savepoint`. */
async function inRolledBackTransaction(setup, property) {
  const client = await h.connectAs("superuser", { applicationName: "shz-it-trigger-properties" });
  try {
    await client.query("begin");
    const context = await setup(client);
    const attempt = async (sql, params) => {
      await client.query("savepoint attempt");
      try {
        const result = await client.query(sql, params);
        return { ok: true, rowCount: result.rowCount };
      } catch (error) {
        return { ok: false, message: error.message };
      } finally {
        await client.query("rollback to savepoint attempt");
      }
    };
    await property({ client, attempt, ...context });
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

test("069: a channel connection INSERT is accepted exactly when the verification rules allow it", async () => {
  await inRolledBackTransaction(async (client) => {
    const seed = h.seedFor(client);
    const tenantId = await seed.tenant();
    const activeId = await seed.member({ tenantId, role: "admin" });
    const suspendedId = await seed.member({ tenantId, role: "operator", status: "suspended" });
    const outsiderId = await seed.member({ tenantId: await seed.tenant(), role: "admin" });
    return { tenantId, verifiers: { none: null, active: activeId, suspended: suspendedId, outsider: outsiderId } };
  }, async ({ attempt, tenantId, verifiers }) => {
    const input = fc.record({ status: fc.constantFrom("disabled", "connected"), verifiedAt: fc.boolean(), evidence: fc.boolean(), verifier: fc.constantFrom("none", "active", "suspended", "outsider") });
    await fc.assert(fc.asyncProperty(input, async ({ status, verifiedAt, evidence, verifier }) => {
      const result = await attempt(
        "insert into channel_connections (id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities, last_verified_at, verification_evidence_ref, verified_by) values ($1, $2, 'C1 property channel', 'normalized-webhook-rtmp', $3, 'rtmp', 'secret://integration/c1-property', '{}'::jsonb, $4, $5, $6)",
        [randomUUID(), tenantId, status, verifiedAt ? new Date() : null, evidence ? "evidence://integration/c1-property" : null, verifiers[verifier]]
      );
      const complete = verifiedAt && evidence && verifier !== "none";
      const actorAllowed = verifier === "none" || verifier === "active";
      const expectAccept = (status !== "connected" || complete) && actorAllowed;
      assert.equal(result.ok, expectAccept, `${JSON.stringify({ status, verifiedAt, evidence, verifier })}: ${result.message ?? "accepted"}`);
      if (!result.ok) {
        assert.ok(!result.message.includes(IMMUTABLE), `INSERT must never fail as "${IMMUTABLE}": ${result.message}`);
        // 069 checks the evidence of a connected row before the verifier's membership.
        const expected = status === "connected" && !complete ? "connected channel connections require verification evidence, time, and actor" : "channel verification actor must be an active tenant member";
        assert.ok(result.message.includes(expected), `expected "${expected}", got "${result.message}"`);
      } else {
        assert.equal(result.rowCount, 1);
      }
    }), { seed: SEED, numRuns: RUNS });
  });
});

const BATCH_STATUSES = ["imported", "review_required", "reconciled"];
const ALLOWED = new Set(["imported>review_required", "imported>reconciled", "review_required>reconciled"]);

test("070: a settlement batch UPDATE is accepted exactly for a permitted transition without evidence changes, and DELETE always fails", async () => {
  await inRolledBackTransaction(async (client) => {
    const seed = h.seedFor(client);
    const tenantId = await seed.tenant();
    const memberId = await seed.member({ tenantId, role: "admin" });
    const channelId = await seed.channelConnection({ tenantId, status: "disabled" });
    return { tenantId, memberId, channelId };
  }, async ({ client, attempt, tenantId, memberId, channelId }) => {
    const input = fc.record({ from: fc.constantFrom(...BATCH_STATUSES), to: fc.constantFrom(...BATCH_STATUSES), mutateEvidence: fc.boolean(), remove: fc.boolean() });
    await fc.assert(fc.asyncProperty(input, async ({ from, to, mutateEvidence, remove }) => {
      const batchId = randomUUID();
      await client.query("savepoint batch");
      try {
        await client.query("insert into settlement_batches (id, tenant_id, channel_connection_id, provider_statement_ref, period_start, period_end, source_sha256, evidence_ref, imported_by) values ($1, $2, $3, $4, now() - interval '1 day', now(), repeat('a', 64), 'evidence://integration/c2-property', $5)", [batchId, tenantId, channelId, `c2-${batchId}`, memberId]);
        if (from !== "imported") await client.query("update settlement_batches set status = $2::settlement_batch_status where id = $1", [batchId, from]);
        if (remove) {
          const result = await attempt("delete from settlement_batches where id = $1", [batchId]);
          assert.equal(result.ok, false, "DELETE of a settlement batch must fail");
          assert.ok(result.message.includes("settlement batches are immutable"), result.message);
          const still = await client.query("select count(*)::int as n from settlement_batches where id = $1", [batchId]);
          assert.equal(still.rows[0].n, 1);
          return;
        }
        const result = await attempt(`update settlement_batches set status = $2::settlement_batch_status${mutateEvidence ? ", source_sha256 = repeat('b', 64)" : ""} where id = $1`, [batchId, to]);
        const expectAccept = !mutateEvidence && ALLOWED.has(`${from}>${to}`);
        assert.equal(result.ok, expectAccept, `${JSON.stringify({ from, to, mutateEvidence })}: ${result.message ?? "accepted"}`);
        if (result.ok) assert.equal(result.rowCount, 1);
        else assert.ok(result.message.includes(mutateEvidence ? "settlement batch source evidence is immutable" : "settlement batch status transition is not permitted"), result.message);
      } finally {
        await client.query("rollback to savepoint batch");
      }
    }), { seed: SEED, numRuns: RUNS });
  });
});
