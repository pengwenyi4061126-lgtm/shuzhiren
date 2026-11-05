-- M15: every foreign key between two tenant tables was a single-column reference, and PostgreSQL checks foreign
-- keys without row-level security, so a row could reference a row of another tenant whenever an application path
-- forgot its own tenant check.
--
-- For each such foreign key this migration adds a composite foreign key (tenant_id, <columns>) referencing
-- (tenant_id, <referenced columns>), plus the unique constraint on the referenced table that it needs. The
-- original single-column keys stay and keep their ON DELETE actions; the composite keys are NO ACTION, which is
-- checked at the end of each statement, after cascades and SET NULL actions ran. A NULL reference is not checked
-- (MATCH SIMPLE), as before. Changing the tenant_id of a referenced row is rejected by the composite key.
--
-- The candidates come from the catalog, so the set matches the schema this migration runs on. Adding a key
-- validates every existing row without row-level security; a cross-tenant reference already in the data makes
-- the migration fail with 23503 naming the table and constraint, and the whole migration is rolled back.
-- Foreign keys added by later migrations between tenant tables must use the composite form directly.

create or replace function tenant_reference_foreign_keys()
returns table (constraint_name name, child regclass, parent regclass, child_columns text[], parent_columns text[], tenant_scoped boolean)
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  select c.conname, c.conrelid::regclass, c.confrelid::regclass,
    array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum, n)
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum order by k.n),
    array(select a.attname::text from unnest(c.confkey) with ordinality k(attnum, n)
          join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum order by k.n),
    exists (select 1 from unnest(c.conkey, c.confkey) p(child_attnum, parent_attnum)
            join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = p.child_attnum
            join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = p.parent_attnum
            where ca.attname = 'tenant_id' and pa.attname = 'tenant_id')
  from pg_constraint c
  where c.contype = 'f' and c.connamespace = 'public'::regnamespace
    and c.confrelid not in ('public.tenants'::regclass, 'public.users'::regclass)
    and exists (select 1 from pg_attribute a where a.attrelid = c.conrelid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped)
    and exists (select 1 from pg_attribute a where a.attrelid = c.confrelid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped)
  order by c.conrelid::regclass::text, c.conname
$$;

do $$
declare
  candidate record;
  candidates jsonb;
  child regclass;
  parent regclass;
  child_columns text[];
  parent_columns text[];
  unique_columns text[];
  key_name text;
  fk_name text;
begin
  -- Materialize first: the loop below changes pg_constraint.
  select coalesce(jsonb_agg(jsonb_build_object('child', f.child::text, 'parent', f.parent::text, 'child_columns', to_jsonb(f.child_columns), 'parent_columns', to_jsonb(f.parent_columns))), '[]'::jsonb)
  into candidates
  from tenant_reference_foreign_keys() f
  where not f.tenant_scoped
    and not exists (
      -- Already covered by a composite key over the same columns plus tenant_id.
      select 1 from tenant_reference_foreign_keys() g
      where g.tenant_scoped and g.child = f.child and g.parent = f.parent
        and (select array_agg(x order by x) from unnest(g.child_columns) x) = (select array_agg(x order by x) from unnest(array['tenant_id'] || f.child_columns) x)
    );

  for candidate in select * from jsonb_array_elements(candidates) as item(value) loop
    child := (candidate.value ->> 'child')::regclass;
    parent := (candidate.value ->> 'parent')::regclass;
    child_columns := array(select jsonb_array_elements_text(candidate.value -> 'child_columns'));
    parent_columns := array(select jsonb_array_elements_text(candidate.value -> 'parent_columns'));

    if not (select attnotnull from pg_attribute where attrelid = child and attname = 'tenant_id')
      or not (select attnotnull from pg_attribute where attrelid = parent and attname = 'tenant_id') then
      raise exception 'tenant-consistent foreign key needs NOT NULL tenant_id on % and %', child, parent;
    end if;

    unique_columns := array['tenant_id'] || parent_columns;
    if not exists (
      select 1 from pg_index i
      where i.indrelid = parent and i.indisunique and i.indpred is null and i.indexprs is null
        and (select array_agg(a.attname::text order by a.attname::text) from unnest(i.indkey::int2[]) k(attnum) join pg_attribute a on a.attrelid = parent and a.attnum = k.attnum)
          = (select array_agg(x order by x) from unnest(unique_columns) x)
    ) then
      key_name := left(format('%s_tenant_%s_key', parent::text, array_to_string(parent_columns, '_')), 54) || '_' || left(md5(parent::text || array_to_string(parent_columns, ',')), 8);
      execute format('alter table %s add constraint %I unique (%s)', parent, key_name, (select string_agg(quote_ident(x), ', ') from unnest(unique_columns) x));
      raise notice 'added unique (%) on %', array_to_string(unique_columns, ', '), parent;
    end if;

    fk_name := left(format('%s_%s_tenant_fkey', child::text, array_to_string(child_columns, '_')), 54) || '_' || left(md5(child::text || array_to_string(child_columns, ',') || parent::text), 8);
    execute format('alter table %s add constraint %I foreign key (tenant_id, %s) references %s (tenant_id, %s)',
      child, fk_name,
      (select string_agg(quote_ident(x), ', ') from unnest(child_columns) x),
      parent,
      (select string_agg(quote_ident(x), ', ') from unnest(parent_columns) x));
    raise notice 'added foreign key % on % (tenant_id, %) -> % (tenant_id, %)', fk_name, child, array_to_string(child_columns, ', '), parent, array_to_string(parent_columns, ', ');
  end loop;
end;
$$;
