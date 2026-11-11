import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildStudioDemoSeedInput, studioDemoProjectName } from "../lib/shared/studio-demo-seed.mjs";

const product = { id: "product-demo", name: "清洁泡沫" };
const version = { id: "version-demo", status: "approved", facts: { priceCent: 5990, stock: 20, highlights: ["按压出泡"], faq: ["湿润后使用"], sourceRef: "demo://product", sourceSyncedAt: "2026-11-11T00:00:00.000Z", validFrom: "2026-11-10T00:00:00.000Z", validUntil: "2026-12-31T23:59:59.000Z" } };

test("Studio demo seed builds one reviewed-ready both-output project input", () => {
  const input = buildStudioDemoSeedInput({
    product,
    version,
    now: new Date("2026-11-11T00:00:00.000Z"),
    assets: [
      { id: "photo", kind: "portrait_photo", approval: "approved", expiresAt: "2026-12-01" },
      { id: "video", kind: "portrait", approval: "approved" },
      { id: "voice", kind: "voice", approval: "approved" },
      { id: "expired", kind: "product_clip", approval: "approved", expiresAt: "2026-11-10" },
      { id: "music", kind: "music", approval: "approved" }
    ]
  });
  assert.equal(input.name, studioDemoProjectName);
  assert.equal(input.outputMode, "both");
  assert.deepEqual(input.assetIds, ["photo", "video", "voice", "music"]);
  assert.match(input.script, /清洁泡沫/);
});

test("Studio exposes an idempotent demo seed action only in the empty project state", async () => {
  const [page, route, workspace] = await Promise.all([
    readFile(new URL("../app/studio/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v1/studio/demo-seed/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/studio-workspace.tsx", import.meta.url), "utf8")
  ]);
  assert.match(page, /demoMode=\{controlPlaneConfig\(\)\.demoMode\}/);
  assert.match(route, /studio_demo_seed_disabled/);
  assert.match(route, /find\(\(project\) => project\.name === studioDemoProjectName\)/);
  assert.match(workspace, /!projects\.length && demoMode/);
  assert.match(workspace, /\/api\/v1\/studio\/demo-seed/);
  assert.match(workspace, /一键体验 Demo/);
});
