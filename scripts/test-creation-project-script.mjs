import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { generateProductScript, splitNarrationScript } from "../apps/console/lib/shared/content-script.mjs";
import { canResumeLiveOutput } from "../apps/console/lib/shared/live-output-resume.mjs";
import { preferProjectLiveAssets } from "../apps/console/lib/shared/live-asset-selection.mjs";

test("narration splitting preserves text and keeps each live segment under the runtime limit", () => {
  const source = `${"中文口播内容，介绍商品事实。".repeat(170)}${"末尾无空格".repeat(80)}`;
  const chunks = splitNarrationScript(source);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 800));
  assert.equal(chunks.join(""), source);
});

test("narration splitting returns no empty segment", () => {
  assert.deepEqual(splitNarrationScript("   "), []);
  assert.deepEqual(splitNarrationScript("一段短文。"), ["一段短文。"]);
});

test("narration splitting rejects an invalid segment limit", () => {
  assert.throws(() => splitNarrationScript("text", 0), TypeError);
});

test("product scripts use only supplied approved facts and vary length and style", () => {
  const facts = { name: "清洁泡沫", goal: "日常清洁", audience: "初次购买者", priceCent: 5990, highlights: ["按压出泡", "易于冲洗", "净含量 150 毫升"], faq: ["适用方法：湿润后按压使用。", "储存方式：置于阴凉处。"] };
  const short = generateProductScript({ ...facts, length: "short" });
  const detailed = generateProductScript({ ...facts, style: "professional", length: "detailed" });
  assert.match(short, /清洁泡沫/);
  assert.match(short, /按压出泡/);
  assert.doesNotMatch(short, /易于冲洗/);
  assert.match(detailed, /净含量 150 毫升/);
  assert.match(detailed, /59\.90/);
  assert.match(detailed, /适用方法/);
  assert.match(detailed, /仅依据已审核的商品资料/);
  assert.throws(() => generateProductScript({ ...facts, style: "viral" }), TypeError);
});

test("live output retries keep one idempotency key only while the exact request matches", () => {
  const pending = { projectId: "project-1", requestFingerprint: "request-a", idempotencyKey: "key-1", run: null };
  assert.equal(canResumeLiveOutput(pending, "project-1", "request-a"), true);
  assert.equal(canResumeLiveOutput(pending, "project-2", "request-a"), false);
  assert.equal(canResumeLiveOutput(pending, "project-1", "request-b"), false);
  assert.equal(canResumeLiveOutput(null, "project-1", "request-a"), false);
});

test("live outputs prefer project assets and never bind a photo as the live portrait", () => {
  const defaults = new Map([["portrait", { id: "default-video", kind: "portrait" }], ["voice", { id: "default-voice", kind: "voice" }]]);
  const selected = preferProjectLiveAssets(defaults, [
    { id: "project-photo", kind: "portrait_photo" },
    { id: "project-video", kind: "portrait" },
    { id: "project-voice", kind: "voice" }
  ]);
  assert.equal(selected.get("portrait")?.id, "project-video");
  assert.equal(selected.get("voice")?.id, "project-voice");
  assert.equal(selected.has("portrait_photo"), false);
});

test("Studio scans and requires review of the exact current script and product facts before outputs", async () => {
  const [workspace, scanRoute] = await Promise.all([
    readFile(new URL("../apps/console/components/studio-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/app/api/v1/prohibited-terms/scan/route.ts", import.meta.url), "utf8")
  ]);
  assert.match(workspace, /<ProhibitedTermHints text=\{currentScript\} context="script"/);
  assert.match(workspace, /scriptReviewMark\.productVersionId === productVersionId/);
  assert.match(workspace, /scriptReviewMark\.text === currentScript/);
  assert.match(workspace, /canCreateLive = .*scriptReviewed/);
  assert.match(workspace, /canCreate=\{canCreate && scriptReviewed\}/);
  assert.match(scanRoute, /readBoundedJson\(request, 32 \* 1024\)/);
  assert.match(scanRoute, /text\.length > 4000/);
});

test("the live-output flow forwards saved project assets into tenant-scoped run creation", async () => {
  const [workspace, route, store, assets] = await Promise.all([
    readFile(new URL("../apps/console/components/studio-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/app/api/v1/live-runs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/lib/control-plane/store.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/lib/assets.ts", import.meta.url), "utf8")
  ]);
  assert.match(workspace, /mediaAssetIds:\s*project\.assetIds/);
  assert.ok(route.includes("mediaAssetIds?: string[]"));
  assert.match(store, /currentApprovedMediaAssetsInTransaction\(client, input\.mediaAssetIds\)/);
  assert.match(assets, /preferProjectLiveAssets\(defaults, preferred\.rows\.map\(persistentAsset\)\)/);
});

test("live-run creation retries are tenant-scoped, request-bound and transaction-locked", async () => {
  const [route, store, migration] = await Promise.all([
    readFile(new URL("../apps/console/app/api/v1/live-runs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/lib/control-plane/store.ts", import.meta.url), "utf8"),
    readFile(new URL("../infra/postgres/migrations/093_live_run_creation_idempotency.sql", import.meta.url), "utf8")
  ]);
  assert.match(route, /idempotencyKey === undefined \|\|/);
  assert.match(store, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(store, /request_sha256 !== requestSha256/);
  assert.match(store, /insert into live_run_creation_requests/);
  assert.match(migration, /primary key \(tenant_id, idempotency_key\)/);
  assert.match(migration, /force row level security/);
});
