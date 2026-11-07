import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFile(path.join(root, ...parts), "utf8");
const serviceRequirements = {
  "assets.ts": ["listAssets", "createMediaAsset", "approveMediaAsset", "revokeMediaAsset"],
  "catalog.ts": ["listProducts", "findProduct", "createProduct", "createProductVersion", "approveProductVersion"],
  "releases.ts": ["listModelReleases", "createModelRelease", "approveModelRelease", "revokeModelRelease"],
  "policy-profiles.ts": ["listPolicyProfiles", "createPolicyProfile", "approvePolicyProfile", "revokePolicyProfile"],
  "entitlements.ts": ["listEntitlements", "setEntitlement"],
  "audit.ts": ["listAuditEvents", "verifyAuditChain", "exportAuditEvidence"],
  "control-plane/store.ts": ["createLiveRun"],
  "interaction-rules.ts": ["listInteractionRules", "getInteractionRule", "createInteractionRule", "updateInteractionRule", "disableInteractionRule", "approveInteractionRule", "createDefaultInteractionRules"],
  "prohibited-terms.ts": ["listProhibitedTerms", "createProhibitedTerm", "updateProhibitedTerm", "retireProhibitedTerm", "requestBuiltinTermOverride", "approveProhibitedTermRevision"],
  "knowledge-base.ts": ["listKnowledgeEntries", "getKnowledgeEntry", "createKnowledgeEntry", "updateKnowledgeEntry", "retireKnowledgeEntry", "approveKnowledgeEntry", "searchKnowledgeEntries"],
  "presets.ts": ["adoptPreset"]
};

const auth = await read("apps", "console", "lib", "control-plane", "auth-context.ts");
for (const marker of ["hasTenantWideAccess", "requireTenantWideAccess", "accessScope !== \"restricted\""]) if (!auth.includes(marker)) throw new Error(`tenant-wide authorization helper missing: ${marker}`);

for (const [service, functions] of Object.entries(serviceRequirements)) {
  const source = await read("apps", "console", "lib", ...service.split("/"));
  for (const name of functions) {
    const start = source.indexOf(`export async function ${name}(`);
    if (start < 0) throw new Error(`governance service export missing: ${service} ${name}`);
    const next = source.indexOf("export async function ", start + 1);
    const body = source.slice(start, next < 0 ? undefined : next);
    if (!body.includes("requireTenantWideAccess(context)")) throw new Error(`governance service lacks tenant-wide guard: ${service} ${name}`);
  }
}

for (const page of ["assets", "products", "releases", "policy", "usage", "audit", "interaction-rules", "prohibited-terms", "knowledge"]) {
  const source = await read("apps", "console", "app", page, "page.tsx");
  if (!source.includes("tenantWide: true")) throw new Error(`tenant-wide governance page lacks access denial: ${page}`);
}

const showsPage = await read("apps", "console", "app", "shows", "page.tsx");
for (const marker of ["hasTenantWideAccess(actor)", "tenantWide ? await listProducts(actor) : []", "canCreate={tenantWide &&"]) if (!showsPage.includes(marker)) throw new Error(`show creation scope guard missing: ${marker}`);

const channelsPage = await read("apps", "console", "app", "channels", "page.tsx");
if (!channelsPage.includes("canCreate={hasTenantWideAccess(actor)")) throw new Error("channel creation UI must respect tenant-wide membership scope");

const runEvents = await read("apps", "console", "lib", "run-events.ts");
if (!runEvents.includes("listAuditEventsForRun(context, runId)") || runEvents.includes("listAuditEvents(context)")) throw new Error("run timeline must query audit events only for its authorized run");

const audit = await read("apps", "console", "lib", "audit.ts");
if (!audit.includes("await assertLiveRunAccess(context, runId)")) throw new Error("run-scoped audit query must enforce live-run authorization directly");

console.log("PASS  tenant-wide governance resources reject restricted memberships while authorized run timelines remain scoped");
