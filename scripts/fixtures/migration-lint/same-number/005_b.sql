-- The same number as 005_a.sql, so neither file replaces the other.
create or replace function same_number_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'update' then raise exception 'file b'; end if;
  return new;
end;
$$;
