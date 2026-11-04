alter table media_assets
  add column if not exists verified_object_version text,
  add column if not exists verified_bytes bigint,
  add column if not exists verified_content_type text,
  add column if not exists verification_evidence_ref text,
  add column if not exists verified_at timestamptz;

alter table media_assets
  add constraint media_assets_verified_bytes_check check (verified_bytes is null or verified_bytes > 0),
  add constraint media_assets_verified_content_type_check check (verified_content_type is null or verified_content_type ~ '^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$');

create index media_assets_tenant_verification_idx on media_assets (tenant_id, verified_at desc);

create or replace function enforce_media_asset_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'media_assets evidence is immutable';
  end if;

  if new.id is distinct from old.id
    or new.tenant_id is distinct from old.tenant_id
    or new.kind is distinct from old.kind
    or new.name is distinct from old.name
    or new.object_key is distinct from old.object_key
    or new.checksum is distinct from old.checksum
    or new.rights_scope is distinct from old.rights_scope
    or new.source_ref is distinct from old.source_ref
    or new.expires_at is distinct from old.expires_at
    or new.runtime_voice_id is distinct from old.runtime_voice_id
    or new.created_at is distinct from old.created_at then
    raise exception 'media_assets evidence fields are immutable';
  end if;

  if old.approval_status = 'pending'
    and new.approval_status = 'approved'
    and old.approved_by is null and old.approved_at is null
    and new.approved_by is not null and new.approved_at is not null
    and new.verified_object_version is not null and new.verified_bytes is not null
    and new.verified_content_type is not null and new.verification_evidence_ref is not null and new.verified_at is not null
    and new.revoked_by is null and new.revoked_at is null and new.revocation_reason is null then
    return new;
  end if;

  if old.approval_status = 'approved'
    and new.approval_status = 'revoked'
    and new.approved_by is not distinct from old.approved_by and new.approved_at is not distinct from old.approved_at
    and new.verified_object_version is not distinct from old.verified_object_version
    and new.verified_bytes is not distinct from old.verified_bytes
    and new.verified_content_type is not distinct from old.verified_content_type
    and new.verification_evidence_ref is not distinct from old.verification_evidence_ref
    and new.verified_at is not distinct from old.verified_at
    and new.revoked_by is not null and new.revoked_at is not null and new.revocation_reason is not null then
    return new;
  end if;

  raise exception 'media_assets only permits content-verified approval and approved revocation transitions';
end;
$$;

create trigger media_assets_governed_evidence_mutation
before update or delete on media_assets
for each row execute function enforce_media_asset_evidence_mutation();
