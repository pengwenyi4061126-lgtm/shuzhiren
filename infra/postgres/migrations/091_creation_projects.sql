create table creation_projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  goal text not null check (char_length(btrim(goal)) between 1 and 500),
  audience text not null check (char_length(btrim(audience)) between 1 and 300),
  output_mode text not null check (output_mode in ('recording', 'live', 'both')),
  product_version_id uuid not null,
  script text not null check (char_length(script) <= 12000),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, product_version_id) references product_versions (tenant_id, id) on delete restrict
);

create index creation_projects_tenant_updated_idx on creation_projects (tenant_id, updated_at desc);

create table creation_project_assets (
  tenant_id uuid not null references tenants(id) on delete restrict,
  project_id uuid not null,
  media_asset_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, project_id, media_asset_id),
  foreign key (tenant_id, project_id) references creation_projects (tenant_id, id) on delete restrict,
  foreign key (tenant_id, media_asset_id) references media_assets (tenant_id, id) on delete restrict
);

create index creation_project_assets_tenant_asset_idx on creation_project_assets (tenant_id, media_asset_id);

create table creation_project_live_outputs (
  tenant_id uuid not null references tenants(id) on delete restrict,
  project_id uuid not null,
  live_run_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, project_id, live_run_id),
  foreign key (tenant_id, project_id) references creation_projects (tenant_id, id) on delete restrict,
  foreign key (tenant_id, live_run_id) references live_runs (tenant_id, id) on delete restrict
);

create index creation_project_live_outputs_tenant_run_idx on creation_project_live_outputs (tenant_id, live_run_id);

alter table creation_projects enable row level security;
alter table creation_projects force row level security;
create policy tenant_isolation_creation_projects on creation_projects
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));

alter table creation_project_assets enable row level security;
alter table creation_project_assets force row level security;
create policy tenant_isolation_creation_project_assets on creation_project_assets
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));

alter table creation_project_live_outputs enable row level security;
alter table creation_project_live_outputs force row level security;
create policy tenant_isolation_creation_project_live_outputs on creation_project_live_outputs
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));
