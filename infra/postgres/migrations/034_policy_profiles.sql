create type policy_profile_approval as enum ('pending', 'approved', 'revoked');

create table policy_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 160),
  version text not null check (char_length(version) between 1 and 100),
  rules jsonb not null default '[]'::jsonb,
  evidence_ref text not null check (char_length(evidence_ref) between 1 and 500),
  validation_summary text not null check (char_length(validation_summary) between 1 and 2000),
  approval_status policy_profile_approval not null default 'pending',
  approved_by uuid references users(id) on delete restrict,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, name, version),
  check ((approval_status = 'approved') = (approved_at is not null))
);

create index policy_profiles_tenant_approval_idx on policy_profiles (tenant_id, approval_status, approved_at desc);

create table show_revision_policy_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  show_revision_id uuid not null references show_revisions(id) on delete restrict,
  policy_profile_id uuid not null references policy_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (show_revision_id),
  unique (show_revision_id, policy_profile_id)
);

create index show_revision_policy_profiles_tenant_revision_idx on show_revision_policy_profiles (tenant_id, show_revision_id);

alter table policy_profiles enable row level security;
alter table policy_profiles force row level security;
create policy tenant_isolation_policy_profiles on policy_profiles using (tenant_id::text = current_setting('app.tenant_id', true));

alter table show_revision_policy_profiles enable row level security;
alter table show_revision_policy_profiles force row level security;
create policy tenant_isolation_show_revision_policy_profiles on show_revision_policy_profiles using (tenant_id::text = current_setting('app.tenant_id', true));
