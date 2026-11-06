import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFile(path.join(root, ...parts), "utf8");
const [migration, program, revisions, workspace, revisionWorkspace, schema] = await Promise.all([
  read("infra", "postgres", "migrations", "064_governed_runtime_program_scripts.sql"),
  read("apps", "console", "lib", "show-program.ts"),
  read("apps", "console", "lib", "show-program-revisions.ts"),
  read("apps", "console", "components", "program-workspace.tsx"),
  read("apps", "console", "components", "program-revision-workspace.tsx"),
  read("scripts", "verify-postgres-schema.mjs")
]);

for (const source of ["runtime_script", "show_revision_segments_runtime_script_length", "require_runtime_scripts_for_program_approval", "require_runtime_scripts_for_program_submission", "show_revisions_require_runtime_scripts_for_approval", "show_program_change_requests_require_runtime_scripts", "reject_show_revision_segment_mutation", "approval_status = 'draft'"]) {
  if (!migration.includes(source)) throw new Error(`Runtime program script migration is missing: ${source}`);
}
for (const source of ["runtimeScript", "Runnable program segments require a frozen runtime script", "programHash", "runtime_script"]) {
  if (!program.includes(source)) throw new Error(`Show program service must govern runtime scripts: ${source}`);
}
for (const source of ["runtime_script", "runtimeScript", "legacy-script-pending-revision"]) {
  if (!revisions.includes(source)) throw new Error(`Program revision workflow must preserve and upgrade runtime scripts: ${source}`);
}
for (const source of ["冻结运行脚本", "runtimeScript"]) {
  if (!workspace.includes(source)) throw new Error(`Program workspace must edit frozen runtime scripts: ${source}`);
}
for (const source of ["候选运行脚本", "runtimeScript"]) {
  if (!revisionWorkspace.includes(source)) throw new Error(`Program revision workspace must edit frozen runtime scripts: ${source}`);
}
for (const source of ["show_revision_segments_runtime_script_length", "show_revisions_require_runtime_scripts_for_approval", "show_program_change_requests_require_runtime_scripts"]) {
  if (!schema.includes(source)) throw new Error(`Database schema verifier must require runtime script governance: ${source}`);
}

// 085: extra script versions are a column of the same governed segment row, and every dispatch is ledgered.
const variantMigration = await read("infra", "postgres", "migrations", "085_segment_script_variants.sql");
for (const source of ["runtime_script_variants", "script_variants_valid", "show_revision_segments_runtime_script_variants_check", "live_run_script_plays", "tenant_isolation_live_run_script_plays", "enforce_live_run_script_play", "live_run_script_plays_governed", "live run script plays are append-only", "live_run_script_plays_last_idx"]) {
  if (!variantMigration.includes(source)) throw new Error(`Script variant migration is missing: ${source}`);
}
for (const source of ["runtime_script_variants", "show_revision_segments_runtime_script_variants_check", "live_run_script_plays", "live_run_script_plays_governed", "live_run_script_plays_last_idx"]) {
  if (!schema.includes(source)) throw new Error(`Database schema verifier must require script variant governance: ${source}`);
}

console.log("PASS  runnable show segments require versioned runtime scripts, review-time database gates, and operator-visible editing");
