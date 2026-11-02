alter table policy_profiles drop constraint policy_profiles_check;

alter table policy_profiles add constraint policy_profiles_approval_history_check check (
  (approval_status = 'pending' and approved_at is null and approved_by is null and revoked_at is null and revoked_by is null and revocation_reason is null)
  or (approval_status = 'approved' and approved_at is not null and revoked_at is null and revoked_by is null and revocation_reason is null)
  or (approval_status = 'revoked' and approved_at is not null and revoked_at is not null and revoked_by is not null and revocation_reason is not null)
);
