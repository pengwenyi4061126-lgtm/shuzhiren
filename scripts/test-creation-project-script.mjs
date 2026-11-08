import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { generateProductScript, splitNarrationScript } from "../apps/console/lib/shared/content-script.mjs";
import { canResumeLiveOutput, clearLiveOutputCheckpoint, readLiveOutputCheckpoint, saveLiveOutputCheckpoint } from "../apps/console/lib/shared/live-output-resume.mjs";
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
  assert.match(short, /你好，今天我们来聊聊清洁泡沫/);
  assert.doesNotMatch(short, /欢迎来到直播间|^\s*1\./m);
  assert.match(detailed, /已审核资料显示：按压出泡/);
  assert.match(detailed, /常见问题补充：适用方法/);
  assert.notEqual(short, generateProductScript({ ...facts, style: "faq", length: "short" }));
  assert.throws(() => generateProductScript({ ...facts, style: "viral" }), TypeError);
});

test("live output retries keep one idempotency key only while the exact request matches", () => {
  const pending = { projectId: "project-1", requestFingerprint: "request-a", idempotencyKey: "key-1", run: null };
  assert.equal(canResumeLiveOutput(pending, "project-1", "request-a"), true);
  assert.equal(canResumeLiveOutput(pending, "project-2", "request-a"), false);
  assert.equal(canResumeLiveOutput(pending, "project-1", "request-b"), false);
  assert.equal(canResumeLiveOutput(null, "project-1", "request-a"), false);
});

test("live output checkpoints survive reloads and are isolated to the saved project", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const request = { showName: "Project", channelConnectionId: "channel-1", productVersionId: "product-1", creationProjectId: "project-1", mediaAssetIds: ["asset-1"], aiDisclosureEnabled: true };
  const checkpoint = { projectId: "project-1", requestFingerprint: JSON.stringify(request), idempotencyKey: "retry-1", request, run: { id: "run-1", showName: "Project" } };
  assert.equal(saveLiveOutputCheckpoint(storage, checkpoint), true);
  assert.deepEqual(readLiveOutputCheckpoint(storage, "project-1"), checkpoint);
  assert.equal(readLiveOutputCheckpoint(storage, "project-2"), null);
  storage.setItem("shuzhiren:studio:live-output:project-1", JSON.stringify({ ...checkpoint, requestFingerprint: "tampered" }));
  assert.equal(readLiveOutputCheckpoint(storage, "project-1"), null, "a checkpoint with a mismatched request fingerprint must be discarded");
  clearLiveOutputCheckpoint(storage, "project-1");
  assert.equal(readLiveOutputCheckpoint(storage, "project-1"), null);
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

test("photo recording outputs are versioned, migrated from the old project-keyed store, and selectable", async () => {
  const [vault, composer] = await Promise.all([
    readFile(new URL("../apps/console/lib/project-recording-vault.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/components/photo-recording-composer.tsx", import.meta.url), "utf8")
  ]);
  assert.match(vault, /indexedDB\.open\(databaseName, 2\)/);
  assert.match(vault, /createObjectStore\(storeName, \{ keyPath: "id" \}\)/);
  assert.match(vault, /event\.oldVersion === 1/);
  assert.match(vault, /versions\.put\(\{ \.\.\.output, id: `legacy-\$\{output\.projectId\}` \}\)/);
  assert.match(vault, /objectStore\(storeName\)\.add\(version\)/);
  assert.match(vault, /index\("projectId"\)\.getAll\(projectId\)/);
  assert.match(composer, /listProjectRecordings\(projectId\)/);
  assert.match(composer, /项目成片版本/);
  assert.match(composer, /保存为第 \$\{savedOutputs\.length \+ 1\} 版并下载/);
  assert.match(composer, /disabled=\{!reviewed \|\| working \|\| previewDiffersFromProject\}/);
});

test("Studio scans and requires review of the exact current script and product facts before outputs", async () => {
  const [workspace, scanRoute, projectService, reviewRoute, liveRunRoute, store, migration] = await Promise.all([
    readFile(new URL("../apps/console/components/studio-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/app/api/v1/prohibited-terms/scan/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/lib/creation-projects.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/app/api/v1/studio/projects/[projectId]/script-review/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/app/api/v1/live-runs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/lib/control-plane/store.ts", import.meta.url), "utf8"),
    readFile(new URL("../infra/postgres/migrations/094_creation_project_script_reviews.sql", import.meta.url), "utf8")
  ]);
  assert.match(workspace, /<ProhibitedTermHints text=\{currentScript\} context="script"/);
  assert.match(workspace, /scriptReviewMark\.productVersionId === productVersionId/);
  assert.match(workspace, /scriptReviewMark\.text === currentScript/);
  assert.match(workspace, /canCreateLive = .*scriptReviewed/);
  assert.match(workspace, /canCreate=\{canCreate && scriptReviewed && !scriptReviewBusy\}/);
  assert.match(workspace, /aria-label="内容创建步骤"/);
  assert.match(workspace, /navigateStep\(2, "studio-script-step"\)/);
  assert.match(workspace, /onFocusCapture=\{\(\) => setActiveStep\(3\)\}/);
  assert.match(scanRoute, /readBoundedJson\(request, 32 \* 1024\)/);
  assert.match(scanRoute, /text\.length > 4000/);
  assert.match(projectService, /creationProjectScriptReviewSha256\(productVersionId, script\)/);
  assert.match(projectService, /finding\.severity === "block"/);
  assert.match(reviewRoute, /reviewCreationProjectScript/);
  assert.match(liveRunRoute, /assertCreationProjectScriptReviewed\(actor, body\.creationProjectId, body\.productVersionId\)/);
  assert.match(store, /assertCreationProjectScriptReviewInTransaction\(client, context\.tenantId, input\.creationProjectId, input\.productVersionId\)/);
  assert.match(migration, /invalidate_creation_project_script_review_on_content_change/);
  assert.match(workspace, /creationProjectId: project\.id/);
  assert.match(workspace, /readLiveOutputCheckpoint\(window\.localStorage, projectId\)/);
  assert.match(workspace, /saveLiveOutputCheckpoint\(window\.localStorage/);
  assert.match(workspace, /clearLiveOutputCheckpoint\(window\.localStorage, project\.id\)/);
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
