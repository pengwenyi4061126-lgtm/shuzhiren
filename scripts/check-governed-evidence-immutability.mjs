import { readFile } from "node:fs/promises";

const [migration, programMigration, replyMigration, revisionMigration, verifier] = await Promise.all([
  readFile(new URL("../infra/postgres/migrations/051_governed_evidence_immutability.sql", import.meta.url), "utf8"),
  readFile(new URL("../infra/postgres/migrations/052_editable_draft_show_programs.sql", import.meta.url), "utf8"),
  readFile(new URL("../infra/postgres/migrations/053_channel_reply_workflow.sql", import.meta.url), "utf8"),
  readFile(new URL("../infra/postgres/migrations/055_governed_show_program_revisions.sql", import.meta.url), "utf8"),
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
for (const source of ["channel_reply_drafts_governed_mutation", "channel reply identity is immutable", "failed' and new.status = 'approved'", "channel reply drafts are immutable"]) {
  if (!replyMigration.includes(source)) throw new Error(`Channel reply migration must preserve ${source}`);
}
for (const source of ["show_program_change_requests_governed_mutation", "Candidate show revision bindings are immutable", "live_runs_governed_show_revision_rebind", "Replacement revision requires an approved governed change request"]) {
  if (!revisionMigration.includes(source)) throw new Error(`Governed program revision migration must preserve ${source}`);
}
for (const source of ["verifyGovernedEvidenceImmutability", "expectImmutableRejection", "已批准商品事实不得改写", "直播命令不得改写", "Draft fallback edited", "审核后节目段落不得改写", "候选节目依赖绑定不得改写", "送审后的渠道回复正文不得改写", "投递中的渠道回复不得改写目标渠道"]) {
  if (!verifier.includes(source)) throw new Error(`PostgreSQL schema verification must exercise ${source}`);
}
console.log("PASS  governed product, draft and candidate program, channel reply, policy, release, and command evidence is protected by database triggers");
