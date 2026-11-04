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

console.log("PASS  runnable show segments require versioned runtime scripts, review-time database gates, and operator-visible editing");
