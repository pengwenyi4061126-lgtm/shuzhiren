alter table fixture_rows add column note text;
update fixture_rows set note = 'migrated' where note is null;
delete from fixture_rows where flag is false;
insert into fixture_audit (id) select id from fixture_rows;
insert into fixture_audit (id) values (1);
