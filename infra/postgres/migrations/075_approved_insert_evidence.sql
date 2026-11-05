-- M13: the approval governance triggers (051, 052, 058) only run on UPDATE and DELETE, and 064's runtime-script
-- check only on UPDATE of approval_status. A row inserted directly as approved skipped every one of them: no
-- approver, no approval time and, for media assets, no content-verification evidence.
--
-- A BEFORE INSERT trigger now requires the approval evidence columns, passed as trigger arguments, on every row
-- inserted as approved. Rows inserted in any other state are not checked; they still reach approved only through
-- the governed UPDATE transition. Existing rows are not scanned or changed.
create or replace function enforce_approved_insert_evidence()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  candidate jsonb := to_jsonb(new);
  required_column text;
begin
  if TG_OP <> 'INSERT' or (candidate ->> 'approval_status') is distinct from 'approved' then
    return new;
  end if;
  foreach required_column in array TG_ARGV loop
    if not candidate ? required_column then
      raise exception 'approved_insert_requires_evidence: %.% is not a column', TG_TABLE_NAME, required_column;
    end if;
    if candidate ->> required_column is null then
      raise exception 'approved_insert_requires_evidence: %.% must not be null', TG_TABLE_NAME, required_column
        using errcode = 'check_violation', table = TG_TABLE_NAME, column = required_column;
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists product_versions_approved_insert_evidence on product_versions;
create trigger product_versions_approved_insert_evidence
before insert on product_versions
for each row execute function enforce_approved_insert_evidence('approved_by', 'approved_at');

drop trigger if exists show_revisions_approved_insert_evidence on show_revisions;
create trigger show_revisions_approved_insert_evidence
before insert on show_revisions
for each row execute function enforce_approved_insert_evidence('approved_by', 'approved_at');

drop trigger if exists media_assets_approved_insert_evidence on media_assets;
create trigger media_assets_approved_insert_evidence
before insert on media_assets
for each row execute function enforce_approved_insert_evidence('approved_by', 'approved_at', 'verified_object_version', 'verified_bytes', 'verified_content_type', 'verification_evidence_ref', 'verified_at');

drop trigger if exists model_releases_approved_insert_evidence on model_releases;
create trigger model_releases_approved_insert_evidence
before insert on model_releases
for each row execute function enforce_approved_insert_evidence('approved_by', 'approved_at');

drop trigger if exists policy_profiles_approved_insert_evidence on policy_profiles;
create trigger policy_profiles_approved_insert_evidence
before insert on policy_profiles
for each row execute function enforce_approved_insert_evidence('approved_by', 'approved_at');
