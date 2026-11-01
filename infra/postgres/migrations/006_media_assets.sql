create type media_asset_kind as enum ('portrait', 'voice', 'product_clip', 'music');
create type media_asset_approval as enum ('pending', 'approved', 'revoked');

create table media_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  kind media_asset_kind not null,
  name text not null,
  object_key text not null,
  checksum text not null,
  rights_scope text not null,
  approval_status media_asset_approval not null default 'pending',
  expires_at date,
  approved_by uuid references users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create index media_assets_tenant_approval_idx on media_assets (tenant_id, kind, approval_status);

alter table media_assets enable row level security;

create policy tenant_isolation_media_assets
  on media_assets
  using (tenant_id::text = current_setting('app.tenant_id', true));
