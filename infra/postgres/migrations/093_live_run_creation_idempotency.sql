create unique index live_runs_tenant_id_id_key on live_runs (tenant_id, id);

create table live_run_creation_requests (
  tenant_id uuid not null references tenants(id) on delete restrict,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  request_sha256 text not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  live_run_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, idempotency_key),
  unique (tenant_id, live_run_id),
  foreign key (tenant_id, live_run_id) references live_runs (tenant_id, id) on delete restrict
);

alter table live_run_creation_requests enable row level security;
alter table live_run_creation_requests force row level security;
create policy tenant_isolation_live_run_creation_requests on live_run_creation_requests
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));
