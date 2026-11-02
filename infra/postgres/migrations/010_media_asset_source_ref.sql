alter table media_assets
  add column if not exists source_ref text not null default '未注明来源';
