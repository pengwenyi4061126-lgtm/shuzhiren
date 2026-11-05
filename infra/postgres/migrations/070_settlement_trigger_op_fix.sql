-- Audit C2: 062 compared TG_OP with lower-case literals. TG_OP is always upper
-- case, so govern_settlement_batch() and govern_settlement_exception() never
-- entered their DELETE or UPDATE branches: updates were unrestricted and the
-- functions returned NEW, which is NULL on DELETE, so a BEFORE row trigger
-- silently skipped the row (0 rows deleted, no error). govern_settlement_line()
-- happened to behave correctly but used the same lower-case comparison.
-- This replaces only the three function bodies; the existing triggers reference
-- the functions and pick up the new bodies immediately. 062 stays unchanged.
-- Unexpected operations raise instead of falling through (fail closed).
create or replace function govern_settlement_batch()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'settlement batches are immutable';
  end if;
  if TG_OP <> 'UPDATE' then
    raise exception 'govern_settlement_batch does not handle %', TG_OP;
  end if;
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
    or new.channel_connection_id is distinct from old.channel_connection_id
    or new.provider_statement_ref is distinct from old.provider_statement_ref
    or new.period_start is distinct from old.period_start or new.period_end is distinct from old.period_end
    or new.statement_generated_at is distinct from old.statement_generated_at or new.currency is distinct from old.currency
    or new.source_sha256 is distinct from old.source_sha256 or new.evidence_ref is distinct from old.evidence_ref
    or new.imported_by is distinct from old.imported_by or new.imported_at is distinct from old.imported_at
    or new.created_at is distinct from old.created_at then
    raise exception 'settlement batch source evidence is immutable';
  end if;
  if not ((old.status = 'imported' and new.status in ('review_required', 'reconciled'))
          or (old.status = 'review_required' and new.status = 'reconciled')) then
    raise exception 'settlement batch status transition is not permitted';
  end if;
  return new;
end;
$$;

create or replace function govern_settlement_line()
returns trigger language plpgsql as $$
begin
  if TG_OP <> 'INSERT' then raise exception 'settlement lines are immutable'; end if;
  return new;
end;
$$;

create or replace function govern_settlement_exception()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'settlement exceptions are immutable';
  end if;
  if TG_OP <> 'UPDATE' then
    raise exception 'govern_settlement_exception does not handle %', TG_OP;
  end if;
  if old.status <> 'open' then
    raise exception 'resolved settlement exceptions are immutable';
  end if;
  if new.status <> 'resolved' then
    raise exception 'settlement exception may only transition from open to resolved';
  end if;
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
    or new.settlement_batch_id is distinct from old.settlement_batch_id
    or new.settlement_line_id is distinct from old.settlement_line_id or new.live_run_id is distinct from old.live_run_id
    or new.order_reference is distinct from old.order_reference or new.exception_type is distinct from old.exception_type
    or new.expected_amount_cents is distinct from old.expected_amount_cents
    or new.actual_amount_cents is distinct from old.actual_amount_cents
    or new.detail is distinct from old.detail or new.created_at is distinct from old.created_at then
    raise exception 'settlement exception facts are immutable';
  end if;
  if not exists (select 1 from memberships where tenant_id = new.tenant_id and user_id = new.resolved_by and status = 'active') then
    raise exception 'settlement exception resolver must be an active tenant member';
  end if;
  -- resolved_at, resolution length, and evidence format are enforced by the
  -- table-level CHECK constraints in 062.
  return new;
end;
$$;
