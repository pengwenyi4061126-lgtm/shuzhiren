alter table policy_profiles
  add constraint policy_profiles_evidence_ref_format_check
  check (
    evidence_ref ~ '^evidence://[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$'
    or evidence_ref ~ '^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$'
  ) not valid;

alter table model_releases
  add constraint model_releases_evidence_ref_format_check
  check (
    evidence_ref ~ '^evidence://[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$'
    or evidence_ref ~ '^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$'
  ) not valid;
