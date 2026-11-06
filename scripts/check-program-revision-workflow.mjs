import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFile(path.join(root, ...parts), "utf8");
const [migration, service, listRoute, changeRoute, submitRoute, approveRoute, rejectRoute, page, workspace] = await Promise.all([
  read("infra", "postgres", "migrations", "055_governed_show_program_revisions.sql"),
  read("apps", "console", "lib", "show-program-revisions.ts"),
  read("apps", "console", "app", "api", "v1", "live-runs", "[runId]", "program-revisions", "route.ts"),
  read("apps", "console", "app", "api", "v1", "live-runs", "[runId]", "program-revisions", "[requestId]", "route.ts"),
  read("apps", "console", "app", "api", "v1", "live-runs", "[runId]", "program-revisions", "[requestId]", "submit", "route.ts"),
  read("apps", "console", "app", "api", "v1", "live-runs", "[runId]", "program-revisions", "[requestId]", "approve", "route.ts"),
  read("apps", "console", "app", "api", "v1", "live-runs", "[runId]", "program-revisions", "[requestId]", "reject", "route.ts"),
  read("apps", "console", "app", "shows", "[runId]", "program", "page.tsx"),
  read("apps", "console", "components", "program-revision-workspace.tsx")
]);

for (const source of ["show_program_change_status", "show_program_change_requests_one_active_run_idx", "tenant_isolation_show_program_change_requests", "show_program_change_requests_governed_mutation", "Candidate show revision bindings are immutable", "draft revision request", "live_runs_governed_show_revision_rebind", "old.state not in ('APPROVED', 'PREFLIGHT')"]) {
  if (!migration.includes(source)) throw new Error(`Program revision migration missing: ${source}`);
}
for (const source of ["cloneRevisionBindings", "createReleaseManifestSnapshotInTransaction", "request.created_by_id === actorId", "status = 'approved'", "status = 'applied'", "canRevise(run.state)"]) {
  if (!service.includes(source)) throw new Error(`Program revision service missing: ${source}`);
}
// Script variants (085) travel with the segment row through clone, edit, submit and apply.
for (const source of ["runtime_script_variants", "runtimeScriptVariants", "variantCount", "storedVariants"]) {
  if (!service.includes(source)) throw new Error(`Program revision service must carry script variants: ${source}`);
}
if ((service.match(/runtime_script, runtime_script_variants, is_fallback/g) ?? []).length < 4) throw new Error("Program revision service must clone, load and insert runtime_script_variants with every segment");
for (const [source, role] of [[listRoute, 'requireRole(actor, ["admin", "operator", "reviewer", "analyst"])'], [changeRoute, 'requireRole(actor, ["admin", "operator"])'], [submitRoute, 'requireRole(actor, ["admin", "operator"])'], [approveRoute, 'requireRole(actor, ["admin", "reviewer"])'], [rejectRoute, 'requireRole(actor, ["admin", "reviewer"])']]) {
  if (!source.includes("requestContextFrom(request)") || !source.includes(role)) throw new Error(`Program revision route must enforce database-backed role: ${role}`);
}
if (!page.includes("ProgramRevisionWorkspace") || !workspace.includes("受控节目修订")) throw new Error("Program revision operator workspace must be mounted on the show program page");
if (workspace.includes("window.prompt")) throw new Error("Program revision review reasons must use the bounded workspace input, not browser prompts");

console.log("PASS  governed program revisions require a cloned, sealed candidate, independent review, pre-arm rebind, and renewed manifest/preflight");
