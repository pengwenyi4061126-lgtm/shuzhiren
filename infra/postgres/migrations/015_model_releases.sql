create type model_release_component as enum ('runtime', 'avatar', 'lip_sync', 'voice');
create type model_release_approval as enum ('pending', 'approved', 'revoked');

create table model_releases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  name text not null,
  version text not null,
  component model_release_component not null,
  source_commit text not null,
  image_digest text not null,
  artifact_hash text not null,
  driver_version text not null,
  license text not null,
  rights_scope text not null,
  notes text,
  approval_status model_release_approval not null default 'pending',
  approved_by uuid references users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, component, name, version)
);

create index model_releases_tenant_component_idx on model_releases (tenant_id, component, approval_status, created_at desc);

alter table model_releases enable row level security;

create policy tenant_isolation_model_releases
  on model_releases
  using (tenant_id::text = current_setting('app.tenant_id', true));
