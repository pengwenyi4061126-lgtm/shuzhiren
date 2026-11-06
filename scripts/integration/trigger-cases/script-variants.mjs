// Script variants (migration 085): live_run_script_plays_governed on INSERT, UPDATE and DELETE of the rotation
// ledger, and the variant column of show_revision_segments behind the existing show_revision_segments_immutable
// trigger (064) and the show_revision_segments_runtime_script_variants_check constraint. Message texts are the
// raise exception texts of enforce_live_run_script_play() in 085 and of reject_show_revision_segment_mutation()
// in 064; the constraint cases expect the constraint name PostgreSQL puts into its error.
import { createHash, randomUUID } from "node:crypto";
const PLAYS = "live_run_script_plays";
const PLAY_TRIGGER = "live_run_script_plays_governed";
const SEGMENTS = "show_revision_segments";
const SEGMENT_TRIGGER = "show_revision_segments_immutable";
const VARIANT_CHECK = "show_revision_segments_runtime_script_variants_check";
const MAIN_SCRIPT = "本段仅播报已批准的商品事实。";
const VARIANTS = ["这一段只讲已批准的商品信息。", "下面介绍的内容都来自已批准的商品资料。"];
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const scriptAt = (index) => (index === 0 ? MAIN_SCRIPT : VARIANTS[index - 1]);

const readPlay = (_ctx, a) => ({ sql: "select id, tenant_id, live_run_id, show_revision_id, segment_id, play_seq, variant_index, variant_count, script_sha256, control_action, skipped_variant_indexes from live_run_script_plays where id = $1", params: [a.playId] });
const readSegment = (_ctx, a) => ({ sql: "select id, runtime_script, runtime_script_variants from show_revision_segments where id = $1", params: [a.segmentId] });

async function insertSegment({ client }, { tenantId, revisionId, position, kind = "prepared_product", runtimeScript = MAIN_SCRIPT, variants = [] }) {
  const segmentId = randomUUID();
  await client.query(
    "insert into show_revision_segments (id, tenant_id, show_revision_id, position, kind, title, purpose, duration_seconds, runtime_script, runtime_script_variants, is_fallback) values ($1, $2, $3, $4, $5::program_segment_kind, $6, 'Integration segment', 60, $7, $8::jsonb, $9)",
    [segmentId, tenantId, revisionId, position, kind, `Segment ${position}`, runtimeScript, JSON.stringify(variants), kind === "fallback"]
  );
  return segmentId;
}

/** A draft revision without a run: segments can be inserted (and nothing else changed) until it is approved. */
async function draftRevision(ctx) {
  const tenantId = await ctx.seed.tenant();
  const memberId = await ctx.seed.member({ tenantId, role: "admin" });
  const { revisionId } = await ctx.seed.revision({ tenantId, approver: memberId, segments: [], approve: false });
  return { tenantId, memberId, revisionId };
}
const approveRevision = ({ client }, { revisionId, memberId }) =>
  client.query("update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [revisionId, memberId]);

/**
 * An approved revision with a runnable segment (main script plus two variants) and a non-runnable fallback
 * segment, and a DRAFT run on it. The segments are inserted before the run exists, as the editing rules require.
 */
async function ledgerFixture(ctx, { plays = 0 } = {}) {
  const base = await draftRevision(ctx);
  const segmentId = await insertSegment(ctx, { ...base, position: 1, variants: VARIANTS });
  const fallbackSegmentId = await insertSegment(ctx, { ...base, position: 2, kind: "fallback", runtimeScript: null });
  await approveRevision(ctx, base);
  const other = await ctx.seed.revision({ tenantId: base.tenantId, approver: base.memberId, segments: [{ kind: "prepared_product", runtimeScript: MAIN_SCRIPT }] });
  const liveRunId = await ctx.seed.liveRun({ tenantId: base.tenantId, revisionId: base.revisionId });
  const fixture = { ...base, segmentId, fallbackSegmentId, otherRevisionId: other.revisionId, otherSegmentId: other.segmentIds[0], liveRunId, playId: randomUUID(), lastPlayId: null };
  for (let seq = 1; seq <= plays; seq += 1) fixture.lastPlayId = await insertPlay(ctx, fixture, { playSeq: seq, variantIndex: (seq - 1) % 3 });
  return fixture;
}

/** Inserts one outbox event and one ledger row; `overrides` replace the legal defaults. */
async function insertPlay({ client, seed }, a, { id = randomUUID(), segmentId = a.segmentId, revisionId = a.revisionId, playSeq = 1, variantIndex = 0, variantCount = 3, sha, controlAction = "START" } = {}) {
  const outboxEventId = await seed.outboxEvent({ tenantId: a.tenantId, aggregateId: a.liveRunId });
  await client.query(
    "insert into live_run_script_plays (id, tenant_id, live_run_id, show_revision_id, segment_id, play_seq, variant_index, variant_count, script_sha256, control_action, outbox_event_id, skipped_variant_indexes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}')",
    [id, a.tenantId, a.liveRunId, revisionId, segmentId, playSeq, variantIndex, variantCount, sha ?? sha256(scriptAt(variantIndex)), controlAction, outboxEventId]
  );
  return id;
}

/** Wraps an arrange function: the ledger row the act inserts needs its own outbox event (a.outboxEventId). */
const withOutboxEvent = (arrange) => async (ctx) => {
  const fixture = await arrange(ctx);
  return { ...fixture, outboxEventId: await ctx.seed.outboxEvent({ tenantId: fixture.tenantId, aggregateId: fixture.liveRunId }) };
};

/** An insert case that is rejected by enforce_live_run_script_play(): arrange the fixture, then insert `overrides`. */
function rejectedInsert(name, message, { plays = 0, overrides = () => ({}) }) {
  return {
    id: `live_run_script_plays.governed.insert.${name}.reject`,
    table: PLAYS, trigger: PLAY_TRIGGER, op: "INSERT", expect: "reject", message,
    arrange: withOutboxEvent((ctx) => ledgerFixture(ctx, { plays })),
    act: (_ctx, a) => {
      const o = { playSeq: plays + 1, variantIndex: 0, variantCount: 3, revisionId: a.revisionId, segmentId: a.segmentId, ...overrides(a) };
      return {
        sql: "insert into live_run_script_plays (id, tenant_id, live_run_id, show_revision_id, segment_id, play_seq, variant_index, variant_count, script_sha256, control_action, outbox_event_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'START', $10)",
        params: [a.playId, a.tenantId, a.liveRunId, o.revisionId, o.segmentId, o.playSeq, o.variantIndex, o.variantCount, o.sha ?? sha256(scriptAt(o.variantIndex)), a.outboxEventId]
      };
    },
    readBack: readPlay
  };
}

/** An insert into a draft revision that the variants constraint refuses. */
function rejectedVariants(name, { kind = "prepared_product", runtimeScript = MAIN_SCRIPT, variants }) {
  return {
    id: `show_revision_segments.variants.insert.${name}.reject`,
    table: SEGMENTS, trigger: SEGMENT_TRIGGER, op: "INSERT", expect: "reject", message: VARIANT_CHECK,
    arrange: async (ctx) => ({ ...(await draftRevision(ctx)), segmentId: randomUUID() }),
    act: (_ctx, a) => ({
      sql: "insert into show_revision_segments (id, tenant_id, show_revision_id, position, kind, title, purpose, duration_seconds, runtime_script, runtime_script_variants, is_fallback) values ($1, $2, $3, 1, $4::program_segment_kind, 'Segment 1', 'Integration segment', 60, $5, $6::jsonb, $7)",
      params: [a.segmentId, a.tenantId, a.revisionId, kind, runtimeScript, JSON.stringify(variants), kind === "fallback"]
    }),
    readBack: readSegment
  };
}

export default [
  {
    id: "live_run_script_plays.governed.insert.first_play.accept",
    table: PLAYS, trigger: PLAY_TRIGGER, op: "INSERT", expect: "accept",
    arrange: withOutboxEvent(ledgerFixture),
    act: (_ctx, a) => ({
      sql: "insert into live_run_script_plays (id, tenant_id, live_run_id, show_revision_id, segment_id, play_seq, variant_index, variant_count, script_sha256, control_action, outbox_event_id) values ($1, $2, $3, $4, $5, 1, 0, 3, $6, 'START', $7)",
      params: [a.playId, a.tenantId, a.liveRunId, a.revisionId, a.segmentId, sha256(MAIN_SCRIPT), a.outboxEventId]
    }),
    readBack: readPlay,
    expectedAfter: (a) => [{ id: a.playId, tenant_id: a.tenantId, live_run_id: a.liveRunId, segment_id: a.segmentId, play_seq: 1, variant_index: 0, variant_count: 3, script_sha256: sha256(MAIN_SCRIPT), control_action: "START", skipped_variant_indexes: [] }]
  },
  {
    id: "live_run_script_plays.governed.insert.next_variant.accept",
    table: PLAYS, trigger: PLAY_TRIGGER, op: "INSERT", expect: "accept",
    arrange: withOutboxEvent((ctx) => ledgerFixture(ctx, { plays: 1 })),
    act: (_ctx, a) => ({
      sql: "insert into live_run_script_plays (id, tenant_id, live_run_id, show_revision_id, segment_id, play_seq, variant_index, variant_count, script_sha256, control_action, outbox_event_id, skipped_variant_indexes) values ($1, $2, $3, $4, $5, 2, 2, 3, $6, 'INSERT_PROGRAM', $7, '{1}')",
      params: [a.playId, a.tenantId, a.liveRunId, a.revisionId, a.segmentId, sha256(VARIANTS[1]), a.outboxEventId]
    }),
    readBack: readPlay,
    expectedAfter: (a) => [{ id: a.playId, play_seq: 2, variant_index: 2, variant_count: 3, script_sha256: sha256(VARIANTS[1]), control_action: "INSERT_PROGRAM", skipped_variant_indexes: [1] }]
  },
  {
    id: "live_run_script_plays.governed.update.reject",
    table: PLAYS, trigger: PLAY_TRIGGER, op: "UPDATE", expect: "reject",
    message: "live run script plays are append-only",
    arrange: async (ctx) => {
      const fixture = await ledgerFixture(ctx, { plays: 1 });
      return { ...fixture, playId: fixture.lastPlayId };
    },
    act: (_ctx, a) => ({ sql: "update live_run_script_plays set control_action = 'RECOVER' where id = $1", params: [a.playId] }),
    readBack: readPlay
  },
  {
    id: "live_run_script_plays.governed.delete.reject",
    table: PLAYS, trigger: PLAY_TRIGGER, op: "DELETE", expect: "reject",
    message: "live run script plays are append-only",
    arrange: async (ctx) => {
      const fixture = await ledgerFixture(ctx, { plays: 1 });
      return { ...fixture, playId: fixture.lastPlayId };
    },
    act: (_ctx, a) => ({ sql: "delete from live_run_script_plays where id = $1", params: [a.playId] }),
    readBack: readPlay
  },
  rejectedInsert("sequence_gap", "live run script play sequence must follow the last recorded play of the segment", { overrides: () => ({ playSeq: 2 }) }),
  rejectedInsert("sequence_repeat", "live run script play sequence must follow the last recorded play of the segment", { plays: 1, overrides: () => ({ playSeq: 1 }) }),
  rejectedInsert("hash_mismatch", "live run script play hash does not match the selected script version", { overrides: () => ({ variantIndex: 1, sha: sha256(MAIN_SCRIPT) }) }),
  rejectedInsert("variant_count_mismatch", "live run script play variant count does not match the segment", { overrides: () => ({ variantCount: 2 }) }),
  rejectedInsert("segment_of_other_revision", "live run script plays must use a segment of the current show revision of the run", { overrides: (a) => ({ segmentId: a.otherSegmentId }) }),
  rejectedInsert("segment_not_runnable", "live run script plays require a runnable program segment", { overrides: (a) => ({ segmentId: a.fallbackSegmentId, variantCount: 1 }) }),
  rejectedInsert("other_revision", "live run script plays must use the current show revision of the run", { overrides: (a) => ({ revisionId: a.otherRevisionId }) }),

  {
    id: "show_revision_segments.variants.insert.four_variants.accept",
    table: SEGMENTS, trigger: SEGMENT_TRIGGER, op: "INSERT", expect: "accept",
    arrange: async (ctx) => ({ ...(await draftRevision(ctx)), segmentId: randomUUID() }),
    act: (_ctx, a) => ({
      sql: "insert into show_revision_segments (id, tenant_id, show_revision_id, position, kind, title, purpose, duration_seconds, runtime_script, runtime_script_variants) values ($1, $2, $3, 1, 'interactive', 'Segment 1', 'Integration segment', 60, $4, $5::jsonb)",
      params: [a.segmentId, a.tenantId, a.revisionId, MAIN_SCRIPT, JSON.stringify(["版本一", "版本二", "版本三", "x".repeat(800)])]
    }),
    readBack: readSegment,
    expectedAfter: (a) => [{ id: a.segmentId, runtime_script: MAIN_SCRIPT, runtime_script_variants: ["版本一", "版本二", "版本三", "x".repeat(800)] }]
  },
  rejectedVariants("five_variants", { variants: ["一", "二", "三", "四", "五"] }),
  rejectedVariants("duplicate", { variants: ["相同的版本", "相同的版本"] }),
  rejectedVariants("same_as_main", { variants: [MAIN_SCRIPT] }),
  rejectedVariants("blank", { variants: ["  \t "] }),
  rejectedVariants("too_long", { variants: ["x".repeat(801)] }),
  rejectedVariants("not_a_string", { variants: [42] }),
  rejectedVariants("on_fallback_segment", { kind: "fallback", runtimeScript: null, variants: ["版本一"] }),
  rejectedVariants("without_main_script", { runtimeScript: null, variants: ["版本一"] }),
  {
    id: "show_revision_segments.variants.update.approved.reject",
    table: SEGMENTS, trigger: SEGMENT_TRIGGER, op: "UPDATE", updatedColumns: ["runtime_script_variants"], expect: "reject",
    message: "Show program segments are editable only in an attached DRAFT run or draft revision request",
    arrange: async (ctx) => {
      const base = await draftRevision(ctx);
      const segmentId = await insertSegment(ctx, { ...base, position: 1, variants: VARIANTS });
      await approveRevision(ctx, base);
      return { ...base, segmentId };
    },
    act: (_ctx, a) => ({ sql: "update show_revision_segments set runtime_script_variants = '[\"改写后的版本\"]'::jsonb where id = $1", params: [a.segmentId] }),
    readBack: readSegment
  }
];
