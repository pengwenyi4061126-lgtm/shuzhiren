create or replace function twice_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'delete' then raise exception 'first definition'; end if;
  return new;
end;
$$;
-- A second definition in the same file does not replace the first one (Requirement 10.3).
create or replace function twice_guard()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'DELETE' then raise exception 'second definition'; end if;
  return new;
end;
$$;
