create type program_segment_kind as enum ('prepared_product', 'interactive', 'fallback', 'human_handoff');

create table show_revision_segments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  show_revision_id uuid not null references show_revisions(id) on delete restrict,
  position integer not null check (position > 0),
  kind program_segment_kind not null,
  title text not null,
  purpose text not null,
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  product_version_id uuid references product_versions(id) on delete restrict,
  is_fallback boolean not null default false,
  created_at timestamptz not null default now(),
  unique (show_revision_id, position)
);

create index show_revision_segments_tenant_revision_idx
  on show_revision_segments (tenant_id, show_revision_id, position);

alter table show_revision_segments enable row level security;

create policy tenant_isolation_show_revision_segments
  on show_revision_segments
  using (tenant_id::text = current_setting('app.tenant_id', true));
