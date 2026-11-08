alter table creation_projects
  add column script_review_sha256 text,
  add column script_review_product_version_id uuid,
  add column script_reviewed_by text,
  add column script_reviewed_at timestamptz,
  add constraint creation_projects_script_review_sha256_check
    check (script_review_sha256 is null or script_review_sha256 ~ '^[a-f0-9]{64}$'),
  add constraint creation_projects_script_review_state_check
    check (
      (script_review_sha256 is null and script_review_product_version_id is null and script_reviewed_by is null and script_reviewed_at is null)
      or (script_review_sha256 is not null and script_review_product_version_id is not null and btrim(script_reviewed_by) <> '' and script_reviewed_at is not null)
    ),
  add constraint creation_projects_script_review_product_fk
    foreign key (tenant_id, script_review_product_version_id) references product_versions (tenant_id, id) on delete restrict;

create function invalidate_creation_project_script_review_on_content_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $body$
begin
  if new.script is distinct from old.script or new.product_version_id is distinct from old.product_version_id then
    new.script_review_sha256 := null;
    new.script_review_product_version_id := null;
    new.script_reviewed_by := null;
    new.script_reviewed_at := null;
  end if;
  return new;
end;
$body$;

create trigger invalidate_creation_project_script_review_on_content_change
before update of script, product_version_id on creation_projects
for each row execute function invalidate_creation_project_script_review_on_content_change();
