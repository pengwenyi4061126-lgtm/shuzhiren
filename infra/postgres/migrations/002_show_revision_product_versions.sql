create table show_revision_product_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  show_revision_id uuid not null references show_revisions(id) on delete restrict,
  product_version_id uuid not null references product_versions(id) on delete restrict,
  slot_key text not null,
  created_at timestamptz not null default now(),
  unique (show_revision_id, slot_key),
  unique (show_revision_id, product_version_id)
);

create index show_revision_product_versions_tenant_revision_idx
  on show_revision_product_versions (tenant_id, show_revision_id);

alter table show_revision_product_versions enable row level security;

create policy tenant_isolation_show_revision_product_versions
  on show_revision_product_versions
  using (tenant_id::text = current_setting('app.tenant_id', true));
