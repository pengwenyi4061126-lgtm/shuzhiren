alter table runtime_alerts
  add column if not exists acknowledged_at timestamptz,
  add column if not exists acknowledged_by uuid references users(id) on delete restrict;

create index if not exists runtime_alerts_tenant_acknowledged_idx
  on runtime_alerts (tenant_id, status, acknowledged_at, opened_at desc);
