alter table creation_project_recordings
  add column recording_quality jsonb not null default '{"status":"legacy_unverified"}'::jsonb;

alter table creation_project_recordings
  add constraint creation_project_recordings_quality_check check (
    jsonb_typeof(recording_quality) = 'object'
    and (
      recording_quality ->> 'status' = 'legacy_unverified'
      or (
        recording_quality ->> 'status' = 'verified'
        and recording_quality ->> 'profile' = 'photo-narration-webm'
        and recording_quality ->> 'videoWidth' = '720'
        and recording_quality ->> 'videoHeight' = '1280'
        and recording_quality ->> 'verifier' = 'ffprobe'
        and (recording_quality ->> 'audioTrackCount') ~ '^[1-9][0-9]*$'
        and (recording_quality ->> 'audioTrackCount')::integer >= 1
        and (recording_quality ->> 'durationSeconds') ~ '^(?:[1-9][0-9]{0,2})(?:\.[0-9]+)?$'
        and (recording_quality ->> 'durationSeconds')::numeric between 1 and 300
      )
    )
  );
