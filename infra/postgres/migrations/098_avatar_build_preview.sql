alter table avatar_build_jobs
  add column preview_jpeg bytea;

alter table avatar_build_jobs
  add constraint avatar_build_jobs_preview_state_check check (
    (status = 'preview_ready' and preview_jpeg is not null
      and octet_length(preview_jpeg) between 4 and 2097152
      and substring(preview_jpeg from 1 for 3) = decode('ffd8ff', 'hex'))
    or (status <> 'preview_ready' and preview_jpeg is null)
  );
