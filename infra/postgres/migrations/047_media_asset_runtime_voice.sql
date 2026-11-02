alter table media_assets
  add column if not exists runtime_voice_id text;

alter table media_assets
  add constraint media_assets_runtime_voice_id_safe
  check (runtime_voice_id is null or runtime_voice_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$');
