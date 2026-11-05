-- Control-plane database principal (D4, 2026-11-05). Tables, sequences and functions are owned by the
-- migration owner shuzhiren_migration_owner; the control plane connects as a separate LOGIN role that owns
-- nothing and has no SUPERUSER or BYPASSRLS, so FORCE ROW LEVEL SECURITY applies to every query it runs.
--
-- Run this file as the migration owner after every successful migration, together with service-principals.sql
-- and backup-principal.sql:
--   psql "$MIGRATION_OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
--     -v control_plane_role=shuzhiren_control_plane -f infra/postgres/control-plane-principal.sql
-- The DBA creates the role first (LOGIN NOINHERIT, no other attributes). The only psql variable is
-- control_plane_role; psql does not substitute variables inside dollar quotes, so it is never used in a DO block.
--
-- The file starts by revoking everything the role holds on public tables and sequences (column grants go with
-- the table grants), so each run leaves exactly the privileges below and the file can be run again.
revoke all privileges on all tables in schema public from :"control_plane_role";
revoke all privileges on all sequences in schema public from :"control_plane_role";
grant usage on schema public to :"control_plane_role";
-- Every business table, including channel_connections, settlement_batches, settlement_lines and
-- settlement_reconciliation_exceptions. Row-level security and the governance triggers still decide which rows
-- and which changes are allowed.
grant select, insert, update, delete on all tables in schema public to :"control_plane_role";
-- The Migrator alone records migrations; the control plane may read the ledger (readiness and db:verify).
revoke insert, update, delete on schema_migrations from :"control_plane_role";
-- Since 074, seal_audit_event() (SECURITY DEFINER) maintains audit_chain_heads as its owner and a guard
-- trigger rejects direct writes; the control plane only reads chain heads through verify_audit_chain().
revoke insert, update, delete on audit_chain_heads from :"control_plane_role";
-- Since 076, protect_last_active_tenant_admin() (SECURITY DEFINER) writes membership_admin_guards; callers need
-- no privilege on it.
revoke all privileges on membership_admin_guards from :"control_plane_role";
grant usage, select on all sequences in schema public to :"control_plane_role";
-- Tables and sequences that later migrations create as this owner get the same access. A later migration that
-- adds a table the control plane must not write revokes that privilege here as well.
alter default privileges in schema public grant select, insert, update, delete on tables to :"control_plane_role";
alter default privileges in schema public grant usage, select on sequences to :"control_plane_role";
-- Since 082, runtime_presets is a platform-wide preset catalogue that only migrations change; the control plane
-- reads it (GET /api/v1/presets) and adopts a preset by writing the tenant's own media_assets.
revoke insert, update, delete on runtime_presets from :"control_plane_role";
