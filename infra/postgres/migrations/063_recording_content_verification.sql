alter table recording_evidence
  add column if not exists verified_object_version text,
  add column if not exists verification_evidence_ref text,
  add column if not exists verified_at timestamptz;

alter table recording_evidence
  add constraint recording_evidence_verified_object_version_check check (verified_object_version is null or verified_object_version ~ '^[A-Za-z0-9._:-]{1,200}$'),
  add constraint recording_evidence_verification_evidence_ref_check check (verification_evidence_ref is null or verification_evidence_ref ~ '^evidence://[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$' or verification_evidence_ref ~ '^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$');

create index recording_evidence_tenant_verification_idx
  on recording_evidence (tenant_id, verified_at desc);

drop trigger if exists recording_evidence_append_only on recording_evidence;

create or replace function govern_recording_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'recording evidence is immutable';
  end if;
  if new.verified_object_version is null or new.verification_evidence_ref is null or new.verified_at is null then
    raise exception 'recording evidence requires verifier attestation';
  end if;
  return new;
end;
$$;

create trigger recording_evidence_governed_mutation
before insert or update or delete on recording_evidence
for each row execute function govern_recording_evidence_mutation();
