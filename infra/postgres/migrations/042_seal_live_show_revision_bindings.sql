create or replace function reject_show_revision_binding_mutation()
returns trigger
language plpgsql
as $$
declare
  revision_id uuid;
begin
  revision_id := case when tg_op = 'DELETE' then old.show_revision_id else new.show_revision_id end;
  if tg_op <> 'INSERT' or exists (select 1 from live_runs where show_revision_id = revision_id) then
    raise exception 'Frozen show revision bindings are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists show_revision_product_versions_immutable on show_revision_product_versions;
create trigger show_revision_product_versions_immutable
before insert or update or delete on show_revision_product_versions
for each row execute function reject_show_revision_binding_mutation();

drop trigger if exists show_revision_segments_immutable on show_revision_segments;
create trigger show_revision_segments_immutable
before insert or update or delete on show_revision_segments
for each row execute function reject_show_revision_binding_mutation();

drop trigger if exists show_revision_model_releases_immutable on show_revision_model_releases;
create trigger show_revision_model_releases_immutable
before insert or update or delete on show_revision_model_releases
for each row execute function reject_show_revision_binding_mutation();

drop trigger if exists show_revision_policy_profiles_immutable on show_revision_policy_profiles;
create trigger show_revision_policy_profiles_immutable
before insert or update or delete on show_revision_policy_profiles
for each row execute function reject_show_revision_binding_mutation();

drop trigger if exists show_revision_media_assets_immutable on show_revision_media_assets;
create trigger show_revision_media_assets_immutable
before insert or update or delete on show_revision_media_assets
for each row execute function reject_show_revision_binding_mutation();
