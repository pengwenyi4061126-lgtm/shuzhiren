create type channel_connection_status as enum ('connected', 'degraded', 'disabled');
create type stream_protocol as enum ('rtmp', 'srt');

create table channel_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  name text not null,
  provider text not null,
  status channel_connection_status not null default 'disabled',
  output_protocol stream_protocol not null,
  secret_ref text not null,
  capabilities jsonb not null,
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create index channel_connections_tenant_status_idx on channel_connections (tenant_id, status);

alter table channel_connections enable row level security;

create policy tenant_isolation_channel_connections
  on channel_connections
  using (tenant_id::text = current_setting('app.tenant_id', true));
