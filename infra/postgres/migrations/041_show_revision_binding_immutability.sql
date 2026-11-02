create or replace function reject_show_revision_binding_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Frozen show revision bindings are immutable';
end;
$$;

create trigger show_revision_product_versions_immutable
before update or delete on show_revision_product_versions
for each row execute function reject_show_revision_binding_mutation();

create trigger show_revision_segments_immutable
before update or delete on show_revision_segments
for each row execute function reject_show_revision_binding_mutation();

create trigger show_revision_model_releases_immutable
before update or delete on show_revision_model_releases
for each row execute function reject_show_revision_binding_mutation();

create trigger show_revision_policy_profiles_immutable
before update or delete on show_revision_policy_profiles
for each row execute function reject_show_revision_binding_mutation();

create trigger show_revision_media_assets_immutable
before update or delete on show_revision_media_assets
for each row execute function reject_show_revision_binding_mutation();
