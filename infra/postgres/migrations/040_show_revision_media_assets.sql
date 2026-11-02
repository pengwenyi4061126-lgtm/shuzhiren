create table show_revision_media_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  show_revision_id uuid not null references show_revisions(id) on delete restrict,
  media_asset_id uuid not null references media_assets(id) on delete restrict,
  kind media_asset_kind not null,
  created_at timestamptz not null default now(),
  unique (show_revision_id, kind),
  unique (show_revision_id, media_asset_id)
);

create index show_revision_media_assets_tenant_revision_idx on show_revision_media_assets (tenant_id, show_revision_id);

alter table show_revision_media_assets enable row level security;
alter table show_revision_media_assets force row level security;
create policy tenant_isolation_show_revision_media_assets on show_revision_media_assets using (tenant_id::text = current_setting('app.tenant_id', true));
