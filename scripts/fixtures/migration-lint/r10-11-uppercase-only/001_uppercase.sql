create or replace function guard_fixture()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'fixture rows cannot be deleted';
  end if;
  if tg_op <> 'INSERT' and old.id is distinct from new.id then
    raise exception 'fixture ids are immutable';
  end if;
  if TG_OP IN ('INSERT','UPDATE') and 'DELETE' = TG_OP then
    raise exception 'unreachable';
  end if;
  return new;
end;
$$;
