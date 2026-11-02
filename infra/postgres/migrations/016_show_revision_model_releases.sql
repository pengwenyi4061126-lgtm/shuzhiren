create table show_revision_model_releases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  show_revision_id uuid not null references show_revisions(id) on delete restrict,
  model_release_id uuid not null references model_releases(id) on delete restrict,
  component model_release_component not null,
  created_at timestamptz not null default now(),
  unique (show_revision_id, component),
  unique (show_revision_id, model_release_id)
);

create index show_revision_model_releases_tenant_revision_idx
  on show_revision_model_releases (tenant_id, show_revision_id);

alter table show_revision_model_releases enable row level security;

create policy tenant_isolation_show_revision_model_releases
  on show_revision_model_releases
  using (tenant_id::text = current_setting('app.tenant_id', true));
