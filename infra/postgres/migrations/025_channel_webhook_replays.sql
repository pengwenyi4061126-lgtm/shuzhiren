create type channel_webhook_replay_state as enum ('pending', 'delivered');

-- A private channel adapter records verified webhook identities before forwarding.
-- A crash after forwarding remains pending and is safe to retry because downstream
-- interaction and commerce endpoints also enforce their own idempotency.
create table channel_webhook_replays (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  channel_connection_id uuid not null references channel_connections(id) on delete restrict,
  external_event_id text not null,
  payload_sha256 char(64) not null,
  state channel_webhook_replay_state not null default 'pending',
  received_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (tenant_id, channel_connection_id, external_event_id)
);

create index channel_webhook_replays_tenant_state_idx on channel_webhook_replays (tenant_id, state, received_at desc);

alter table channel_webhook_replays enable row level security;
alter table channel_webhook_replays force row level security;
create policy tenant_isolation_channel_webhook_replays on channel_webhook_replays using (tenant_id::text = current_setting('app.tenant_id', true));
