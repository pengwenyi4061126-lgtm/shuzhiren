-- AIGC implicit label (人工智能生成合成内容标识办法, in force since 2025-09-01): each registered recording keeps
-- the AIGC label metadata of the content it captured: whether the explicit on-screen label was enabled, its text,
-- the content producer (the service provider's name) and the content id. The console copies them from the run's
-- sealed release manifest snapshot (manifest->'aigc').
--
-- Rows registered before 083, and recordings of runs whose snapshot predates the label, keep all four columns
-- null: their label state was never recorded and is not reconstructed. Otherwise all four are set together.
-- The governed-mutation trigger of 063 keeps the columns immutable after insert.
alter table recording_evidence
  add column if not exists aigc_label_enabled boolean,
  add column if not exists aigc_label_text text,
  add column if not exists aigc_content_producer text,
  add column if not exists aigc_content_id text;

alter table recording_evidence
  add constraint recording_evidence_aigc_label_check check (
    (aigc_label_enabled is null and aigc_label_text is null and aigc_content_producer is null and aigc_content_id is null)
    or (
      aigc_label_enabled is not null
      and char_length(btrim(aigc_label_text)) between 1 and 32
      and char_length(btrim(aigc_content_producer)) between 1 and 128
      and aigc_content_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$'
    )
  );
