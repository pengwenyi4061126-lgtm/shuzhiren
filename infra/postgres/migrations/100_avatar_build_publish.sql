alter table avatar_build_jobs
  add column publish_status text not null default 'not_approved'
    check (publish_status in ('not_approved', 'queued', 'publishing', 'published', 'failed')),
  add column runtime_avatar_id text
    check (runtime_avatar_id is null or runtime_avatar_id ~ '^sr_[0-9a-f]{32}$'),
  add column publish_attempts integer not null default 0 check (publish_attempts between 0 and 3),
  add column publish_error_code text
    check (publish_error_code is null or publish_error_code ~ '^[a-z][a-z0-9_]{0,63}$');

select migration_fix_update('avatar_build_jobs', 'job', 'publish_status = ''queued''', 'review_status = ''approved''', p_per_tenant => true);

alter table avatar_build_jobs
  add constraint avatar_build_jobs_publish_state_check check (
    (review_status <> 'approved' and publish_status = 'not_approved' and runtime_avatar_id is null and publish_error_code is null)
    or (review_status = 'approved' and publish_status in ('queued', 'publishing') and runtime_avatar_id is null and publish_error_code is null)
    or (review_status = 'approved' and publish_status = 'published' and runtime_avatar_id is not null and publish_error_code is null)
    or (review_status = 'approved' and publish_status = 'failed' and runtime_avatar_id is null and publish_error_code is not null)
  );

create function initialize_avatar_build_publish_state() returns trigger
language plpgsql
as $$
begin
  if old.review_status = 'pending' and new.review_status = 'approved' then
    new.publish_status := 'queued';
  elsif old.review_status = 'pending' and new.review_status = 'rejected' then
    new.publish_status := 'not_approved';
  end if;
  return new;
end;
$$;

create trigger avatar_build_jobs_publish_on_review
  before update of review_status on avatar_build_jobs
  for each row execute function initialize_avatar_build_publish_state();

create index avatar_build_jobs_publish_queue_idx
  on avatar_build_jobs (updated_at, created_at)
  where review_status = 'approved' and publish_status in ('queued', 'failed');
