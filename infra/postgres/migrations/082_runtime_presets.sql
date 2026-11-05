-- P0 default presets: a platform-wide (not tenant) catalogue of default digital-human avatars and voices that a
-- tenant can adopt into its own media_assets. The catalogue only names runtime references and license facts; it
-- ships no audio or video. Adopting a preset creates a pending media asset in the tenant's library, which then goes
-- through the normal content verification and approval (058, 075); nothing here bypasses that.
--
-- The table has no tenant_id, so tenant row-level security does not apply (db:verify checks RLS on tenant tables
-- only). Every tenant may read every enabled preset. control-plane-principal.sql keeps the control plane read-only
-- on this table; rows change only through migrations run by the migration owner.
--
-- runtime_ref is ASCII ([A-Za-z0-9][A-Za-z0-9_-]{0,127}, the media_assets.runtime_voice_id and LiveTalking
-- avatar_id alphabet). For a voice it becomes the adopted asset's runtime_voice_id: with COSYVOICE_MODEL_KIND=sft
-- the Runtime Gateway maps it to sft_speaker_id (COSYVOICE_SFT_SPEAKER_MAP), with zero_shot it names the voice
-- library directory <runtime_ref>/prompt.wav + prompt.txt that the operator provides. For an avatar it is the
-- LIVETALKING_AVATAR_ID whose avatar data the operator provides.
--
-- commercial_use_status defaults to unverified. The seeds below are unverified: the repository holds no license
-- text for the CosyVoice-300M-SFT weights or their built-in speakers, and vendor/CosyVoice/asset audio is covered by
-- the upstream README disclaimer (academic purposes only), so none of it is used or claimed here.
create table runtime_presets (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  preset_code text not null,
  display_name text not null,
  gender text,
  voice_style text,
  compatible_model_kind text not null,
  runtime_ref text not null,
  sft_speaker_id text,
  material_requirements text not null,
  license_name text not null,
  license_source_url text,
  commercial_use_status text not null default 'unverified',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  constraint runtime_presets_preset_code_key unique (preset_code),
  constraint runtime_presets_kind_check check (kind in ('avatar', 'voice')),
  constraint runtime_presets_preset_code_format check (preset_code ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  constraint runtime_presets_display_name_check check (char_length(btrim(display_name)) between 1 and 100),
  constraint runtime_presets_gender_check check (gender is null or gender in ('female', 'male', 'neutral')),
  constraint runtime_presets_voice_style_check check (voice_style is null or char_length(btrim(voice_style)) between 1 and 100),
  constraint runtime_presets_compatible_model_kind_check check (compatible_model_kind in ('sft', 'zero_shot', 'any')),
  constraint runtime_presets_runtime_ref_format check (runtime_ref ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  -- A built-in CosyVoice speaker name (for example 中文女): 1-64 characters, no control characters and no
  -- surrounding whitespace. Only a voice usable in sft mode has one; without it the Gateway uses runtime_ref as is.
  constraint runtime_presets_sft_speaker_check check (
    sft_speaker_id is null
    or (kind = 'voice' and compatible_model_kind in ('sft', 'any')
      and char_length(sft_speaker_id) between 1 and 64 and sft_speaker_id = btrim(sft_speaker_id) and sft_speaker_id !~ '[[:cntrl:]]')
  ),
  constraint runtime_presets_avatar_model_kind_check check (kind = 'voice' or compatible_model_kind = 'any'),
  constraint runtime_presets_material_requirements_check check (char_length(btrim(material_requirements)) between 1 and 1000),
  constraint runtime_presets_license_name_check check (char_length(btrim(license_name)) between 1 and 200),
  constraint runtime_presets_license_source_url_check check (license_source_url is null or (license_source_url ~ '^https://[^[:space:]]+$' and char_length(license_source_url) <= 500)),
  constraint runtime_presets_commercial_use_status_check check (commercial_use_status in ('verified', 'unverified')),
  -- verified must name where the license was checked.
  constraint runtime_presets_verified_source_check check (commercial_use_status = 'unverified' or license_source_url is not null)
);

create index runtime_presets_enabled_kind_idx on runtime_presets (kind, preset_code) where enabled;

insert into runtime_presets (kind, preset_code, display_name, gender, voice_style, compatible_model_kind, runtime_ref, sft_speaker_id, material_requirements, license_name, license_source_url, commercial_use_status) values
  ('voice', 'preset-zh-female', '默认女声（中文）', 'female', '普通话 · 标准女声', 'any', 'preset-zh-female', '中文女',
   'sft：加载自带“中文女”说话人的 CosyVoice-300M-SFT 权重，Gateway 按 COSYVOICE_SFT_SPEAKER_MAP 映射；zero_shot（模板默认 Fun-CosyVoice3）：运营方在声音库放入已授权的 preset-zh-female/prompt.wav 与含 <|endofprompt|> 的 prompt.txt。两种模式都需把同一份已授权音频上传到本租户对象存储，供内容校验与审批。',
   'CosyVoice-300M-SFT 权重与内置说话人许可（未核实）', 'https://www.modelscope.cn/models/iic/CosyVoice-300M-SFT', 'unverified'),
  ('voice', 'preset-zh-male', '默认男声（中文）', 'male', '普通话 · 标准男声', 'any', 'preset-zh-male', '中文男',
   'sft：加载自带“中文男”说话人的 CosyVoice-300M-SFT 权重，Gateway 按 COSYVOICE_SFT_SPEAKER_MAP 映射；zero_shot（模板默认 Fun-CosyVoice3）：运营方在声音库放入已授权的 preset-zh-male/prompt.wav 与含 <|endofprompt|> 的 prompt.txt。两种模式都需把同一份已授权音频上传到本租户对象存储，供内容校验与审批。',
   'CosyVoice-300M-SFT 权重与内置说话人许可（未核实）', 'https://www.modelscope.cn/models/iic/CosyVoice-300M-SFT', 'unverified'),
  ('avatar', 'preset-avatar-default', '默认数字人形象（运营方提供）', null, null, 'any', 'preset-avatar-default', null,
   '运营方在 AVATAR_VOLUME_PATH/preset-avatar-default 放入已取得肖像授权的 LiveTalking Avatar 数据，并设置 LIVETALKING_AVATAR_ID=preset-avatar-default；同时把形象视频上传到本租户对象存储，供内容校验与审批。仓库不附带任何形象素材。',
   '运营方自备形象素材许可（未核实）', null, 'unverified');
