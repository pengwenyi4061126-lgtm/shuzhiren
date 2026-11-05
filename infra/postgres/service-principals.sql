-- Run this file as the control-plane schema owner after migrations and after
-- the deployment secret manager has created the three LOGIN roles. Passwords
-- and connection strings deliberately do not belong in this repository.
do $$
declare
  principal text;
begin
  foreach principal in array array[
    'shuzhiren_runtime_worker',
    'shuzhiren_channel_adapter',
    'shuzhiren_alert_notifier'
  ] loop
    if not exists (select 1 from pg_roles where rolname = principal) then
      raise exception 'service role % is missing; create it as a LOGIN NOINHERIT role before applying service-principals.sql', principal;
    end if;
  end loop;
end;
$$;

revoke all privileges on all tables in schema public from shuzhiren_runtime_worker, shuzhiren_channel_adapter, shuzhiren_alert_notifier;
revoke all privileges on all sequences in schema public from shuzhiren_runtime_worker, shuzhiren_channel_adapter, shuzhiren_alert_notifier;

grant usage on schema public to shuzhiren_runtime_worker, shuzhiren_channel_adapter, shuzhiren_alert_notifier;

-- Channel webhook replay protection: no live-run, product, member, or audit access.
grant select, insert, update on channel_webhook_replays to shuzhiren_channel_adapter;

-- Alert delivery: read open alerts and claim/update its own durable deliveries.
grant select on runtime_alerts to shuzhiren_alert_notifier;
grant select, insert, update on alert_notification_deliveries to shuzhiren_alert_notifier;

-- Runtime worker: durable command delivery, scheduled starts, telemetry
-- watchdog, entitlement accounting, channel-reply receipts, and audit events.
grant select, update on outbox_events to shuzhiren_runtime_worker;
-- scheduleDueRun and degradeStaleLiveRun enqueue media.dispatch events.
grant insert on outbox_events to shuzhiren_runtime_worker;
grant select, update on live_runs to shuzhiren_runtime_worker;
-- The live_runs program-cursor trigger verifies referenced frozen segments.
-- The worker needs this read-only access for receipt-bound cursor updates.
grant select on show_revision_segments to shuzhiren_runtime_worker;
grant select on tenant_entitlements, runtime_health_samples to shuzhiren_runtime_worker;
grant select (id) on tenants to shuzhiren_runtime_worker;
grant select, insert on usage_records to shuzhiren_runtime_worker;
grant select, insert, update on runtime_alerts to shuzhiren_runtime_worker;
grant select, update on channel_reply_drafts to shuzhiren_runtime_worker;
grant update on live_interactions to shuzhiren_runtime_worker;
-- markDelivered closes the source interaction with "where id = $1 and status = 'queued'".
-- PostgreSQL requires SELECT on columns read by WHERE; grant only those columns (Requirement 12.5).
grant select (id, status) on live_interactions to shuzhiren_runtime_worker;
-- The sealing trigger (migration 074) maintains audit_chain_heads as its owner; no service role may write
-- chain heads directly.
grant insert on audit_events to shuzhiren_runtime_worker;
grant execute on function runtime_worker_actor(uuid, text) to shuzhiren_runtime_worker;
