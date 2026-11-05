-- Reported: DELETE skips the UPDATE-only check and reaches RETURN NEW (line 8).
create function lock_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'UPDATE' and old.locked then
    raise exception 'locked rows are immutable';
  end if;
  -- DELETE also arrives here
  return new;
end;
$$;
create trigger fixture_lock_guard before update or delete on fixture_rows for each row execute function lock_guard();

-- Reported: the lower-case branch never matches, so DELETE reaches RETURN NEW (the C2 failure mode, line 19).
create function lower_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'delete' then
    raise exception 'rows cannot be deleted';
  end if;
  return new;
end;
$$;
create trigger fixture_lower_guard before delete on fixture_rows for each row execute function lower_guard();

-- Not reported: DELETE raises before RETURN NEW.
create function delete_guard() returns trigger language plpgsql as $$
begin
  if TG_OP <> 'INSERT' then
    raise exception 'rows are append-only';
  end if;
  return new;
end;
$$;
create trigger fixture_delete_guard before insert or update or delete on fixture_rows for each row execute function delete_guard();

-- Not reported: RETURN NEW only in a branch that DELETE does not take.
create function branch_guard() returns trigger language plpgsql as $$
begin
  if TG_OP in ('INSERT', 'UPDATE') and new.id is not null then
    return new;
  end if;
  return old;
end;
$$;
create trigger fixture_branch_guard before insert or update or delete on fixture_rows for each row execute function branch_guard();

-- Not reported: AFTER and statement-level triggers ignore the returned row.
create function after_touch() returns trigger language plpgsql as $$
begin
  return new;
end;
$$;
create trigger fixture_after_touch after delete on fixture_rows for each row execute function after_touch();
create trigger fixture_statement_touch before delete on fixture_rows for each statement execute function after_touch();

-- Not reported after 002: the trigger is dropped there.
create function dropped_guard() returns trigger language plpgsql as $$
begin
  return new;
end;
$$;
create trigger fixture_dropped_guard before delete on fixture_rows for each row execute function dropped_guard();

-- Not reported after 002: the function is replaced there by one that raises on DELETE.
create function replaced_guard() returns trigger language plpgsql as $$
begin
  return new;
end;
$$;
create trigger fixture_replaced_guard before delete on fixture_rows for each row execute function replaced_guard();
