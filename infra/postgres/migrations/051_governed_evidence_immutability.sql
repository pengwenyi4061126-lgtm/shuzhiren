create or replace function reject_immutable_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is immutable', tg_table_name;
end;
$$;

create or replace function enforce_product_version_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'product_versions is immutable';
  end if;

  if new.id is distinct from old.id
    or new.tenant_id is distinct from old.tenant_id
    or new.product_id is distinct from old.product_id
    or new.revision is distinct from old.revision
    or new.facts is distinct from old.facts
    or new.created_at is distinct from old.created_at then
    raise exception 'product_versions evidence fields are immutable';
  end if;

  if old.approval_status = 'draft'
    and new.approval_status = 'approved'
    and old.approved_by is null
    and old.approved_at is null
    and new.approved_by is not null
    and new.approved_at is not null then
    return new;
  end if;

  raise exception 'product_versions only permits a draft to approved transition';
end;
$$;

create or replace function enforce_policy_profile_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'policy_profiles is immutable';
  end if;

  if new.id is distinct from old.id
    or new.tenant_id is distinct from old.tenant_id
    or new.name is distinct from old.name
    or new.version is distinct from old.version
    or new.rules is distinct from old.rules
    or new.evidence_ref is distinct from old.evidence_ref
    or new.validation_summary is distinct from old.validation_summary
    or new.created_at is distinct from old.created_at then
    raise exception 'policy_profiles evidence fields are immutable';
  end if;

  if old.approval_status = 'pending'
    and new.approval_status = 'approved'
    and old.approved_by is null
    and old.approved_at is null
    and old.revoked_by is null
    and old.revoked_at is null
    and old.revocation_reason is null
    and new.approved_by is not null
    and new.approved_at is not null
    and new.revoked_by is null
    and new.revoked_at is null
    and new.revocation_reason is null then
    return new;
  end if;

  if old.approval_status = 'approved'
    and new.approval_status = 'revoked'
    and new.approved_by is not distinct from old.approved_by
    and new.approved_at is not distinct from old.approved_at
    and new.revoked_by is not null
    and new.revoked_at is not null
    and new.revocation_reason is not null then
    return new;
  end if;

  raise exception 'policy_profiles only permits pending approval and approved revocation transitions';
end;
$$;

create or replace function enforce_model_release_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'model_releases is immutable';
  end if;

  if new.id is distinct from old.id
    or new.tenant_id is distinct from old.tenant_id
    or new.name is distinct from old.name
    or new.version is distinct from old.version
    or new.component is distinct from old.component
    or new.source_commit is distinct from old.source_commit
    or new.image_digest is distinct from old.image_digest
    or new.artifact_hash is distinct from old.artifact_hash
    or new.driver_version is distinct from old.driver_version
    or new.license is distinct from old.license
    or new.rights_scope is distinct from old.rights_scope
    or new.evidence_ref is distinct from old.evidence_ref
    or new.validation_summary is distinct from old.validation_summary
    or new.notes is distinct from old.notes
    or new.created_at is distinct from old.created_at then
    raise exception 'model_releases evidence fields are immutable';
  end if;

  if old.approval_status = 'pending'
    and new.approval_status = 'approved'
    and old.approved_by is null
    and old.approved_at is null
    and old.revoked_by is null
    and old.revoked_at is null
    and old.revocation_reason is null
    and new.approved_by is not null
    and new.approved_at is not null
    and new.revoked_by is null
    and new.revoked_at is null
    and new.revocation_reason is null then
    return new;
  end if;

  if old.approval_status = 'approved'
    and new.approval_status = 'revoked'
    and new.approved_by is not distinct from old.approved_by
    and new.approved_at is not distinct from old.approved_at
    and new.revoked_by is not null
    and new.revoked_at is not null
    and new.revocation_reason is not null then
    return new;
  end if;

  raise exception 'model_releases only permits pending approval and approved revocation transitions';
end;
$$;

create trigger product_versions_governed_immutable
before update or delete on product_versions
for each row execute function enforce_product_version_evidence_mutation();

create trigger show_revisions_append_only
before update or delete on show_revisions
for each row execute function reject_immutable_evidence_mutation();

create trigger policy_profiles_governed_immutable
before update or delete on policy_profiles
for each row execute function enforce_policy_profile_evidence_mutation();

create trigger model_releases_governed_immutable
before update or delete on model_releases
for each row execute function enforce_model_release_evidence_mutation();

create trigger live_commands_append_only
before update or delete on live_commands
for each row execute function reject_immutable_evidence_mutation();
