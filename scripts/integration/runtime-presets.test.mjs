// Default avatar and voice presets (migration 082) against real PostgreSQL: the seeded catalogue, its constraints,
// read-only access for the control plane, and adoption through apps/console/lib/presets.ts as the control-plane
// account (pending tenant asset, content verification, audit events, tenant isolation, normal approval).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { createHarness } from "./harness.mjs";
import { REPO_ROOT } from "./lib/cluster.mjs";

register("../lib/console-ts-loader.mjs", import.meta.url);
const verifierToken = "runtime-presets-integration-verifier-token";
let h;
let verifier;
let verifierAnswer;
let presets;
let assets;
before(async () => {
  h = await createHarness(import.meta.url);
  verifier = await h.stub();
  verifierAnswer = (body) => ({ status: 200, json: { objectKey: body.objectKey, checksum: body.expectedChecksum, objectVersion: "it-v1", bytes: 4096, contentType: body.kind === "voice" ? "audio/wav" : "video/mp4", evidenceRef: `evidence://it/${body.objectKey}`, verifiedAt: new Date().toISOString() } });
  verifier.route("POST", "/v1/media-evidence/verify", (req, raw) => {
    if (req.headers.authorization !== `Bearer ${verifierToken}`) return { status: 401, json: { error: "unauthorized" } };
    return verifierAnswer(JSON.parse(raw));
  });
  // The console libraries connect as the control-plane account (no SUPERUSER, no BYPASSRLS).
  Object.assign(process.env, { NODE_ENV: "development", DATABASE_URL: h.url("control_plane"), MEDIA_EVIDENCE_VERIFIER_URL: verifier.baseUrl, MEDIA_EVIDENCE_VERIFIER_TOKEN: verifierToken });
  delete process.env.CONTROL_PLANE_DEMO_MODE;
  presets = await import(pathToFileURL(path.join(REPO_ROOT, "apps", "console", "lib", "presets.ts")).href);
  assets = await import(pathToFileURL(path.join(REPO_ROOT, "apps", "console", "lib", "assets.ts")).href);
});
after(async () => {
  await globalThis.shuzhirenDatabasePool?.end().catch(() => undefined);
  await h?.close();
});

const presetColumns = "kind, preset_code, display_name, gender, voice_style, compatible_model_kind, runtime_ref, sft_speaker_id, license_name, license_source_url, commercial_use_status, enabled";
const validRow = (overrides = {}) => ({ kind: "voice", preset_code: `it-${randomUUID().slice(0, 8)}`, display_name: "测试声音", compatible_model_kind: "zero_shot", runtime_ref: "it-voice", material_requirements: "运营方提供", license_name: "测试许可（未核实）", ...overrides });

async function insertAs(client, row) {
  const columns = Object.keys(row);
  return client.query(`insert into runtime_presets (${columns.join(", ")}) values (${columns.map((_, index) => `$${index + 1}`).join(", ")})`, columns.map((column) => row[column]));
}

async function expectRejected(client, sql, params, code, label) {
  await client.query("savepoint expect_rejected");
  try {
    await client.query(sql, params);
    assert.fail(`${label} must be rejected`);
  } catch (error) {
    assert.equal(error.code, code, `${label}: ${error.message}`);
  } finally {
    await client.query("rollback to savepoint expect_rejected");
    await client.query("release savepoint expect_rejected");
  }
}

describe("runtime_presets catalogue", () => {
  test("082 seeds a default female voice, a default male voice and one avatar slot, all unverified", async () => {
    const rows = await h.snapshot(`select ${presetColumns} from runtime_presets order by kind desc, preset_code`);
    assert.deepEqual(rows.map((row) => [row.kind, row.preset_code, row.runtime_ref, row.sft_speaker_id, row.gender, row.compatible_model_kind, row.commercial_use_status, row.enabled]), [
      ["voice", "preset-zh-female", "preset-zh-female", "中文女", "female", "any", "unverified", true],
      ["voice", "preset-zh-male", "preset-zh-male", "中文男", "male", "any", "unverified", true],
      ["avatar", "preset-avatar-default", "preset-avatar-default", null, null, "any", "unverified", true]
    ]);
    const table = await h.snapshot("select exists (select 1 from information_schema.columns where table_name = 'runtime_presets' and column_name = 'tenant_id') as tenant_column, (select relrowsecurity from pg_class where oid = 'runtime_presets'::regclass) as rls");
    assert.deepEqual(table, [{ tenant_column: false, rls: false }], "the platform catalogue has no tenant column and no tenant RLS");
  });

  test("constraints reject unsafe runtime references, unknown kinds and unsupported license claims", async () => {
    await h.admin.query("begin");
    try {
      assert.equal((await insertAs(h.admin, validRow())).rowCount, 1, "a valid row is accepted");
      const rejected = [
        [{ kind: "music" }, "an unknown kind"],
        [{ preset_code: "Preset Upper" }, "a preset code outside [a-z0-9-]"],
        [{ preset_code: "preset-zh-female" }, "a duplicate preset code", "23505"],
        [{ runtime_ref: "中文女" }, "a non-ASCII runtime reference"],
        [{ runtime_ref: "../voices" }, "a path-like runtime reference"],
        [{ compatible_model_kind: "instruct" }, "an unknown model kind"],
        [{ commercial_use_status: "licensed" }, "an unknown license status"],
        [{ commercial_use_status: "verified" }, "a verified status without a license source"],
        [{ license_source_url: "http://insecure.example/license" }, "a non-HTTPS license source"],
        [{ kind: "avatar", sft_speaker_id: "中文女", compatible_model_kind: "any" }, "an sft speaker on an avatar"],
        [{ sft_speaker_id: "中文女" }, "an sft speaker on a zero_shot-only voice"],
        [{ compatible_model_kind: "sft", sft_speaker_id: " 中文女" }, "a speaker name with surrounding whitespace"],
        [{ compatible_model_kind: "sft", sft_speaker_id: "中文\n女" }, "a speaker name with a control character"],
        [{ kind: "avatar", compatible_model_kind: "sft" }, "an avatar bound to one voice model kind"],
        [{ gender: "unknown" }, "an unknown gender"],
        [{ display_name: " " }, "an empty display name"]
      ];
      for (const [overrides, label, code = "23514"] of rejected) {
        const row = validRow(overrides);
        const columns = Object.keys(row);
        await expectRejected(h.admin, `insert into runtime_presets (${columns.join(", ")}) values (${columns.map((_, index) => `$${index + 1}`).join(", ")})`, columns.map((column) => row[column]), code, label);
      }
      assert.equal((await insertAs(h.admin, validRow({ commercial_use_status: "verified", license_source_url: "https://example.com/license" }))).rowCount, 1, "verified with a license source is accepted");
    } finally {
      await h.admin.query("rollback");
    }
  });

  test("the control plane reads the catalogue without a tenant context and cannot change it", async () => {
    const client = await h.connectAs("control_plane");
    try {
      assert.equal((await client.query("select count(*)::int as n from runtime_presets where enabled")).rows[0].n, 3);
      for (const [sql, label] of [
        ["insert into runtime_presets (kind, preset_code, display_name, compatible_model_kind, runtime_ref, material_requirements, license_name) values ('voice', 'forged', 'x', 'any', 'forged', 'x', 'x')", "insert"],
        ["update runtime_presets set commercial_use_status = 'verified', license_source_url = 'https://forged.example'", "update"],
        ["delete from runtime_presets", "delete"],
        ["truncate runtime_presets", "truncate"]
      ]) await assert.rejects(client.query(sql), (error) => error.code === "42501", `the control plane must not ${label} presets`);
    } finally {
      await client.end();
    }
    for (const principal of ["runtime_worker", "channel_adapter", "alert_notifier"]) {
      const service = await h.connectAs(principal);
      try {
        await assert.rejects(service.query("select 1 from runtime_presets"), (error) => error.code === "42501", `${principal} needs no access to the preset catalogue`);
      } finally {
        await service.end();
      }
    }
  });
});

describe("adopting a preset through apps/console/lib/presets.ts", () => {
  let tenantId;
  let otherTenantId;
  const context = (role, overrides = {}) => ({ tenantId, actorId: `it-presets-${role}`, actorName: `Presets ${role}`, role, accessScope: "tenant", ...overrides });
  before(async () => {
    tenantId = await h.seed.tenant({ name: "Presets tenant" });
    otherTenantId = await h.seed.tenant({ name: "Presets other tenant" });
    for (const role of ["operator", "reviewer"]) await h.seed.member({ tenantId, subject: `it-presets-${role}`, role });
  });

  test("listPresets returns the enabled catalogue, identical to the demo-mode copy", async () => {
    const plain = (value) => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(await presets.listPresets(context("operator"))), plain(presets.demoRuntimePresets));
  });

  test("a voice preset becomes a pending, content-verified tenant asset with both audit events; approval stays separate", async () => {
    const checksum = `sha256:${"c".repeat(64)}`;
    const before = verifier.requests.length;
    const { asset, preset } = await presets.adoptPreset(context("operator"), "preset-zh-male", { objectKey: "tenant/voices/preset-zh-male/prompt.wav", checksum });
    assert.equal(preset.commercialUseStatus, "unverified");
    assert.equal(verifier.requests.length, before + 1, "adoption verifies the uploaded object like POST /api/v1/assets");
    assert.deepEqual(JSON.parse(verifier.requests.at(-1).rawBody), { tenantId, kind: "voice", objectKey: "tenant/voices/preset-zh-male/prompt.wav", expectedChecksum: checksum });
    const stored = await h.snapshot("select tenant_id, kind, approval_status, runtime_voice_id, checksum, rights_scope, source_ref, verified_object_version, verified_content_type, approved_by from media_assets where id = $1", [asset.id]);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].tenant_id, tenantId);
    assert.equal(stored[0].kind, "voice");
    assert.equal(stored[0].approval_status, "pending");
    assert.equal(stored[0].runtime_voice_id, "preset-zh-male");
    assert.equal(stored[0].checksum, checksum);
    assert.equal(stored[0].approved_by, null);
    assert.equal(stored[0].verified_object_version, "it-v1");
    assert.equal(stored[0].verified_content_type, "audio/wav");
    assert.match(stored[0].rights_scope, /preset-zh-male.*商用授权未核实/);
    assert.match(stored[0].source_ref, /^preset:preset-zh-male · runtime_voice_id=preset-zh-male（sft 说话人 中文男）/);
    const events = await h.snapshot("select tenant_id, event_type, detail from audit_events where resource_key = $1 order by event_type", [asset.id]);
    assert.deepEqual(events.map((event) => [event.tenant_id, event.event_type]), [[tenantId, "media_asset.created"], [tenantId, "runtime_preset.adopted"]]);
    assert.equal(events[0].detail.presetCode, "preset-zh-male");
    assert.deepEqual([events[1].detail.presetCode, events[1].detail.commercialUseStatus, events[1].detail.approval], ["preset-zh-male", "unverified", "pending"]);

    // Tenant isolation: another tenant does not see the adopted asset.
    const others = await assets.listAssets({ tenantId: otherTenantId, actorId: "it-presets-other", actorName: "Other", role: "admin" });
    assert.equal(others.some((item) => item.id === asset.id), false);
    // The adopted voice is not usable until a reviewer approves it through the normal asset workflow.
    const approved = await assets.approveMediaAsset(context("reviewer"), asset.id);
    assert.equal(approved.approval, "approved");
    assert.equal((await h.snapshot("select approval_status from media_assets where id = $1", [asset.id]))[0].approval_status, "approved");
  });

  test("the avatar slot becomes a pending portrait without a runtime voice id", async () => {
    const { asset } = await presets.adoptPreset(context("operator"), "preset-avatar-default", { objectKey: "tenant/portraits/preset-avatar-default.mp4", checksum: `sha256:${"d".repeat(64)}`, expiresAt: "2027-06-30" });
    const stored = await h.snapshot("select kind, approval_status, runtime_voice_id, expires_at::text as expires_at, source_ref from media_assets where id = $1", [asset.id]);
    assert.deepEqual(stored.map((row) => [row.kind, row.approval_status, row.runtime_voice_id, row.expires_at]), [["portrait", "pending", null, "2027-06-30"]]);
    assert.match(stored[0].source_ref, /LiveTalking avatar_id=preset-avatar-default/);
  });

  test("a failed content verification, a restricted membership, an unknown or a disabled preset create nothing", async () => {
    const count = async () => (await h.snapshot("select count(*)::int as n from media_assets where tenant_id = $1", [tenantId]))[0].n;
    const before = await count();
    const original = verifierAnswer;
    verifierAnswer = () => ({ status: 502, json: { error: "object missing" } });
    try {
      await assert.rejects(presets.adoptPreset(context("operator"), "preset-zh-female", { objectKey: "tenant/voices/missing.wav", checksum: `sha256:${"e".repeat(64)}` }), (error) => error instanceof Response && error.status === 502);
    } finally {
      verifierAnswer = original;
    }
    await assert.rejects(presets.adoptPreset(context("operator", { accessScope: "restricted" }), "preset-zh-female", { objectKey: "tenant/voices/female.wav", checksum: `sha256:${"e".repeat(64)}` }), (error) => error instanceof Response && error.status === 403);
    await assert.rejects(presets.adoptPreset(context("operator"), "preset-unknown", { objectKey: "tenant/voices/female.wav", checksum: `sha256:${"e".repeat(64)}` }), (error) => error instanceof Response && error.status === 404);
    await h.admin.query("update runtime_presets set enabled = false where preset_code = 'preset-zh-female'");
    try {
      assert.deepEqual((await presets.listPresets(context("operator"))).map((preset) => preset.code), ["preset-zh-male", "preset-avatar-default"]);
      await assert.rejects(presets.adoptPreset(context("operator"), "preset-zh-female", { objectKey: "tenant/voices/female.wav", checksum: `sha256:${"e".repeat(64)}` }), (error) => error instanceof Response && error.status === 404);
    } finally {
      await h.admin.query("update runtime_presets set enabled = true where preset_code = 'preset-zh-female'");
    }
    assert.equal(await count(), before);
  });
});
