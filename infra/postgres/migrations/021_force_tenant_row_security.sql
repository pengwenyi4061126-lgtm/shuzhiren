-- Table owners normally bypass PostgreSQL RLS. The application role must remain
-- tenant-scoped even if deployment provisions it as the owner of these tables.
alter table products force row level security;
alter table product_versions force row level security;
alter table shows force row level security;
alter table show_revisions force row level security;
alter table live_runs force row level security;
alter table live_commands force row level security;
alter table preflight_checks force row level security;
alter table show_revision_product_versions force row level security;
alter table audit_events force row level security;
alter table outbox_events force row level security;
alter table show_revision_segments force row level security;
alter table media_assets force row level security;
alter table channel_connections force row level security;
alter table runtime_health_samples force row level security;
alter table runtime_alerts force row level security;
alter table live_interactions force row level security;
alter table model_releases force row level security;
alter table show_revision_model_releases force row level security;
