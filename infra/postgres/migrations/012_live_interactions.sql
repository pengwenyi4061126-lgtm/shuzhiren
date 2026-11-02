create type interaction_status as enum ('queued', 'handled');

create table live_interactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  live_run_id uuid not null references live_runs(id) on delete restrict,
  source text not null default 'viewer',
  question_text text not null,
  risk_level text not null check (risk_level in ('low', 'medium', 'high')),
  policy_action text not null check (policy_action in ('answer', 'handoff', 'refuse')),
  policy_reasons jsonb not null default '[]'::jsonb,
  required_evidence jsonb not null default '[]'::jsonb,
  evidence_ids jsonb not null default '[]'::jsonb,
  status interaction_status not null default 'queued',
  handled_by uuid references users(id) on delete set null,
  handled_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now()
);

create index live_interactions_run_status_created_idx on live_interactions (tenant_id, live_run_id, status, created_at desc);

alter table live_interactions enable row level security;
create policy tenant_isolation_live_interactions on live_interactions using (tenant_id::text = current_setting('app.tenant_id', true));
