create or replace function all_forms()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'delete' then raise exception 'equals'; end if;
  if 'update' = TG_OP then raise exception 'literal on the left'; end if;
  if TG_OP <> 'insert' then raise exception 'not equal'; end if;
  if TG_OP != 'Insert' then raise exception 'mixed case'; end if;
  if TG_OP::text = 'delete'::text then raise exception 'casts'; end if;
  if TG_OP in ('INSERT', 'update') then raise exception 'in list'; end if;
  if TG_OP not in ('delete') then raise exception 'not in list'; end if;
  if TG_OP
     =
     'truncate' then raise exception 'three lines'; end if;
  perform case when tg_op = 'delete' then 1 else 0 end;
  if TG_OP = 'DELETE' then raise exception 'upper case'; end if;
  if TG_OP IN ('INSERT', 'UPDATE') then null; end if;
  perform case TG_OP when 'delete' then 1 else 0 end;
  return new;
end;
$$;
create or replace function not_a_trigger()
returns void
language plpgsql
as $$
begin
  if tg_op = 'delete' then null; end if;
end;
$$;
