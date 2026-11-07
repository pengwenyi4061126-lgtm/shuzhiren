create table show_revision_overlays (
  tenant_id uuid not null references tenants(id) on delete restrict,
  show_revision_id uuid not null,
  caption_enabled boolean not null default false,
  caption_position text not null default 'bottom_band' check (caption_position in ('bottom_band', 'top_band')),
  product_card_enabled boolean not null default false,
  product_card_anchor text not null default 'middle-right' check (product_card_anchor in ('top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right')),
  price_sticker_enabled boolean not null default false,
  background_mode text not null default 'none' check (background_mode in ('none', 'canvas', 'chroma_key')),
  background_media_asset_id uuid,
  background_options jsonb not null default '{}'::jsonb check (jsonb_typeof(background_options) = 'object'),
  scene_json text check (scene_json is null or char_length(scene_json) between 2 and 8192),
  scene_sha256 char(64) check (scene_sha256 is null or scene_sha256 ~ '^[0-9a-f]{64}$'),
  frozen_at timestamptz,
  updated_by uuid not null references users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, show_revision_id),
  foreign key (tenant_id, show_revision_id) references show_revisions (tenant_id, id),
  foreign key (tenant_id, background_media_asset_id) references media_assets (tenant_id, id),
  check (not price_sticker_enabled or product_card_enabled),
  check ((background_mode = 'none') = (background_media_asset_id is null)),
  check ((scene_json is null) = (scene_sha256 is null) and (scene_sha256 is null) = (frozen_at is null)),
  check (scene_sha256 is null or scene_sha256 = encode(sha256(convert_to(scene_json, 'UTF8')), 'hex'))
);

alter table show_revision_overlays enable row level security;
alter table show_revision_overlays force row level security;
create policy tenant_isolation_show_revision_overlays on show_revision_overlays
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));

create or replace function reject_show_revision_overlay_mutation()
returns trigger
language plpgsql
as $$
declare
  revision_id uuid;
begin
  if tg_op = 'UPDATE' and new.show_revision_id is distinct from old.show_revision_id then
    raise exception 'Show revision overlays cannot move between revisions';
  end if;
  revision_id := case when tg_op = 'DELETE' then old.show_revision_id else new.show_revision_id end;

  if tg_op = 'UPDATE' and old.scene_sha256 is not null then
    raise exception 'Frozen show revision overlays are immutable';
  end if;

  if tg_op = 'UPDATE' and old.scene_sha256 is null and new.scene_sha256 is not null
    and new.tenant_id is not distinct from old.tenant_id
    and new.show_revision_id is not distinct from old.show_revision_id
    and new.caption_enabled is not distinct from old.caption_enabled
    and new.caption_position is not distinct from old.caption_position
    and new.product_card_enabled is not distinct from old.product_card_enabled
    and new.product_card_anchor is not distinct from old.product_card_anchor
    and new.price_sticker_enabled is not distinct from old.price_sticker_enabled
    and new.background_mode is not distinct from old.background_mode
    and new.background_media_asset_id is not distinct from old.background_media_asset_id
    and new.background_options is not distinct from old.background_options
    and new.updated_by is not distinct from old.updated_by
    and new.updated_at is not distinct from old.updated_at
    and new.scene_json is not null and new.frozen_at is not null
    and exists (select 1 from show_revisions where id = revision_id and approval_status = 'draft') then
    return new;
  end if;

  if exists (select 1 from live_runs where show_revision_id = revision_id and state = 'DRAFT') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if exists (select 1 from show_program_change_requests where candidate_revision_id = revision_id and status = 'draft') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT'
    and not exists (select 1 from live_runs where show_revision_id = revision_id)
    and not exists (select 1 from show_program_change_requests where candidate_revision_id = revision_id)
    and exists (select 1 from show_revisions where id = revision_id and approval_status = 'draft') then
    return new;
  end if;
  raise exception 'Show revision overlays are editable only in an attached DRAFT run or draft revision request';
end;
$$;

create trigger show_revision_overlays_governed
before insert or update or delete on show_revision_overlays
for each row execute function reject_show_revision_overlay_mutation();

create or replace function require_frozen_overlay_for_program_approval()
returns trigger
language plpgsql
as $$
begin
  if new.approval_status = 'approved' and old.approval_status is distinct from 'approved'
    and exists (
      select 1 from show_revision_overlays
      where tenant_id = new.tenant_id and show_revision_id = new.id
        and (caption_enabled or product_card_enabled or price_sticker_enabled or background_mode <> 'none')
        and scene_sha256 is null
    ) then
    raise exception 'Approved show revisions with enabled overlays require a frozen scene';
  end if;
  return new;
end;
$$;

create trigger show_revisions_require_frozen_overlay
before update of approval_status on show_revisions
for each row execute function require_frozen_overlay_for_program_approval();
