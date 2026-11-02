alter table policy_profiles
  add column revoked_by uuid references users(id) on delete restrict,
  add column revoked_at timestamptz,
  add column revocation_reason text check (revocation_reason is null or char_length(revocation_reason) between 1 and 1000);

create index policy_profiles_tenant_revoked_idx on policy_profiles (tenant_id, revoked_at desc) where approval_status = 'revoked';
