// Knowledge base, database layer (migrations 086 and 087) against a real PostgreSQL cluster: the tenant check and
// the product binding of knowledge_answer_candidates, its row limit, the privileges of the runtime worker, the
// shape constraints of "faq" interaction rules, row-level security of the knowledge tables, and the composite
// tenant foreign keys. The triggers of the knowledge tables are covered by trigger-cases/knowledge-base.mjs.
// Application paths (console services, worker rule matching) are covered by tasks that append to this file.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { register } from "node:module";
import { after, before, describe, test } from "node:test";
import { createHarness } from "./harness.mjs";
import { inTenantTransaction } from "../../apps/runtime-worker/db.mjs";
import { createInteractionRuleEvaluator, interactionRuleConfig } from "../../apps/runtime-worker/interaction-rules.mjs";

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
let h;
let worker;
let controlPlane;
let workerPool;
let knowledge;
let rules;
let prohibitedTerms;
let policyProfiles;
let responseDraftRoute;
let replyDraftRoute;

before(async () => {
  h = await createHarness(import.meta.url);
  worker = await h.connectAs("runtime_worker");
  controlPlane = await h.connectAs("control_plane");
  workerPool = h.pool("runtime_worker", { max: 4 });
  for (const name of ["CONTROL_PLANE_DEMO_MODE", "CONTROL_PLANE_DEV_HEADER_IDENTITY"]) delete process.env[name];
  process.env.DATABASE_URL = h.url("control_plane");
  register("../lib/console-ts-loader.mjs", import.meta.url);
  knowledge = await import("../../apps/console/lib/knowledge-base.ts");
  rules = await import("../../apps/console/lib/interaction-rules.ts");
  prohibitedTerms = await import("../../apps/console/lib/prohibited-terms.ts");
  policyProfiles = await import("../../apps/console/lib/policy-profiles.ts");
  responseDraftRoute = await import("../../apps/console/app/api/v1/live-runs/[runId]/response-drafts/route.ts");
  replyDraftRoute = await import("../../apps/console/app/api/v1/live-runs/[runId]/reply-drafts/route.ts");
  process.env.CONTROL_PLANE_DEV_HEADER_IDENTITY = "true";
  process.env.HOSTNAME = "127.0.0.1";
});

after(async () => {
  await globalThis.shuzhirenDatabasePool?.end().catch(() => undefined);
  await workerPool?.end().catch(() => undefined);
  await worker?.end().catch(() => undefined);
  await controlPlane?.end().catch(() => undefined);
  await h?.close();
});

/** A statement that must fail: the error message, or null when it succeeded. The failed statement is rolled back. */
async function rejected(client, sql, params = []) {
  await client.query("savepoint probe");
  try {
    await client.query(sql, params);
    return null;
  } catch (error) {
    return error.message;
  } finally {
    await client.query("rollback to savepoint probe");
  }
}

/**
 * A tenant with two products, each with an approved version, and one LIVE run per product plus a run without a
 * product version. The run's revision binds the product version as "primary".
 */
async function fixture() {
  const { seed, admin } = h;
  const tenantId = await seed.tenant();
  const subject = `it-kb-${randomUUID()}`;
  const reviewerSubject = `it-kb-reviewer-${randomUUID()}`;
  const memberId = await seed.member({ tenantId, role: "admin", subject });
  const reviewerId = await seed.member({ tenantId, role: "reviewer", subject: reviewerSubject });
  const channelId = await seed.channelConnection({ tenantId, verifier: memberId });
  const policyProfileId = await seed.policyProfile({
    tenantId,
    approver: memberId,
    rules: [{ id: "block_term", terms: ["Block_Term"], reason: "集成测试阻断词", action: "refuse", riskLevel: "high", requiredEvidence: [] }]
  });
  const products = [];
  for (const name of ["洁面慕斯", "防晒霜"]) {
    const productId = randomUUID();
    await admin.query("insert into products (id, tenant_id, external_sku, name) values ($1, $2, $3, $4)", [productId, tenantId, `it-kb-${productId}`, name]);
    const productVersionId = await seed.productVersion({ tenantId, approver: memberId, productId, facts: { priceCent: 9900, stock: 20 } });
    products.push({ productId, productVersionId });
  }
  const runs = [];
  for (const product of [...products, null]) {
    const { revisionId } = await seed.revision({ tenantId, approver: memberId, bindings: "none", approve: false });
    await admin.query("insert into show_revision_policy_profiles (tenant_id, show_revision_id, policy_profile_id) values ($1, $2, $3)", [tenantId, revisionId, policyProfileId]);
    if (product) await admin.query("insert into show_revision_product_versions (tenant_id, show_revision_id, product_version_id, slot_key) values ($1, $2, $3, 'primary')", [tenantId, revisionId, product.productVersionId]);
    await admin.query("insert into show_revision_prohibited_term_snapshots (tenant_id, show_revision_id, builtin_version, lexicon, lexicon_sha256, term_count) values ($1, $2, 'integration-seed', '[]'::jsonb, repeat('0', 64), 0)", [tenantId, revisionId]);
    await admin.query("update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [revisionId, memberId]);
    runs.push(await seed.liveRun({ tenantId, revisionId, state: "LIVE", channelId, productVersionId: product?.productVersionId ?? null }));
  }
  return { tenantId, memberId, reviewerId, subject, reviewerSubject, channelId, products, runs: { first: runs[0], second: runs[1], unbound: runs[2] } };
}

function requestContext(f, role = "admin") {
  const reviewer = role === "reviewer";
  return { tenantId: f.tenantId, actorId: reviewer ? f.reviewerSubject : f.subject, actorName: reviewer ? "知识库审核员" : "知识库编辑员", role, accessScope: "tenant" };
}

function routeRequest(f, body, role = "admin") {
  const actor = requestContext(f, role);
  return new Request("http://127.0.0.1/api/v1/test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tenant-id": actor.tenantId,
      "x-actor-id": actor.actorId,
      "x-actor-name": actor.actorName,
      "x-actor-role": actor.role
    },
    body: JSON.stringify(body)
  });
}

function evaluator(tenantId) {
  return createInteractionRuleEvaluator({
    tenantIds: async () => [tenantId],
    inTenantTransaction: (tenant, operation) => inTenantTransaction(workerPool, tenant, operation),
    config: interactionRuleConfig({}),
    maxOutboxAttempts: 6,
    random: () => 0
  });
}

async function comment(f, text) {
  const id = randomUUID();
  await h.admin.query(`insert into live_interactions (id, tenant_id, live_run_id, source, channel_connection_id, question_text, risk_level, policy_action, interaction_kind, viewer_ref, viewer_nickname, status)
    values ($1, $2, $3, 'channel:integration', $4, $5, 'low', 'answer', 'comment', $6, '观众甲', 'queued')`,
  [id, f.tenantId, f.runs.first, (await h.admin.query("select channel_connection_id from live_runs where id = $1", [f.runs.first])).rows[0].channel_connection_id, text, sha256(id)]);
  return id;
}

/** An entry that went through the legal path: pending, snapshot of its revision, approved. */
async function approvedEntry(f, { question = "退货规则是什么", answer = "支持七天无理由退货。", terms = ["退货", "货规", "规则"], productId = null, client = h.admin } = {}) {
  const entryId = randomUUID();
  const approvalId = randomUUID();
  await client.query(
    "insert into knowledge_entries (id, tenant_id, kind, question, answer, search_terms, product_id, created_by, updated_by) values ($1, $2, 'faq', $3, $4, $5::text[], $6, $7, $7)",
    [entryId, f.tenantId, question, answer, terms, productId, f.memberId]
  );
  await client.query(
    "insert into knowledge_entry_approvals (id, tenant_id, entry_id, revision, question, alias_questions, answer, keywords, search_terms, product_id, answer_sha256, lexicon_sha256, approved_by) values ($1, $2, $3, 1, $4, '[]'::jsonb, $5, '[]'::jsonb, $6::text[], $7, $8, $9, $10)",
    [approvalId, f.tenantId, entryId, question, answer, terms, productId, sha256(answer), "b".repeat(64), f.reviewerId]
  );
  await client.query("update knowledge_entries set status = 'approved', approved_approval_id = $2 where id = $1", [entryId, approvalId]);
  return { entryId, approvalId };
}

const candidates = (client, tenantId, runId, terms, maxRows = 20) =>
  client.query("select approval_id, entry_id, revision, question, answer, answer_sha256 from knowledge_answer_candidates($1::uuid, $2::uuid, $3::text[], $4::integer) order by question", [tenantId, runId, terms, maxRows]).then((result) => result.rows);

describe("knowledge_answer_candidates", () => {
  test("reports an error in a transaction of another tenant and without a tenant transaction", async () => {
    const a = await fixture();
    const b = await fixture();
    await approvedEntry(a);
    await h.withTenant(worker, b.tenantId, async (c) => {
      assert.match(await rejected(c, "select * from knowledge_answer_candidates($1::uuid, $2::uuid, $3::text[], 20)", [a.tenantId, a.runs.first, ["退货"]]), /active tenant transaction/);
      assert.deepEqual(await candidates(c, b.tenantId, b.runs.first, ["退货"]), [], "the tenant's own transaction sees only its own entries");
    });
    await worker.query("begin");
    try {
      assert.match(await rejected(worker, "select * from knowledge_answer_candidates($1::uuid, $2::uuid, $3::text[], 20)", [a.tenantId, a.runs.first, ["退货"]]), /active tenant transaction/);
      assert.match(await rejected(worker, "select * from knowledge_answer_candidates(null::uuid, $1::uuid, $2::text[], 20)", [a.runs.first, ["退货"]]), /active tenant transaction/);
    } finally {
      await worker.query("rollback");
    }
  });

  test("returns only approved snapshots that share a term, with the answer and hash of the approval", async () => {
    const f = await fixture();
    const live = await approvedEntry(f, { question: "退货规则是什么", answer: "支持七天无理由退货。", terms: ["退货", "货规"] });
    await approvedEntry(f, { question: "发货时间", answer: "下单后四十八小时内发货。", terms: ["发货", "货时"] });
    const pending = randomUUID();
    await h.admin.query("insert into knowledge_entries (id, tenant_id, kind, question, answer, search_terms, created_by, updated_by) values ($1, $2, 'faq', '未批准的问题', '未批准的答案', '{退货}', $3, $3)", [pending, f.tenantId, f.memberId]);
    const retired = await approvedEntry(f, { question: "已下线的问题", answer: "已下线的答案", terms: ["退货"] });
    await h.admin.query("update knowledge_entries set status = 'retired', approved_approval_id = null, retired_at = now() where id = $1", [retired.entryId]);
    const edited = await approvedEntry(f, { question: "修改后的问题", answer: "修改前的答案", terms: ["退货"] });
    await h.admin.query("update knowledge_entries set answer = '修改后的答案', status = 'pending', approved_approval_id = null, revision = 2 where id = $1", [edited.entryId]);
    await h.withTenant(worker, f.tenantId, async (c) => {
      const rows = await candidates(c, f.tenantId, f.runs.first, ["退货"]);
      assert.deepEqual(rows.map((row) => row.question), ["退货规则是什么"], "pending, retired and edited-but-not-approved entries are not candidates");
      assert.deepEqual([rows[0].approval_id, rows[0].entry_id, rows[0].revision, rows[0].answer, rows[0].answer_sha256], [live.approvalId, live.entryId, 1, "支持七天无理由退货。", sha256("支持七天无理由退货。")]);
      assert.deepEqual((await candidates(c, f.tenantId, f.runs.first, ["发货", "退货"])).map((row) => row.question), ["发货时间", "退货规则是什么"]);
      assert.deepEqual(await candidates(c, f.tenantId, f.runs.first, ["不存在"]), []);
      assert.deepEqual(await candidates(c, f.tenantId, f.runs.first, []), []);
    });
  });

  test("an entry bound to a product is returned only for runs whose frozen product version belongs to it", async () => {
    const f = await fixture();
    const [first, second] = f.products;
    await approvedEntry(f, { question: "通用问题", terms: ["退货"] });
    await approvedEntry(f, { question: "第一个商品的问题", terms: ["退货"], productId: first.productId });
    await approvedEntry(f, { question: "第二个商品的问题", terms: ["退货"], productId: second.productId });
    await h.withTenant(worker, f.tenantId, async (c) => {
      assert.deepEqual((await candidates(c, f.tenantId, f.runs.first, ["退货"])).map((row) => row.question), ["第一个商品的问题", "通用问题"]);
      assert.deepEqual((await candidates(c, f.tenantId, f.runs.second, ["退货"])).map((row) => row.question), ["第二个商品的问题", "通用问题"]);
      assert.deepEqual((await candidates(c, f.tenantId, f.runs.unbound, ["退货"])).map((row) => row.question), ["通用问题"], "a run without a product version gets only entries for every product");
      assert.deepEqual((await candidates(c, f.tenantId, randomUUID(), ["退货"])).map((row) => row.question), ["通用问题"], "an unknown run gets only entries for every product");
    });
  });

  test("max_rows is clamped to 1 through 50 and defaults to 20", async () => {
    const f = await fixture();
    for (let index = 0; index < 55; index += 1) await approvedEntry(f, { question: `问题${String(index).padStart(2, "0")}`, answer: `答案${index}`, terms: ["共同词"] });
    await h.withTenant(worker, f.tenantId, async (c) => {
      const count = async (maxRows) => (await candidates(c, f.tenantId, f.runs.first, ["共同词"], maxRows)).length;
      assert.deepEqual([await count(0), await count(-5), await count(1), await count(7), await count(1000), await count(null)], [1, 1, 1, 7, 50, 20]);
    });
  });
});

describe("privileges and row-level security", () => {
  test("the worker can run the function but cannot read the knowledge tables or products; other service roles cannot run it", async () => {
    const f = await fixture();
    await approvedEntry(f);
    await h.withTenant(worker, f.tenantId, async (c) => {
      assert.equal((await candidates(c, f.tenantId, f.runs.first, ["退货"])).length, 1);
      for (const sql of ["select id from knowledge_entries", "select id from knowledge_entry_approvals", "select id from knowledge_documents", "select name from products", "select id from product_versions"]) {
        assert.match(await rejected(c, sql), /permission denied/, sql);
      }
      assert.match(await rejected(c, "update knowledge_entries set status = 'retired'"), /permission denied/);
      assert.match(await rejected(c, "insert into knowledge_entry_approvals (tenant_id) values ($1)", [f.tenantId]), /permission denied/);
    });
    const adapter = await h.connectAs("channel_adapter");
    try {
      await h.withTenant(adapter, f.tenantId, async (c) => {
        assert.match(await rejected(c, "select * from knowledge_answer_candidates($1::uuid, $2::uuid, $3::text[], 20)", [f.tenantId, f.runs.first, ["退货"]]), /permission denied/);
      });
    } finally {
      await adapter.end();
    }
  });

  test("the control plane sees only its tenant's entries, approvals and documents", async () => {
    const a = await fixture();
    const b = await fixture();
    await approvedEntry(a);
    await approvedEntry(b);
    await h.admin.query("insert into knowledge_documents (tenant_id, title, source_ref, body, body_sha256, chunk_count, created_by) values ($1, '文档', 'evidence://integration/doc', '正文', $2, 1, $3)", [b.tenantId, sha256("正文"), b.memberId]);
    await h.withTenant(controlPlane, a.tenantId, async (c) => {
      assert.equal((await c.query("select count(*)::int as count from knowledge_entries")).rows[0].count, 1);
      assert.equal((await c.query("select count(*)::int as count from knowledge_entry_approvals")).rows[0].count, 1);
      assert.equal((await c.query("select count(*)::int as count from knowledge_documents")).rows[0].count, 0);
      assert.equal((await c.query("select count(*)::int as count from knowledge_entries where tenant_id = $1", [b.tenantId])).rows[0].count, 0);
    });
  });

  test("entries and snapshots cannot reference a product of another tenant", async () => {
    const a = await fixture();
    const b = await fixture();
    await h.withTenant(controlPlane, a.tenantId, async (c) => {
      assert.match(await rejected(c, "insert into knowledge_entries (tenant_id, kind, question, answer, search_terms, product_id, created_by, updated_by) values ($1, 'faq', '问', '答', '{词}', $2, $3, $3)", [a.tenantId, b.products[0].productId, a.memberId]), /foreign key/);
      assert.equal(await rejected(c, "insert into knowledge_entries (tenant_id, kind, question, answer, search_terms, product_id, created_by, updated_by) values ($1, 'faq', '问', '答', '{词}', $2, $3, $3)", [a.tenantId, a.products[0].productId, a.memberId]), null);
    });
  });
});

describe("faq interaction rules", () => {
  const insertRule = (f, { trigger = "faq", matchConfig = { minScorePermille: 500 }, defaultKey = null, liveRunId = null, intervalSeconds = null, action = "reply_draft" } = {}) => ({
    sql: "insert into interaction_rules (tenant_id, live_run_id, name, trigger_type, match_config, templates, action, interval_seconds, default_key, created_by) values ($1, $2, '知识库问答', $3::interaction_rule_trigger, $4::jsonb, '[\"{faq_answer}\"]'::jsonb, $5::interaction_rule_action, $6, $7, $8)",
    params: [f.tenantId, liveRunId, trigger, JSON.stringify(matchConfig), action, intervalSeconds, defaultKey, f.memberId]
  });

  test("the trigger type faq exists", async () => {
    const labels = (await h.admin.query("select unnest(enum_range(null::interaction_rule_trigger))::text as label")).rows.map((row) => row.label);
    assert.ok(labels.includes("faq"), `interaction_rule_trigger labels: ${labels.join(", ")}`);
  });

  test("minScorePermille must be an integer from 300 to 1000", async () => {
    const f = await fixture();
    await h.withTenant(controlPlane, f.tenantId, async (c) => {
      for (const matchConfig of [{ minScorePermille: 299 }, { minScorePermille: 1001 }, { minScorePermille: 0 }, { minScorePermille: -500 }, { minScorePermille: 500.5 }, { minScorePermille: "500" }, { minScorePermille: null }, { minScorePermille: 1e30 }, {}, { keywords: ["退货"] }]) {
        const { sql, params } = insertRule(f, { matchConfig });
        assert.match(await rejected(c, sql, params), /interaction_rules_faq_shape_check/, JSON.stringify(matchConfig));
      }
      for (const minScorePermille of [300, 650, 1000]) {
        const { sql, params } = insertRule(f, { matchConfig: { minScorePermille } });
        assert.equal(await rejected(c, sql, params), null, `minScorePermille ${minScorePermille}`);
      }
      // A faq rule is event-driven: it has no timer interval.
      const timed = insertRule(f, { intervalSeconds: 300 });
      assert.match(await rejected(c, timed.sql, timed.params), /check constraint/);
      // Other trigger types are not subject to the faq shape.
      const keyword = insertRule(f, { trigger: "keyword", matchConfig: { keywords: ["退货"] } });
      assert.equal(await rejected(c, keyword.sql, keyword.params), null);
    });
  });

  test("the faq_answer default rule is a tenant-wide faq rule, once per tenant", async () => {
    const f = await fixture();
    await h.withTenant(controlPlane, f.tenantId, async (c) => {
      const wrongTrigger = insertRule(f, { trigger: "keyword", matchConfig: { keywords: ["退货"] }, defaultKey: "faq_answer" });
      assert.match(await rejected(c, wrongTrigger.sql, wrongTrigger.params), /interaction_rules_faq_default_check/);
      const forRun = insertRule(f, { defaultKey: "faq_answer", liveRunId: f.runs.first });
      assert.match(await rejected(c, forRun.sql, forRun.params), /interaction_rules_faq_default_check/);
      const unknownKey = insertRule(f, { defaultKey: "faq_unknown" });
      assert.match(await rejected(c, unknownKey.sql, unknownKey.params), /interaction_rules_default_key_check/);
      const valid = insertRule(f, { defaultKey: "faq_answer" });
      assert.equal(await rejected(c, valid.sql, valid.params), null);
      await c.query(valid.sql, valid.params);
      assert.match(await rejected(c, valid.sql, valid.params), /interaction_rules_tenant_default_key_idx/, "the default key is unique per tenant");
    });
    // The five default keys of 084 are still accepted.
    await h.withTenant(controlPlane, f.tenantId, async (c) => {
      const welcome = insertRule(f, { trigger: "viewer_enter", matchConfig: {}, action: "speak", defaultKey: "welcome" });
      assert.equal(await rejected(c, welcome.sql, welcome.params), null);
    });
  });
});

describe("knowledge approval and answering application paths", () => {
  test("service approval snapshots, worker FAQ drafts, and route evidence remain bound to current knowledge", async () => {
    const f = await fixture();
    const author = requestContext(f, "admin");
    const reviewer = requestContext(f, "reviewer");
    const input = { kind: "faq", question: "退货规则是什么", aliasQuestions: ["如何退货"], answer: "支持七天内申请退货。", keywords: ["退货", "申请"] };
    let entry = await knowledge.createKnowledgeEntry(author, input);
    assert.equal(entry.status, "pending");
    await assert.rejects(knowledge.approveKnowledgeEntry(author, entry.id), (error) => error instanceof Response && error.status === 409);
    entry = await knowledge.approveKnowledgeEntry(reviewer, entry.id);
    assert.equal(entry.status, "approved");
    const firstApproval = (await h.admin.query("select * from knowledge_entry_approvals where id = $1", [entry.approvedApprovalId])).rows[0];
    await controlPlane.query("begin");
    try {
      await controlPlane.query("select set_config('app.tenant_id', $1, true)", [f.tenantId]);
      const [profile, lexicon] = await Promise.all([
        policyProfiles.latestApprovedPolicyProfile(controlPlane),
        prohibitedTerms.currentLexiconInTransaction(controlPlane)
      ]);
      const { lexiconSha256 } = await import("../../apps/console/lib/shared/prohibited-terms.mjs");
      assert.equal(firstApproval.answer_sha256.trim(), sha256(input.answer));
      assert.equal(firstApproval.policy_profile_id, profile.id);
      assert.equal(firstApproval.lexicon_sha256.trim(), lexiconSha256(lexicon));
    } finally {
      await controlPlane.query("rollback");
    }

    entry = await knowledge.updateKnowledgeEntry(author, entry.id, { answer: "请在订单页提交退货申请。" });
    assert.equal(entry.status, "pending");
    assert.equal(entry.revision, 2);
    await assert.rejects(knowledge.approveKnowledgeEntry(author, entry.id), (error) => error instanceof Response && error.status === 409);
    entry = await knowledge.approveKnowledgeEntry(reviewer, entry.id);
    assert.equal(entry.status, "approved");
    assert.equal((await h.admin.query("select revision from knowledge_entry_approvals where id = $1", [entry.approvedApprovalId])).rows[0].revision, 2);

    const blocked = await knowledge.createKnowledgeEntry(author, { ...input, question: "特殊规则是什么", answer: "Block_Term" });
    await assert.rejects(knowledge.approveKnowledgeEntry(reviewer, blocked.id), (error) => error instanceof Response && error.status === 422);
    assert.equal((await h.admin.query("select count(*)::int as count from knowledge_entry_approvals where entry_id = $1", [blocked.id])).rows[0].count, 0);
    assert.equal((await h.admin.query("select status from knowledge_entries where id = $1", [blocked.id])).rows[0].status, "pending");

    const defaults = await rules.createDefaultInteractionRules(author);
    const faqRule = defaults.created.find((rule) => rule.defaultKey === "faq_answer");
    assert.ok(faqRule, "default FAQ rule is created");
    assert.equal(faqRule.enabled, true);
    assert.equal(faqRule.triggerType, "faq");
    await rules.approveInteractionRule(reviewer, faqRule.id);

    const evalRun = evaluator(f.tenantId);
    const firstComment = await comment(f, "退货规则是什么");
    await inTenantTransaction(workerPool, f.tenantId, (client) => evalRun.evaluateRun(client, f.tenantId, f.runs.first));
    const firstDraft = (await h.admin.query("select id, evidence_snapshot from channel_reply_drafts where interaction_id = $1", [firstComment])).rows[0];
    assert.ok(firstDraft, "approved FAQ rule creates a reply draft");
    assert.ok(firstDraft.evidence_snapshot.some((item) => item.type === "knowledge_entry" && item.approvalId === entry.approvedApprovalId));
    const firstFiring = (await h.admin.query("select knowledge_approval_id from interaction_rule_firings where interaction_id = $1", [firstComment])).rows[0];
    assert.equal(firstFiring.knowledge_approval_id, entry.approvedApprovalId);

    const revised = await knowledge.updateKnowledgeEntry(author, entry.id, { answer: "该条目尚待重新审核。" });
    assert.equal(revised.status, "pending");
    const staleComment = await comment(f, "退货规则是什么");
    await inTenantTransaction(workerPool, f.tenantId, (client) => evalRun.evaluateRun(client, f.tenantId, f.runs.first));
    assert.equal((await h.admin.query("select count(*)::int as count from channel_reply_drafts where interaction_id = $1", [staleComment])).rows[0].count, 0);
    assert.equal((await h.admin.query("select count(*)::int as count from interaction_rule_firings where interaction_id = $1 and knowledge_approval_id is not null", [staleComment])).rows[0].count, 0);

    const current = await knowledge.createKnowledgeEntry(author, { ...input, question: "退货地址在哪里", answer: "请通过订单页面提交退货申请。" });
    const currentApproved = await knowledge.approveKnowledgeEntry(reviewer, current.id);
    const keywordRule = await rules.createInteractionRule(author, {
      name: "退货关键词", triggerType: "keyword", matchConfig: { keywords: ["退货"] }, templates: ["请查看订单中的退货说明。"],
      action: "reply_draft", cooldownSeconds: 0, priority: 40, enabled: true
    });
    await rules.approveInteractionRule(reviewer, keywordRule.id);
    const duplicateComment = await comment(f, "退货地址在哪里");
    await inTenantTransaction(workerPool, f.tenantId, (client) => evalRun.evaluateRun(client, f.tenantId, f.runs.first));
    assert.equal((await h.admin.query("select count(*)::int as count from channel_reply_drafts where interaction_id = $1", [duplicateComment])).rows[0].count, 1, "matching FAQ and keyword rules produce one reply draft");

    const responseRoute = await responseDraftRoute.POST(routeRequest(f, { question: "退货地址在哪里" }), { params: Promise.resolve({ runId: f.runs.first }) });
    assert.equal(responseRoute.status, 200);
    const responsePayload = await responseRoute.json();
    assert.ok(responsePayload.data.evidence.some((item) => item.type === "knowledge_entry" && item.approvalId === currentApproved.approvedApprovalId));

    const routeInteraction = await comment(f, "退货地址在哪里");
    const replyRoute = await replyDraftRoute.POST(routeRequest(f, {
      interactionId: routeInteraction,
      body: "请通过订单页面提交退货申请。",
      knowledgeApprovalId: currentApproved.approvedApprovalId
    }), { params: Promise.resolve({ runId: f.runs.first }) });
    assert.equal(replyRoute.status, 201);
    const replyPayload = await replyRoute.json();
    assert.ok(replyPayload.data.evidenceSnapshot.some((item) => item.type === "knowledge_entry" && item.approvalId === currentApproved.approvedApprovalId));
  });
});
