create extension if not exists pgcrypto;

create type live_run_state as enum ('DRAFT', 'REVIEW', 'APPROVED', 'PREFLIGHT', 'ARMED', 'LIVE', 'DEGRADED', 'ENDED', 'ARCHIVED');
create type membership_role as enum ('admin', 'operator', 'reviewer', 'analyst');
create type check_status as enum ('passed', 'blocked');

create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  external_subject text not null unique,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table memberships (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role membership_role not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  external_sku text not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, external_sku)
);

create table product_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  product_id uuid not null references products(id) on delete restrict,
  revision integer not null,
  facts jsonb not null,
  approval_status text not null check (approval_status in ('draft', 'approved', 'rejected')),
  approved_by uuid references users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (product_id, revision)
);

create table shows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  name text not null,
  created_at timestamptz not null default now()
);

create table show_revisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  show_id uuid not null references shows(id) on delete restrict,
  revision integer not null,
  plan jsonb not null,
  approval_status text not null check (approval_status in ('draft', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  unique (show_id, revision)
);

create table live_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  show_revision_id uuid not null references show_revisions(id) on delete restrict,
  state live_run_state not null,
  trace_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table live_commands (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  live_run_id uuid not null references live_runs(id) on delete restrict,
  actor_id uuid not null references users(id) on delete restrict,
  idempotency_key text not null,
  expected_state live_run_state not null,
  action text not null,
  result jsonb not null,
  issued_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create table preflight_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  show_revision_id uuid not null references show_revisions(id) on delete restrict,
  code text not null,
  status check_status not null,
  detail text not null,
  checked_at timestamptz not null default now()
);

create index product_versions_tenant_product_idx on product_versions (tenant_id, product_id, revision desc);
create index live_runs_tenant_state_idx on live_runs (tenant_id, state, updated_at desc);
create index live_commands_run_issued_idx on live_commands (live_run_id, issued_at desc);

alter table products enable row level security;
alter table product_versions enable row level security;
alter table shows enable row level security;
alter table show_revisions enable row level security;
alter table live_runs enable row level security;
alter table live_commands enable row level security;
alter table preflight_checks enable row level security;

create policy tenant_isolation_products on products using (tenant_id::text = current_setting('app.tenant_id', true));
create policy tenant_isolation_product_versions on product_versions using (tenant_id::text = current_setting('app.tenant_id', true));
create policy tenant_isolation_shows on shows using (tenant_id::text = current_setting('app.tenant_id', true));
create policy tenant_isolation_show_revisions on show_revisions using (tenant_id::text = current_setting('app.tenant_id', true));
create policy tenant_isolation_live_runs on live_runs using (tenant_id::text = current_setting('app.tenant_id', true));
create policy tenant_isolation_live_commands on live_commands using (tenant_id::text = current_setting('app.tenant_id', true));
create policy tenant_isolation_preflight_checks on preflight_checks using (tenant_id::text = current_setting('app.tenant_id', true));
