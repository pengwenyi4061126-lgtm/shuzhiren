-- Replaces 9_old.sql: "public." prefix and mixed case still name the same function.
create or replace function public.Enforce_X()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'x rows cannot be deleted';
  end if;
  return new;
end;
$$;
