alter table model_releases
  add column revoked_by uuid references users(id) on delete restrict,
  add column revoked_at timestamptz,
  add column revocation_reason text check (revocation_reason is null or char_length(revocation_reason) between 1 and 1000);

alter table model_releases add constraint model_releases_approval_history_check check (
  (approval_status = 'pending' and approved_at is null and approved_by is null and revoked_at is null and revoked_by is null and revocation_reason is null)
  or (approval_status = 'approved' and approved_at is not null and revoked_at is null and revoked_by is null and revocation_reason is null)
  or (approval_status = 'revoked' and approved_at is not null and revoked_at is not null and revoked_by is not null and revocation_reason is not null)
);

create index model_releases_tenant_revoked_idx on model_releases (tenant_id, revoked_at desc) where approval_status = 'revoked';
