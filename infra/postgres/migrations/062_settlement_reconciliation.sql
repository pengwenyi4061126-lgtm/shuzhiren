create type settlement_batch_status as enum ('imported', 'review_required', 'reconciled');
create type settlement_line_type as enum ('gross_sale', 'refund', 'platform_fee', 'adjustment', 'payout');
create type settlement_exception_type as enum ('missing_operational_event', 'missing_settlement_line', 'gross_amount_mismatch', 'refund_amount_mismatch', 'unattributable_statement_line', 'statement_net_mismatch');
create type settlement_exception_status as enum ('open', 'resolved');

create table settlement_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  channel_connection_id uuid not null references channel_connections(id) on delete restrict,
  provider_statement_ref text not null check (length(provider_statement_ref) between 1 and 200),
  period_start timestamptz not null,
  period_end timestamptz not null,
  statement_generated_at timestamptz,
  currency char(3) not null default 'CNY' check (currency = 'CNY'),
  source_sha256 char(64) not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_ref text not null check (evidence_ref ~ '^evidence://[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$' or evidence_ref ~ '^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$'),
  imported_by uuid not null references users(id) on delete restrict,
  imported_at timestamptz not null default now(),
  status settlement_batch_status not null default 'imported',
  created_at timestamptz not null default now(),
  check (period_end > period_start),
  unique (tenant_id, channel_connection_id, provider_statement_ref)
);

create table settlement_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  settlement_batch_id uuid not null references settlement_batches(id) on delete restrict,
  external_line_id text not null check (length(external_line_id) between 1 and 200),
  line_type settlement_line_type not null,
  external_order_reference text check (external_order_reference is null or external_order_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  occurred_at timestamptz not null,
  amount_cents bigint not null check (amount_cents between -1000000000000 and 1000000000000 and amount_cents <> 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, settlement_batch_id, external_line_id),
  check ((line_type = 'gross_sale' and amount_cents > 0) or (line_type in ('refund', 'platform_fee') and amount_cents < 0) or (line_type in ('adjustment', 'payout') and amount_cents <> 0))
);

create table settlement_reconciliation_exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  settlement_batch_id uuid not null references settlement_batches(id) on delete restrict,
  settlement_line_id uuid references settlement_lines(id) on delete restrict,
  live_run_id uuid references live_runs(id) on delete restrict,
  order_reference text check (order_reference is null or order_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  exception_type settlement_exception_type not null,
  expected_amount_cents bigint,
  actual_amount_cents bigint,
  detail text not null check (length(detail) between 1 and 1000),
  status settlement_exception_status not null default 'open',
  resolved_by uuid references users(id) on delete restrict,
  resolved_at timestamptz,
  resolution text check (resolution is null or length(resolution) between 10 and 2000),
  resolution_evidence_ref text check (resolution_evidence_ref is null or resolution_evidence_ref ~ '^evidence://[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$' or resolution_evidence_ref ~ '^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$'),
  created_at timestamptz not null default now(),
  check ((status = 'open' and resolved_by is null and resolved_at is null and resolution is null and resolution_evidence_ref is null) or (status = 'resolved' and resolved_by is not null and resolved_at is not null and resolution is not null and resolution_evidence_ref is not null))
);

create index settlement_batches_tenant_imported_idx on settlement_batches (tenant_id, imported_at desc);
create index settlement_lines_batch_type_idx on settlement_lines (tenant_id, settlement_batch_id, line_type);
create index settlement_exceptions_batch_status_idx on settlement_reconciliation_exceptions (tenant_id, settlement_batch_id, status, created_at desc);

alter table settlement_batches enable row level security;
alter table settlement_batches force row level security;
create policy tenant_isolation_settlement_batches on settlement_batches using (tenant_id::text = current_setting('app.tenant_id', true)) with check (tenant_id::text = current_setting('app.tenant_id', true));
alter table settlement_lines enable row level security;
alter table settlement_lines force row level security;
create policy tenant_isolation_settlement_lines on settlement_lines using (tenant_id::text = current_setting('app.tenant_id', true)) with check (tenant_id::text = current_setting('app.tenant_id', true));
alter table settlement_reconciliation_exceptions enable row level security;
alter table settlement_reconciliation_exceptions force row level security;
create policy tenant_isolation_settlement_reconciliation_exceptions on settlement_reconciliation_exceptions using (tenant_id::text = current_setting('app.tenant_id', true)) with check (tenant_id::text = current_setting('app.tenant_id', true));

create or replace function validate_settlement_tenant_links()
returns trigger language plpgsql as $$
begin
  if tg_table_name = 'settlement_lines' and not exists (select 1 from settlement_batches where id = new.settlement_batch_id and tenant_id = new.tenant_id) then
    raise exception 'settlement line must belong to a batch in the same tenant';
  end if;
  if tg_table_name = 'settlement_reconciliation_exceptions' then
    if not exists (select 1 from settlement_batches where id = new.settlement_batch_id and tenant_id = new.tenant_id) then
      raise exception 'settlement exception must belong to a batch in the same tenant';
    end if;
    if new.settlement_line_id is not null and not exists (select 1 from settlement_lines where id = new.settlement_line_id and settlement_batch_id = new.settlement_batch_id and tenant_id = new.tenant_id) then
      raise exception 'settlement exception line must belong to its batch';
    end if;
    if new.live_run_id is not null and not exists (select 1 from live_runs where id = new.live_run_id and tenant_id = new.tenant_id) then
      raise exception 'settlement exception live run must belong to its tenant';
    end if;
  end if;
  return new;
end;
$$;

create trigger settlement_lines_validate_tenant_link before insert or update on settlement_lines for each row execute function validate_settlement_tenant_links();
create trigger settlement_exceptions_validate_tenant_link before insert or update on settlement_reconciliation_exceptions for each row execute function validate_settlement_tenant_links();

create or replace function govern_settlement_batch()
returns trigger language plpgsql as $$
begin
  if tg_op = 'delete' then raise exception 'settlement batches are immutable'; end if;
  if tg_op = 'update' then
    if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id or new.channel_connection_id is distinct from old.channel_connection_id or new.provider_statement_ref is distinct from old.provider_statement_ref or new.period_start is distinct from old.period_start or new.period_end is distinct from old.period_end or new.statement_generated_at is distinct from old.statement_generated_at or new.currency is distinct from old.currency or new.source_sha256 is distinct from old.source_sha256 or new.evidence_ref is distinct from old.evidence_ref or new.imported_by is distinct from old.imported_by or new.imported_at is distinct from old.imported_at or new.created_at is distinct from old.created_at then
      raise exception 'settlement batch source evidence is immutable';
    end if;
    if (old.status = 'imported' and new.status not in ('review_required', 'reconciled')) or (old.status = 'review_required' and new.status <> 'reconciled') or old.status = 'reconciled' then
      raise exception 'settlement batch status transition is not permitted';
    end if;
  end if;
  return new;
end;
$$;
create trigger settlement_batches_governed_mutation before update or delete on settlement_batches for each row execute function govern_settlement_batch();

create or replace function govern_settlement_line()
returns trigger language plpgsql as $$
begin
  if tg_op <> 'insert' then raise exception 'settlement lines are immutable'; end if;
  return new;
end;
$$;
create trigger settlement_lines_governed_mutation before update or delete on settlement_lines for each row execute function govern_settlement_line();

create or replace function govern_settlement_exception()
returns trigger language plpgsql as $$
begin
  if tg_op = 'delete' then raise exception 'settlement exceptions are immutable'; end if;
  if tg_op = 'update' then
    if old.status <> 'open' or new.status <> 'resolved' or new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id or new.settlement_batch_id is distinct from old.settlement_batch_id or new.settlement_line_id is distinct from old.settlement_line_id or new.live_run_id is distinct from old.live_run_id or new.order_reference is distinct from old.order_reference or new.exception_type is distinct from old.exception_type or new.expected_amount_cents is distinct from old.expected_amount_cents or new.actual_amount_cents is distinct from old.actual_amount_cents or new.detail is distinct from old.detail or new.created_at is distinct from old.created_at then
      raise exception 'settlement exception may only be resolved once';
    end if;
    if not exists (select 1 from memberships where tenant_id = new.tenant_id and user_id = new.resolved_by and status = 'active') then
      raise exception 'settlement exception resolver must be an active tenant member';
    end if;
  end if;
  return new;
end;
$$;
create trigger settlement_exceptions_governed_mutation before update or delete on settlement_reconciliation_exceptions for each row execute function govern_settlement_exception();
