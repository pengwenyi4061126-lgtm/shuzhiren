// Plain-text knowledge imports exercise the console service against the isolated PostgreSQL harness.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createHarness } from "./harness.mjs";

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
let h;
let controlPlane;
let knowledge;

before(async () => {
  h = await createHarness(import.meta.url);
  controlPlane = await h.connectAs("control_plane");
  for (const name of ["CONTROL_PLANE_DEMO_MODE", "CONTROL_PLANE_DEV_HEADER_IDENTITY"]) delete process.env[name];
  process.env.DATABASE_URL = h.url("control_plane");
  const { register } = await import("node:module");
  register("../lib/console-ts-loader.mjs", import.meta.url);
  knowledge = await import("../../apps/console/lib/knowledge-base.ts");
});

after(async () => {
  await globalThis.shuzhirenDatabasePool?.end().catch(() => undefined);
  await controlPlane?.end().catch(() => undefined);
  await h?.close();
});

async function fixture() {
  const tenantId = await h.seed.tenant();
  const subject = `it-kb-doc-${randomUUID()}`;
  await h.seed.member({ tenantId, subject, role: "operator" });
  return { tenantId, context: { tenantId, actorId: subject, actorName: "Document import integration", role: "operator", accessScope: "tenant" } };
}

async function rejected(client, sql, params = []) {
  await client.query("savepoint document_trigger_probe");
  try {
    await client.query(sql, params);
    return null;
  } catch (error) {
    return error.message;
  } finally {
    await client.query("rollback to savepoint document_trigger_probe");
  }
}

describe("knowledge document imports", () => {
  test("writes hash-bound pending chunks and audit atomically; rejects mutation, overflow, and cross-tenant reads", async () => {
    const a = await fixture();
    const b = await fixture();
    const body = "退货规则是什么？支持七天内申请退货。\n\n发货规则是什么？订单通常在二十四小时内发货。";
    const imported = await knowledge.importKnowledgeDocument(a.context, { title: "售后与发货规则", sourceRef: "evidence://integration/knowledge-documents", body });
    const otherImported = await knowledge.importKnowledgeDocument(b.context, { title: "另一租户文档", sourceRef: "evidence://integration/other-tenant", body: "仅另一租户可见的文档内容。" });
    assert.equal(imported.document.bodySha256, sha256(body));
    assert.equal(imported.document.chunkCount, imported.created.length);
    assert.ok(imported.created.length > 0);
    assert.ok(imported.created.every((entry) => entry.kind === "document_chunk" && entry.status === "pending"));

    const persisted = await h.withTenant(controlPlane, a.tenantId, async (client) => {
      const document = (await client.query("select id, title, source_ref, body, body_sha256, chunk_count from knowledge_documents where id = $1", [imported.document.id])).rows[0];
      const entries = (await client.query("select id, kind, question, answer, status, source_document_id from knowledge_entries where source_document_id = $1 order by id", [document.id])).rows;
      const events = (await client.query("select event_type, resource_key, detail from audit_events where resource_key = $1", [document.id])).rows;
      assert.equal(document.body, body);
      assert.equal(document.body_sha256, sha256(body));
      assert.equal(document.chunk_count, imported.created.length);
      assert.equal(entries.length, document.chunk_count);
      assert.ok(entries.every((entry) => entry.kind === "document_chunk" && entry.status === "pending" && entry.source_document_id === document.id));
      assert.equal(events.length, 1);
      assert.equal(events[0].event_type, "knowledge_document.imported");
      assert.equal(events[0].detail.bodySha256, sha256(body));
      assert.equal(events[0].detail.chunkCount, entries.length);
      assert.match(await rejected(client, "update knowledge_documents set title = 'mutated' where id = $1", [document.id]), /append-only/);
      assert.match(await rejected(client, "delete from knowledge_documents where id = $1", [document.id]), /append-only/);
      assert.equal((await knowledge.listKnowledgeDocuments(a.context)).some((item) => item.id === document.id), true);
      return document.id;
    });

    const beforeCounts = await h.withTenant(controlPlane, a.tenantId, async (client) => ({
      documents: Number((await client.query("select count(*) from knowledge_documents")).rows[0].count),
      entries: Number((await client.query("select count(*) from knowledge_entries")).rows[0].count)
    }));
    await assert.rejects(knowledge.importKnowledgeDocument(a.context, { title: "超长正文", sourceRef: "evidence://integration/too-long", body: "退".repeat(50_001) }), (error) => error instanceof Response && error.status === 400);
    await assert.rejects(knowledge.importKnowledgeDocument(a.context, { title: "超多片段", sourceRef: "evidence://integration/too-many", body: Array.from({ length: 201 }, (_, index) => `规则${index}。`).join("\n\n") }), (error) => error instanceof Response && error.status === 400);
    const afterCounts = await h.withTenant(controlPlane, a.tenantId, async (client) => ({
      documents: Number((await client.query("select count(*) from knowledge_documents")).rows[0].count),
      entries: Number((await client.query("select count(*) from knowledge_entries")).rows[0].count)
    }));
    assert.deepEqual(afterCounts, beforeCounts);

    await h.withTenant(controlPlane, a.tenantId, async (client) => {
      assert.equal((await client.query("select count(*) from knowledge_documents where id = $1", [persisted])).rows[0].count, "1");
      assert.equal((await client.query("select count(*) from knowledge_documents where id = $1", [otherImported.document.id])).rows[0].count, "0");
    });
    assert.deepEqual((await knowledge.listKnowledgeDocuments(a.context)).map((document) => document.id), [persisted]);
  });
});
