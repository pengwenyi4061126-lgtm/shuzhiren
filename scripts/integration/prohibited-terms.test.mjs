// Prohibited-term requests, approvals, frozen snapshots and runtime reads (live-commerce-p1-features, task 8.7;
// requirements 5.3, 5.4, 5.6, 5.7, 7.9; migration 088) against real PostgreSQL service roles.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import { after, before, describe, test } from "node:test";
import { BUILTIN_LEXICON } from "../../apps/console/lib/shared/prohibited-terms-builtin.mjs";
import { effectiveLexicon, runtimeLexicon, scanProhibitedTerms } from "../../apps/console/lib/shared/prohibited-terms.mjs";
import { createHarness } from "./harness.mjs";

let h;
let database;
let prohibited;
let workerPool;

before(async () => {
  h = await createHarness(import.meta.url);
  workerPool = h.pool("runtime_worker", { max: 3 });
  for (const name of ["CONTROL_PLANE_DEMO_MODE", "CONTROL_PLANE_DEV_HEADER_IDENTITY"]) delete process.env[name];
  process.env.DATABASE_URL = h.url("control_plane");
  register("../lib/console-ts-loader.mjs", import.meta.url);
  database = await import("../../apps/console/lib/database.ts");
  prohibited = await import("../../apps/console/lib/prohibited-terms.ts");
});

after(async () => {
  await globalThis.shuzhirenDatabasePool?.end().catch(() => undefined);
  await h?.close();
});

async function people(label) {
  const tenantId = await h.seed.tenant();
  const requesterSubject = `it-terms-${label}-${randomUUID()}`;
  const reviewerSubject = `it-review-${randomUUID()}`;
  const requesterId = await h.seed.member({ tenantId, subject: requesterSubject, displayName: "词库申请人", role: "admin" });
  await h.seed.member({ tenantId, subject: reviewerSubject, displayName: "词库复核人", role: "reviewer" });
  return {
    tenantId,
    requesterId,
    requester: { tenantId, actorId: requesterSubject, actorName: "词库申请人", role: "admin", accessScope: "tenant" },
    reviewer: { tenantId, actorId: reviewerSubject, actorName: "词库复核人", role: "reviewer", accessScope: "tenant" }
  };
}

async function approvedCustomTerm(f, term) {
  const row = await prohibited.createProhibitedTerm(f.requester, { term, suggestions: ["经审核的中性表述"] });
  await prohibited.approveProhibitedTermRevision(f.reviewer, row.id);
  return row.id;
}

describe("tenant prohibited-term governance", () => {
  test("a custom term is ineffective while pending and becomes effective after reviewer approval", async () => {
    const f = await people("approval");
    const term = "集成测试专属拦截词";
    const created = await prohibited.createProhibitedTerm(f.requester, { term, suggestions: ["经审核的中性表述"] });
    assert.equal(created.approvedRevision, null);
    assert.equal(created.revisions[0].status, "pending");
    assert.equal((await prohibited.scanProhibitedTermText(f.requester, term)).findings.length, 0);

    const approved = await prohibited.approveProhibitedTermRevision(f.reviewer, created.id);
    assert.equal(approved.approvedRevision, 1);
    assert.equal((await h.snapshot("select status from tenant_prohibited_term_revisions where term_id = $1", [created.id]))[0].status, "approved");
    assert.deepEqual((await prohibited.scanProhibitedTermText(f.requester, term)).findings.map((finding) => [finding.term, finding.severity]), [[term, "block"]]);
  });

  test("a loosening revision is rejected by the application and the database when self-approved", async () => {
    const f = await people("second-approver");
    const termId = await approvedCustomTerm(f, "双人复核专属禁词");
    await prohibited.updateProhibitedTerm(f.requester, termId, { severity: "warn", reason: "复核后允许作为风险提示展示" });

    await assert.rejects(prohibited.approveProhibitedTermRevision(f.requester, termId), (error) => error instanceof Response && error.status === 409 && error.statusText === "prohibited_term_second_approver_required");
    const [pending] = await h.snapshot("select id, requested_by from tenant_prohibited_term_revisions where term_id = $1 and status = 'pending'", [termId]);
    await assert.rejects(
      h.admin.query("update tenant_prohibited_term_revisions set status = 'approved', decided_by = requested_by, decided_at = now() where id = $1", [pending.id]),
      (error) => error.code === "23514" && error.constraint === "tenant_prohibited_term_revisions_loosening_approver_check"
    );
    const approved = await prohibited.approveProhibitedTermRevision(f.reviewer, termId);
    assert.equal(approved.severity, "warn");
  });

  test("program approval freezes a snapshot and the worker sees frozen union current terms under least privilege and RLS", async () => {
    const f = await people("runtime-union");
    const frozenTerm = "节目冻结专属禁词";
    const currentTerm = "租户新批专属禁词";
    const foreignTerm = "其他租户专属禁词";
    const frozenTermId = await approvedCustomTerm(f, frozenTerm);
    const revision = await h.seed.revision({ tenantId: f.tenantId, approver: f.requesterId, bindings: "none", approve: false, segments: [] });

    await assert.rejects(
      h.admin.query("update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [revision.revisionId, f.requesterId]),
      /frozen prohibited-term lexicon snapshot/i
    );
    const frozen = await database.withTenantTransaction(f.tenantId, async (client) => {
      const info = await prohibited.freezeRevisionLexiconInTransaction(client, revision.revisionId);
      await client.query("update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [revision.revisionId, f.requesterId]);
      return info;
    });
    assert.ok(frozen.termCount > 0);
    const [snapshotBefore] = await h.snapshot("select lexicon, lexicon_sha256, term_count from show_revision_prohibited_term_snapshots where show_revision_id = $1", [revision.revisionId]);
    assert.equal(snapshotBefore.lexicon_sha256, frozen.lexiconSha256);
    assert.equal(snapshotBefore.term_count, frozen.termCount);
    assert.ok(snapshotBefore.lexicon.some((entry) => entry.term === frozenTerm));
    await assert.rejects(h.admin.query("update show_revision_prohibited_term_snapshots set builtin_version = 'changed' where show_revision_id = $1", [revision.revisionId]), /append-only/);
    await assert.rejects(h.admin.query("delete from show_revision_prohibited_term_snapshots where show_revision_id = $1", [revision.revisionId]), /append-only/);

    const currentTermId = await approvedCustomTerm(f, currentTerm);
    await prohibited.updateProhibitedTerm(f.requester, frozenTermId, { active: false, reason: "节目批准后由复核人停用该租户词条" });
    await prohibited.approveProhibitedTermRevision(f.reviewer, frozenTermId);
    const other = await people("foreign-tenant");
    await approvedCustomTerm(other, foreignTerm);

    const worker = await workerPool.connect();
    try {
      await h.assertSessionIdentity(worker, "shuzhiren_runtime_worker");
      const runtime = await h.withTenant(worker, f.tenantId, async (client) => {
        const [frozenRow] = (await client.query("select lexicon from show_revision_prohibited_term_snapshots where tenant_id = $1 and show_revision_id = $2", [f.tenantId, revision.revisionId])).rows;
        const currentRows = (await client.query(`select tenant_id, kind, builtin_term_id, term, normalized_term, category, approved_revision, severity, suggestions, disabled, active
          from tenant_prohibited_terms where approved_revision is not null`)).rows;
        const otherTenantSnapshot = await client.query("select lexicon from show_revision_prohibited_term_snapshots where tenant_id = $1", [other.tenantId]);
        return {
          currentRows,
          otherTenantSnapshotCount: otherTenantSnapshot.rowCount,
          currentLexicon: effectiveLexicon(BUILTIN_LEXICON, currentRows),
          lexicon: runtimeLexicon(frozenRow.lexicon, effectiveLexicon(BUILTIN_LEXICON, currentRows))
        };
      });
      const currentIds = new Set(runtime.currentLexicon.map((entry) => entry.term));
      assert.ok(currentIds.has(currentTerm), "a newly approved tenant block term is visible immediately");
      assert.ok(!currentIds.has(frozenTerm), "a retired term is no longer in the current lexicon");
      assert.ok(!currentIds.has(foreignTerm), "RLS hides another tenant's term rows");
      assert.equal(runtime.otherTenantSnapshotCount, 0, "RLS hides another tenant's snapshots");
      assert.ok(scanProhibitedTerms(frozenTerm, runtime.lexicon).some((finding) => finding.term === frozenTerm), "the frozen term still blocks this approved revision");
      assert.ok(scanProhibitedTerms(currentTerm, runtime.lexicon).some((finding) => finding.term === currentTerm), "the current term blocks immediately");
      assert.ok(!scanProhibitedTerms(foreignTerm, runtime.lexicon).length, "a foreign tenant's term is absent from Runtime_Lexicon");
      await assert.rejects(h.withTenant(worker, f.tenantId, (client) => client.query("select id from tenant_prohibited_terms")), (error) => error.code === "42501");
      await assert.rejects(h.withTenant(worker, f.tenantId, (client) => client.query("select id from tenant_prohibited_term_revisions")), (error) => error.code === "42501");
    } finally {
      worker.release();
    }
    assert.ok(currentTermId);
  });
});
