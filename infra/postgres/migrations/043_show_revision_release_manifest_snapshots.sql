create table show_revision_release_manifest_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  show_revision_id uuid not null references show_revisions(id) on delete restrict,
  manifest jsonb not null,
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique (show_revision_id)
);

create index show_revision_release_manifest_snapshots_tenant_revision_idx
  on show_revision_release_manifest_snapshots (tenant_id, show_revision_id);

alter table show_revision_release_manifest_snapshots enable row level security;
alter table show_revision_release_manifest_snapshots force row level security;
create policy tenant_isolation_show_revision_release_manifest_snapshots
  on show_revision_release_manifest_snapshots
  using (tenant_id::text = current_setting('app.tenant_id', true));

create function reject_show_revision_release_manifest_snapshot_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Show revision release manifest snapshots are append-only';
end;
$$;

create trigger show_revision_release_manifest_snapshots_append_only
before update or delete on show_revision_release_manifest_snapshots
for each row execute function reject_show_revision_release_manifest_snapshot_mutation();
