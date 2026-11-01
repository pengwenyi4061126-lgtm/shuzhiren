create table audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  actor_id uuid references users(id) on delete set null,
  event_type text not null,
  resource_type text not null,
  resource_id uuid,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index audit_events_tenant_occurred_idx
  on audit_events (tenant_id, occurred_at desc);

alter table audit_events enable row level security;

create policy tenant_isolation_audit_events
  on audit_events
  using (tenant_id::text = current_setting('app.tenant_id', true));
