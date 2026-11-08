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
  const [vault, composer, photoVault, assets] = await Promise.all([
    readFile(new URL("../apps/console/lib/project-recording-vault.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/components/photo-recording-composer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/lib/photo-source-vault.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/components/asset-workspace.tsx", import.meta.url), "utf8")
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
  assert.match(composer, /disabled=\{!reviewed \|\| \(!selectedSavedOutput && \(!canCreate \|\| previewDiffersFromProject\)\) \|\| working\}/);
  assert.match(composer, /videoSnapshot\.productVersionId !== productVersionId/);
  assert.match(composer, /videoSnapshot\.productVersionId !== project\.productVersionId \|\| videoSnapshot\.script !== project\.script \|\| !project\.scriptReview/);
  assert.match(composer, /if \(!videoBlob \|\| !reviewed \|\| \(!selectedSavedOutput && \(!canCreate \|\| previewDiffersFromProject\)\)\) return/);
  assert.match(photoVault, /export async function savePhotoSource/);
  assert.match(photoVault, /export async function getPhotoSource/);
  assert.match(photoVault, /export async function deletePhotoSource/);
  assert.match(assets, /checked=\{keepPhotoLocal\}/);
  assert.match(assets, /await deletePhotoSource\(id\)/);
  assert.match(composer, /photos\.some\(\(item\) => item\.id === photoId\) \? photoId : \(preferred\?\.id \?\? ""\)/);
  assert.match(composer, /getPhotoSource\(activePhotoId\)/);
  assert.match(composer, /此设备没有本机副本/);
});

test("Studio shows recording and live output counts for the selected project", async () => {
  const [workspace, composer] = await Promise.all([
    readFile(new URL("../apps/console/components/studio-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/components/photo-recording-composer.tsx", import.meta.url), "utf8")
  ]);
  assert.match(workspace, /listProjectRecordings\(projectId\)/);
  assert.match(workspace, /aria-label="项目输出状态"/);
  assert.match(workspace, /录播成片/);
  assert.match(workspace, /studio\/projects\/\$\{encodeURIComponent\(projectId\)\}\/recordings/);
  assert.match(workspace, /serverCount: result\.data!\.length/);
  assert.match(workspace, /activeProject\?\.liveRunIds\.length/);
  assert.match(workspace, /refreshProjectAssets/);
  assert.match(workspace, /刷新已审核素材/);
  assert.match(workspace, /href="\/assets" target="_blank"/);
  assert.match(workspace, /hasUnsavedChanges/);
  assert.match(workspace, /beforeunload/);
  assert.match(workspace, /放弃更改并切换项目/);
  assert.ok(workspace.includes("onRecordingSaved={(result) => setRecordingOutputState"));
  assert.match(composer, /onRecordingSaved\(\{ localSaved: true, serverArchived: archiveStatus\.status === "archived" \}\)/);
  assert.match(composer, /重试服务端归档/);
  assert.match(composer, /updateProjectRecordingArchive/);
});

test("reviewed photo narration is uploaded and archived as an immutable tenant project recording", async () => {
  const [composer, route, service, migration, schema, vault, downloadRoute, mediaEvidence] = await Promise.all([
    readFile(new URL("../apps/console/components/photo-recording-composer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/app/api/v1/studio/projects/[projectId]/recordings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/lib/project-recordings.ts", import.meta.url), "utf8"),
    readFile(new URL("../infra/postgres/migrations/095_creation_project_recordings.sql", import.meta.url), "utf8"),
    readFile(new URL("../scripts/verify-postgres-schema.mjs", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/lib/project-recording-vault.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/app/api/v1/studio/projects/[projectId]/recordings/[recordingId]/download-grant/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/lib/media-evidence.ts", import.meta.url), "utf8")
  ]);
  assert.match(composer, /\/api\/v1\/media-uploads\/grant/);
  assert.match(composer, /method: "PUT".*body: blob/);
  assert.match(composer, /\/api\/v1\/studio\/projects\/\$\{encodeURIComponent\(project\.id\)\}\/recordings/);
  assert.match(route, /requireRole\(context, \["admin", "operator"\]\)/);
  assert.match(service, /verifyMediaAssetContent\(context, \{ kind: "product_clip"/);
  assert.match(service, /project\.script_review_sha256 !== scriptSha256/);
  assert.match(service, /assertAttachedApprovedAsset\(client, context\.tenantId, projectId, input\.photoAssetId, "portrait_photo"\)/);
  assert.match(service, /creation_project\.recording_archived/);
  assert.match(vault, /serverArchive\?: \{ status: "archived" \| "failed" \| "local-only"/);
  assert.match(vault, /export async function updateProjectRecordingArchive/);
  assert.match(composer, /项目服务端成片/);
  assert.match(composer, /download-grant/);
  assert.match(downloadRoute, /requireRole\(context, \["admin", "operator", "reviewer", "analyst"\]\)/);
  assert.match(service, /createMediaDownloadGrant\(context/);
  assert.match(mediaEvidence, /\/v1\/media-evidence\/download-grant/);
  assert.match(mediaEvidence, /5 \* 60_000/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /force row level security/);
  assert.match(migration, /creation_project_recordings_immutable/);
  assert.match(schema, /"creation_project_recordings"/);
});

test("Studio can create a reviewed project speech track from its approved voice asset", async () => {
  const [workspace, composer, route, gateway, gatewayClient] = await Promise.all([
    readFile(new URL("../apps/console/components/studio-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/components/photo-recording-composer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/app/api/v1/studio/projects/[projectId]/speech-preview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../runtime/gateway/app.py", import.meta.url), "utf8"),
    readFile(new URL("../apps/console/lib/runtime-gateway.ts", import.meta.url), "utf8")
  ]);
  assert.match(workspace, /asset\.kind === "voice" && asset\.approval === "approved" && assetIds\.includes\(asset\.id\)/);
  assert.match(composer, /speech-preview/);
  assert.match(composer, /generatedAudioMatches/);
  assert.match(composer, /videoSnapshot\.voiceAssetId !== selectedVoice\?\.id/);
  assert.match(composer, /voiceAssetName: selectedVoice\?\.name/);
  assert.match(route, /assertCreationProjectScriptReviewed\(actor, project\.id, project\.productVersionId\)/);
  assert.match(route, /project\.assetIds\.includes\(voiceAssetId\)/);
  assert.match(route, /asset\.kind !== "voice" \|\| asset\.approval !== "approved"/);
  assert.match(route, /synthesizeRuntimeSpeechPreview\(project\.script, asset\.runtimeVoiceId, asset\.checksum\)/);
  assert.match(gateway, /@app\.post\("\/v1\/synthesize"\)/);
  assert.match(gateway, /async with cosyvoice_synthesis_lock:/);
  assert.match(gateway, /offline_speech_preview_busy/);
  assert.match(gateway, /request\.action == "start_program"/);
  assert.match(gatewayClient, /\/v1\/synthesize/);
  assert.match(gatewayClient, /audio\.byteLength > 4_400_000/);
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
  assert.match(workspace, /selectedLivePortrait = assets\.some\(\(asset\) => asset\.kind === "portrait" && asset\.approval === "approved"/);
  assert.match(workspace, /channelReady = connectedChannels\.some\(\(channel\) => channel\.id === channelId\)/);
  assert.match(workspace, /canCreateLive = .*channelReady && scriptReviewed/);
  assert.match(workspace, /直播渠道/);
  assert.match(workspace, /直播输出准备状态/);
  assert.match(workspace, /项目中的照片只用于照片播报录播，不能作为实时直播形象/);
  assert.match(workspace, /正式开播仍以运行时与场次预检结果为准/);
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
