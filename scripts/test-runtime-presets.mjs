// Default avatar and voice presets (migration 082): static checks of the migration and the grant script, and the
// console routes in demo mode (development header identity, no database). The PostgreSQL side is covered by
// scripts/integration/runtime-presets.test.mjs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFile(path.join(root, ...parts), "utf8");
const [migration, controlPlaneGrants, serviceGrants, gateway] = await Promise.all([
  read("infra", "postgres", "migrations", "082_runtime_presets.sql"),
  read("infra", "postgres", "control-plane-principal.sql"),
  read("infra", "postgres", "service-principals.sql"),
  read("runtime", "gateway", "app.py")
]);

// Migration: platform catalogue without tenant_id, unverified by default, ASCII runtime references.
assert.doesNotMatch(migration, /^\s*tenant_id\s/m, "runtime_presets is platform-wide and must not carry a tenant_id column");
for (const source of ["create table runtime_presets", "commercial_use_status text not null default 'unverified'", "runtime_presets_runtime_ref_format check (runtime_ref ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')", "runtime_presets_commercial_use_status_check check (commercial_use_status in ('verified', 'unverified'))", "runtime_presets_compatible_model_kind_check check (compatible_model_kind in ('sft', 'zero_shot', 'any'))"]) {
  assert.ok(migration.includes(source), `082_runtime_presets.sql must contain: ${source}`);
}
assert.doesNotMatch(migration, /'verified'\)\s*[,;]/, "no seed may claim a verified commercial license");
assert.doesNotMatch(migration, /\b(update|delete)\s+(from\s+)?\w/i, "082 must not change existing rows");
// The read-only control-plane grant; service principals get nothing on the catalogue.
assert.match(controlPlaneGrants, /^revoke insert, update, delete on runtime_presets from :"control_plane_role";$/m);
assert.doesNotMatch(serviceGrants, /runtime_presets/, "no service principal needs the preset catalogue");
// The Gateway's built-in sft default maps exactly the seeded voice ids to the seeded speakers.
const defaultMap = /DEFAULT_COSYVOICE_SFT_SPEAKER_MAP = (\{[^\n]*\})/.exec(gateway)?.[1];
assert.ok(defaultMap, "app.py must define DEFAULT_COSYVOICE_SFT_SPEAKER_MAP");
assert.deepEqual(JSON.parse(defaultMap), { "preset-zh-female": "中文女", "preset-zh-male": "中文男" });

register("./lib/console-ts-loader.mjs", import.meta.url);
Object.assign(process.env, { CONTROL_PLANE_DEV_HEADER_IDENTITY: "true", NODE_ENV: "development", HOSTNAME: "127.0.0.1" });
delete process.env.DATABASE_URL;
delete process.env.CONTROL_PLANE_DEMO_MODE;
const routes = path.join(root, "apps", "console", "app", "api", "v1");
const load = (...parts) => import(pathToFileURL(path.join(routes, ...parts, "route.ts")).href);
const presets = await import(pathToFileURL(path.join(root, "apps", "console", "lib", "presets.ts")).href);
const audit = await import(pathToFileURL(path.join(root, "apps", "console", "lib", "audit.ts")).href);
const { GET: listPresetsRoute } = await load("presets");
const { POST: adoptRoute } = await load("presets", "[presetCode]", "adopt");
const { GET: listAssetsRoute } = await load("assets");
const { POST: approveRoute } = await load("assets", "[assetId]", "approve");

// Each demo preset carries the seed values of the migration (the integration test compares every field).
for (const preset of presets.demoRuntimePresets) {
  for (const value of [preset.code, preset.displayName, preset.runtimeRef, preset.materialRequirements, preset.licenseName]) assert.ok(migration.includes(`'${value}'`), `demo preset ${preset.code} must match the 082 seed value ${value}`);
  assert.equal(preset.commercialUseStatus, "unverified");
}
assert.deepEqual(presets.demoRuntimePresets.map((preset) => preset.code), ["preset-zh-female", "preset-zh-male", "preset-avatar-default"]);

const headers = (role, actor = `${role}-presets`) => ({ "x-tenant-id": "tenant_demo", "x-actor-id": actor, "x-actor-name": `Presets ${role}`, "x-actor-role": role, "content-type": "application/json" });
const params = (presetCode) => ({ params: Promise.resolve({ presetCode }) });
const adopt = (role, presetCode, body) => adoptRoute(new Request(`http://127.0.0.1/api/v1/presets/${encodeURIComponent(presetCode)}/adopt`, { method: "POST", headers: headers(role), body: typeof body === "string" ? body : JSON.stringify(body) }), params(presetCode));
const checksum = `sha256:${"a".repeat(64)}`;

// GET /api/v1/presets: every console role reads the enabled catalogue.
for (const role of ["admin", "operator", "reviewer", "analyst"]) {
  const response = await listPresetsRoute(new Request("http://127.0.0.1/api/v1/presets", { headers: headers(role) }));
  assert.equal(response.status, 200, `${role} must read the preset catalogue`);
  const { data } = await response.json();
  assert.deepEqual(data.map((preset) => [preset.code, preset.kind, preset.commercialUseStatus]), [["preset-zh-female", "voice", "unverified"], ["preset-zh-male", "voice", "unverified"], ["preset-avatar-default", "avatar", "unverified"]]);
  assert.equal(data[0].sftSpeakerId, "中文女");
}

// POST adopt: only admin and operator; strict body; unknown or malformed codes are 404.
for (const role of ["reviewer", "analyst"]) {
  const refused = await adopt(role, "preset-zh-female", { objectKey: "tenant/voices/female.wav", checksum });
  assert.equal(refused.status, 403, `${role} must not adopt presets`);
  assert.deepEqual(await refused.json(), { error: "preset_adoption_rejected" });
}
for (const body of [{}, { objectKey: "../escape.wav", checksum }, { objectKey: "tenant/voices/female.wav", checksum: "sha256:short" }, { objectKey: "tenant/voices/female.wav", checksum, expiresAt: "tomorrow" }, [], "not json"]) {
  const invalid = await adopt("operator", "preset-zh-female", body);
  assert.equal(invalid.status, 400, `invalid adoption body must be rejected: ${JSON.stringify(body)}`);
}
for (const code of ["preset-unknown", "Preset-ZH-Female", "../assets"]) {
  const missing = await adopt("operator", code, { objectKey: "tenant/voices/female.wav", checksum });
  assert.equal(missing.status, 404, `preset ${code} must not be found`);
  assert.deepEqual(await missing.json(), { error: "preset_not_found" });
}
await assert.rejects(presets.adoptPreset({ tenantId: "tenant_demo", actorId: "restricted", actorName: "Restricted", role: "operator", accessScope: "restricted" }, "preset-zh-female", { objectKey: "tenant/voices/female.wav", checksum }), (error) => error instanceof Response && error.status === 403, "restricted memberships must not adopt presets");

// A voice preset becomes a pending voice asset with the preset's runtime voice id and an unverified rights scope.
const voice = await adopt("operator", "preset-zh-female", { objectKey: "tenant/voices/preset-zh-female/prompt.wav", checksum, expiresAt: "2027-12-31" });
assert.equal(voice.status, 201);
const voiceBody = await voice.json();
assert.equal(voiceBody.data.approval, "pending", "an adopted preset must start pending");
assert.equal(voiceBody.data.kind, "voice");
assert.equal(voiceBody.data.runtimeVoiceId, "preset-zh-female");
assert.equal(voiceBody.data.objectKey, "tenant/voices/preset-zh-female/prompt.wav");
assert.equal(voiceBody.data.checksum, checksum);
assert.equal(voiceBody.data.expiresAt, "2027-12-31");
assert.match(voiceBody.data.rightsScope, /preset-zh-female/);
assert.match(voiceBody.data.rightsScope, /商用授权未核实/);
assert.match(voiceBody.data.source, /^preset:preset-zh-female · runtime_voice_id=preset-zh-female（sft 说话人 中文女）/);
assert.deepEqual(voiceBody.meta, { presetCode: "preset-zh-female", commercialUseStatus: "unverified" });
// The avatar slot becomes a pending portrait without a runtime voice id.
const avatar = await adopt("admin", "preset-avatar-default", { objectKey: "tenant/portraits/preset-avatar-default.mp4", checksum: `sha256:${"b".repeat(64)}` });
assert.equal(avatar.status, 201);
const avatarBody = await avatar.json();
assert.equal(avatarBody.data.kind, "portrait");
assert.equal(avatarBody.data.approval, "pending");
assert.equal(avatarBody.data.runtimeVoiceId, undefined);
assert.match(avatarBody.data.source, /LiveTalking avatar_id=preset-avatar-default/);

// Both adoptions are audited, and the assets stay in the normal approval flow.
const events = (await audit.listAuditEvents({ tenantId: "tenant_demo", actorId: "audit", actorName: "Audit", role: "admin" })).filter((event) => event.type === "runtime_preset.adopted");
assert.deepEqual(events.map((event) => [event.resourceId, event.detail.presetCode, event.detail.commercialUseStatus]).sort(), [[avatarBody.data.id, "preset-avatar-default", "unverified"], [voiceBody.data.id, "preset-zh-female", "unverified"]].sort());
const listed = await (await listAssetsRoute(new Request("http://127.0.0.1/api/v1/assets", { headers: headers("analyst") }))).json();
assert.equal(listed.data.find((asset) => asset.id === voiceBody.data.id)?.approval, "pending");
const operatorApproval = await approveRoute(new Request(`http://127.0.0.1/api/v1/assets/${voiceBody.data.id}/approve`, { method: "POST", headers: headers("operator") }), { params: Promise.resolve({ assetId: voiceBody.data.id }) });
assert.equal(operatorApproval.status, 403, "the operator who adopted a preset still cannot approve it");
const approval = await approveRoute(new Request(`http://127.0.0.1/api/v1/assets/${voiceBody.data.id}/approve`, { method: "POST", headers: headers("reviewer") }), { params: Promise.resolve({ assetId: voiceBody.data.id }) });
assert.equal(approval.status, 200);
assert.equal((await approval.json()).data.approval, "approved", "approval goes through POST /api/v1/assets/{id}/approve");

// The UI marks unverified presets prominently.
const workspace = await read("apps", "console", "components", "asset-workspace.tsx");
for (const source of ["从默认库添加", "商用授权未核实", "/api/v1/presets/${encodeURIComponent(code)}/adopt"]) assert.ok(workspace.includes(source), `asset workspace must contain ${source}`);

console.log(`PASS  ${presets.demoRuntimePresets.length} default presets are listed, adopted only as pending tenant assets with unverified license status, and approved through the asset workflow`);
