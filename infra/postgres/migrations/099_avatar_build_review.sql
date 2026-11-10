alter table avatar_build_jobs
  add column review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected')),
  add column reviewed_by text,
  add column reviewed_at timestamptz,
  add column review_note text;

alter table avatar_build_jobs
  add constraint avatar_build_jobs_review_state_check check (
    (review_status = 'pending' and reviewed_by is null and reviewed_at is null and review_note is null)
    or (review_status in ('approved', 'rejected') and status = 'preview_ready'
      and reviewed_by is not null and char_length(btrim(reviewed_by)) between 1 and 200 and reviewed_at is not null
      and (review_note is null or char_length(review_note) between 1 and 1000))
  );

create function protect_avatar_build_review_decision() returns trigger
language plpgsql
as $$
begin
  if old.review_status <> 'pending'
    and (new.review_status, new.reviewed_by, new.reviewed_at, new.review_note)
      is distinct from (old.review_status, old.reviewed_by, old.reviewed_at, old.review_note) then
    raise exception 'Avatar build review decisions are immutable';
  end if;
  return new;
end;
$$;

create trigger avatar_build_jobs_review_immutable
  before update on avatar_build_jobs
  for each row execute function protect_avatar_build_review_decision();
