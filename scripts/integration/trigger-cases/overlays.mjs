// Frozen overlay scenes (migration 090): editing gates, the one-way scene freeze, approval readiness and shape checks.
import { createHash, randomUUID } from "node:crypto";

const TABLE = "show_revision_overlays";
const OVERLAY_TRIGGER = "show_revision_overlays_governed";
const APPROVAL_TRIGGER = "show_revisions_require_frozen_overlay";
const EDIT_MESSAGE = "Show revision overlays are editable only in an attached DRAFT run or draft revision request";
const FROZEN_MESSAGE = "Frozen show revision overlays are immutable";
const SCENE = '{"caption":{"enabled":true}}';
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

const readOverlay = (_ctx, a) => ({
  sql: "select tenant_id, show_revision_id, caption_enabled, product_card_enabled, price_sticker_enabled, background_mode, background_media_asset_id, scene_json, scene_sha256, frozen_at from show_revision_overlays where show_revision_id = $1",
  params: [a.revisionId]
});
const readRevision = (_ctx, a) => ({ sql: "select id, approval_status from show_revisions where id = $1", params: [a.revisionId] });

async function draftRevision(ctx) {
  const tenantId = await ctx.seed.tenant();
  const memberId = await ctx.seed.member({ tenantId, role: "admin" });
  const { showId, revisionId } = await ctx.seed.revision({ tenantId, approver: memberId, segments: [], bindings: "none", approve: false });
  return { tenantId, memberId, showId, revisionId };
}

async function addLexiconSnapshot({ client }, a) {
  await client.query("insert into show_revision_prohibited_term_snapshots (tenant_id, show_revision_id, builtin_version, lexicon, lexicon_sha256, term_count) values ($1, $2, 'integration-seed', '[]'::jsonb, repeat('0', 64), 0)", [a.tenantId, a.revisionId]);
}

async function approveRevision(ctx, a) {
  await addLexiconSnapshot(ctx, a);
  await ctx.client.query("update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [a.revisionId, a.memberId]);
}

async function insertOverlay({ client }, a, values = {}) {
  const fields = Object.keys(values);
  const columns = ["tenant_id", "show_revision_id", "updated_by", ...fields];
  const params = [a.tenantId, a.revisionId, a.memberId, ...fields.map((field) => values[field])];
  const placeholders = params.map((_, index) => `$${index + 1}`);
  await client.query(`insert into ${TABLE} (${columns.join(", ")}) values (${placeholders.join(", ")})`, params);
}

async function approvedOverlay(ctx, values = {}) {
  const a = await draftRevision(ctx);
  await insertOverlay(ctx, a, values);
  await approveRevision(ctx, a);
  return a;
}

async function draftRequest(ctx) {
  const base = await draftRevision(ctx);
  await approveRevision(ctx, base);
  const liveRunId = await ctx.seed.liveRun({ tenantId: base.tenantId, revisionId: base.revisionId, state: "LIVE" });
  const candidateRevisionId = randomUUID();
  await ctx.client.query("insert into show_revisions (id, tenant_id, show_id, revision, plan, approval_status) values ($1, $2, $3, 2, '{}'::jsonb, 'draft')", [candidateRevisionId, base.tenantId, base.showId]);
  await ctx.client.query("insert into show_program_change_requests (tenant_id, live_run_id, source_revision_id, candidate_revision_id, source_program_sha256, created_by) values ($1, $2, $3, $4, repeat('a', 64), $5)", [base.tenantId, liveRunId, base.revisionId, candidateRevisionId, base.memberId]);
  return { ...base, revisionId: candidateRevisionId, liveRunId };
}

function rejectedInsert(name, constraint, values) {
  return {
    id: `show_revision_overlays.constraint.insert.${name}.reject`,
    table: TABLE, trigger: OVERLAY_TRIGGER, op: "INSERT", expect: "reject", message: constraint,
    arrange: draftRevision,
    act: (_ctx, a) => {
      const fields = Object.keys(values);
      const columns = ["tenant_id", "show_revision_id", "updated_by", ...fields];
      const params = [a.tenantId, a.revisionId, a.memberId, ...fields.map((field) => values[field])];
      return { sql: `insert into ${TABLE} (${columns.join(", ")}) values (${params.map((_, index) => `$${index + 1}`).join(", ")})`, params };
    },
    readBack: readOverlay
  };
}

export default [
  {
    id: "show_revision_overlays.governed.insert.draft_revision.accept",
    table: TABLE, trigger: OVERLAY_TRIGGER, op: "INSERT", expect: "accept",
    arrange: draftRevision,
    act: (_ctx, a) => ({ sql: `insert into ${TABLE} (tenant_id, show_revision_id, caption_enabled, updated_by) values ($1, $2, true, $3)`, params: [a.tenantId, a.revisionId, a.memberId] }),
    readBack: readOverlay,
    expectedAfter: (a) => [{ tenant_id: a.tenantId, show_revision_id: a.revisionId, caption_enabled: true, scene_json: null, scene_sha256: null, frozen_at: null }]
  },
  {
    id: "show_revision_overlays.governed.insert.draft_run.accept",
    table: TABLE, trigger: OVERLAY_TRIGGER, op: "INSERT", expect: "accept",
    arrange: async (ctx) => {
      const a = await draftRevision(ctx);
      a.liveRunId = await ctx.seed.liveRun({ tenantId: a.tenantId, revisionId: a.revisionId, state: "DRAFT" });
      return a;
    },
    act: (_ctx, a) => ({ sql: `insert into ${TABLE} (tenant_id, show_revision_id, updated_by) values ($1, $2, $3)`, params: [a.tenantId, a.revisionId, a.memberId] }),
    readBack: readOverlay,
    expectedAfter: (a) => [{ tenant_id: a.tenantId, show_revision_id: a.revisionId, caption_enabled: false }]
  },
  {
    id: "show_revision_overlays.governed.update.draft_run.accept",
    table: TABLE, trigger: OVERLAY_TRIGGER, op: "UPDATE", updatedColumns: ["caption_enabled"], expect: "accept",
    arrange: async (ctx) => {
      const a = await draftRevision(ctx);
      await insertOverlay(ctx, a);
      a.liveRunId = await ctx.seed.liveRun({ tenantId: a.tenantId, revisionId: a.revisionId, state: "DRAFT" });
      return a;
    },
    act: (_ctx, a) => ({ sql: `update ${TABLE} set caption_enabled = true where show_revision_id = $1`, params: [a.revisionId] }),
    readBack: readOverlay,
    expectedAfter: (a) => [{ tenant_id: a.tenantId, show_revision_id: a.revisionId, caption_enabled: true }]
  },
  {
    id: "show_revision_overlays.governed.delete.draft_run.accept",
    table: TABLE, trigger: OVERLAY_TRIGGER, op: "DELETE", expect: "accept",
    arrange: async (ctx) => {
      const a = await draftRevision(ctx);
      await insertOverlay(ctx, a);
      a.liveRunId = await ctx.seed.liveRun({ tenantId: a.tenantId, revisionId: a.revisionId, state: "DRAFT" });
      return a;
    },
    act: (_ctx, a) => ({ sql: `delete from ${TABLE} where show_revision_id = $1`, params: [a.revisionId] }),
    readBack: readOverlay,
    expectedAfter: () => []
  },
  {
    id: "show_revision_overlays.governed.update.draft_change_request.accept",
    table: TABLE, trigger: OVERLAY_TRIGGER, op: "UPDATE", updatedColumns: ["caption_enabled"], expect: "accept",
    arrange: async (ctx) => { const a = await draftRequest(ctx); await insertOverlay(ctx, a); return a; },
    act: (_ctx, a) => ({ sql: `update ${TABLE} set caption_enabled = true where show_revision_id = $1`, params: [a.revisionId] }),
    readBack: readOverlay,
    expectedAfter: (a) => [{ tenant_id: a.tenantId, show_revision_id: a.revisionId, caption_enabled: true }]
  },
  {
    id: "show_revision_overlays.governed.insert.approved.reject",
    table: TABLE, trigger: OVERLAY_TRIGGER, op: "INSERT", expect: "reject", message: EDIT_MESSAGE,
    arrange: async (ctx) => { const a = await draftRevision(ctx); await approveRevision(ctx, a); return a; },
    act: (_ctx, a) => ({ sql: `insert into ${TABLE} (tenant_id, show_revision_id, updated_by) values ($1, $2, $3)`, params: [a.tenantId, a.revisionId, a.memberId] }),
    readBack: readOverlay
  },
  {
    id: "show_revision_overlays.governed.update.approved.reject",
    table: TABLE, trigger: OVERLAY_TRIGGER, op: "UPDATE", updatedColumns: ["caption_enabled"], expect: "reject", message: EDIT_MESSAGE,
    arrange: (ctx) => approvedOverlay(ctx),
    act: (_ctx, a) => ({ sql: `update ${TABLE} set caption_enabled = true where show_revision_id = $1`, params: [a.revisionId] }),
    readBack: readOverlay
  },
  {
    id: "show_revision_overlays.governed.delete.approved.reject",
    table: TABLE, trigger: OVERLAY_TRIGGER, op: "DELETE", expect: "reject", message: EDIT_MESSAGE,
    arrange: (ctx) => approvedOverlay(ctx),
    act: (_ctx, a) => ({ sql: `delete from ${TABLE} where show_revision_id = $1`, params: [a.revisionId] }),
    readBack: readOverlay
  },
  {
    id: "show_revision_overlays.governed.update.freeze.accept",
    table: TABLE, trigger: OVERLAY_TRIGGER, op: "UPDATE", updatedColumns: ["scene_json", "scene_sha256", "frozen_at"], expect: "accept",
    arrange: async (ctx) => { const a = await draftRevision(ctx); await insertOverlay(ctx, a, { caption_enabled: true }); return a; },
    act: (_ctx, a) => ({ sql: `update ${TABLE} set scene_json = $2, scene_sha256 = $3, frozen_at = now() where show_revision_id = $1`, params: [a.revisionId, SCENE, sha256(SCENE)] }),
    readBack: readOverlay,
    expectedAfter: (a) => [{ tenant_id: a.tenantId, show_revision_id: a.revisionId, caption_enabled: true, scene_json: SCENE, scene_sha256: sha256(SCENE) }]
  },
  {
    id: "show_revision_overlays.governed.update.freeze_with_config_change.reject",
    table: TABLE, trigger: OVERLAY_TRIGGER, op: "UPDATE", updatedColumns: ["caption_enabled", "scene_json", "scene_sha256", "frozen_at"], expect: "reject", message: EDIT_MESSAGE,
    arrange: async (ctx) => { const a = await draftRevision(ctx); await insertOverlay(ctx, a); return a; },
    act: (_ctx, a) => ({ sql: `update ${TABLE} set caption_enabled = true, scene_json = $2, scene_sha256 = $3, frozen_at = now() where show_revision_id = $1`, params: [a.revisionId, SCENE, sha256(SCENE)] }),
    readBack: readOverlay
  },
  {
    id: "show_revision_overlays.governed.update.frozen.reject",
    table: TABLE, trigger: OVERLAY_TRIGGER, op: "UPDATE", updatedColumns: ["caption_enabled"], expect: "reject", message: FROZEN_MESSAGE,
    arrange: async (ctx) => { const a = await draftRevision(ctx); await insertOverlay(ctx, a, { caption_enabled: true }); await ctx.client.query(`update ${TABLE} set scene_json = $2, scene_sha256 = $3, frozen_at = now() where show_revision_id = $1`, [a.revisionId, SCENE, sha256(SCENE)]); return a; },
    act: (_ctx, a) => ({ sql: `update ${TABLE} set caption_enabled = false where show_revision_id = $1`, params: [a.revisionId] }),
    readBack: readOverlay
  },
  rejectedInsert("price_without_product_card", "show_revision_overlays_check", { price_sticker_enabled: true }),
  rejectedInsert("canvas_without_asset", "show_revision_overlays_check1", { background_mode: "canvas" }),
  rejectedInsert("scene_hash_mismatch", "show_revision_overlays_check3", { scene_json: SCENE, scene_sha256: "0".repeat(64), frozen_at: new Date() }),
  {
    id: "show_revisions.frozen_overlay_approval.enabled_unfrozen.reject",
    table: "show_revisions", trigger: APPROVAL_TRIGGER, op: "UPDATE", updatedColumns: ["approval_status"], expect: "reject",
    message: "Approved show revisions with enabled overlays require a frozen scene",
    arrange: async (ctx) => { const a = await draftRevision(ctx); await insertOverlay(ctx, a, { caption_enabled: true }); await addLexiconSnapshot(ctx, a); return a; },
    act: (_ctx, a) => ({ sql: "update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", params: [a.revisionId, a.memberId] }),
    readBack: readRevision
  },
  {
    id: "show_revisions.frozen_overlay_approval.all_disabled.accept",
    table: "show_revisions", trigger: APPROVAL_TRIGGER, op: "UPDATE", updatedColumns: ["approval_status"], expect: "accept",
    arrange: async (ctx) => { const a = await draftRevision(ctx); await insertOverlay(ctx, a); await addLexiconSnapshot(ctx, a); return a; },
    act: (_ctx, a) => ({ sql: "update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", params: [a.revisionId, a.memberId] }),
    readBack: readRevision,
    expectedAfter: (a) => [{ id: a.revisionId, approval_status: "approved" }]
  },
  {
    id: "show_revisions.frozen_overlay_approval.no_overlay.accept",
    table: "show_revisions", trigger: APPROVAL_TRIGGER, op: "UPDATE", updatedColumns: ["approval_status"], expect: "accept",
    arrange: async (ctx) => { const a = await draftRevision(ctx); await addLexiconSnapshot(ctx, a); return a; },
    act: (_ctx, a) => ({ sql: "update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", params: [a.revisionId, a.memberId] }),
    readBack: readRevision,
    expectedAfter: (a) => [{ id: a.revisionId, approval_status: "approved" }]
  }
];
