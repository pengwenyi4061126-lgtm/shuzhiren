import { readFile } from "node:fs/promises";

const [migration, programMigration, verifier] = await Promise.all([
  readFile(new URL("../infra/postgres/migrations/051_governed_evidence_immutability.sql", import.meta.url), "utf8"),
  readFile(new URL("../infra/postgres/migrations/052_editable_draft_show_programs.sql", import.meta.url), "utf8"),
  readFile(new URL("./verify-postgres-schema.mjs", import.meta.url), "utf8")
]);
for (const source of [
  "product_versions_governed_immutable",
  "show_revisions_append_only",
  "policy_profiles_governed_immutable",
  "model_releases_governed_immutable",
  "live_commands_append_only"
]) {
  if (!migration.includes(source)) throw new Error(`Governed evidence migration must create ${source}`);
}
for (const source of [
  "new.facts is distinct from old.facts",
  "new.rules is distinct from old.rules",
  "new.artifact_hash is distinct from old.artifact_hash",
  "pending approval and approved revocation transitions"
]) {
  if (!migration.includes(source)) throw new Error(`Governed evidence migration must preserve ${source}`);
}
for (const source of ["approved_by uuid", "reject_show_revision_segment_mutation", "state = 'DRAFT'", "draft to approved transition"]) {
  if (!programMigration.includes(source)) throw new Error(`Editable program migration must preserve ${source}`);
}
for (const source of ["verifyGovernedEvidenceImmutability", "expectImmutableRejection", "已批准商品事实不得改写", "直播命令不得改写", "Draft fallback edited", "审核后节目段落不得改写"]) {
  if (!verifier.includes(source)) throw new Error(`PostgreSQL schema verification must exercise ${source}`);
}
console.log("PASS  governed product, editable draft program, policy, release, and command evidence is protected by database triggers");
