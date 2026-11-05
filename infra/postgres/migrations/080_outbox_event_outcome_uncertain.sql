-- H7 (Requirement 19.12): Runtime Gateway answers command_outcome_uncertain when a command may have run partly
-- or its result is unknown. The runtime worker fails such an event without retrying and records the time here.
-- claimEvent and the console's claim both set last_error = null when they claim an event, so the flag cannot live
-- in last_error. The worker skips flagged events when it claims (unless the event is delivering, the case of a
-- manual redelivery whose record was not committed), clears the flag when the event is delivered, and clears it
-- when the Gateway answers command_failed_definite. The runtime worker's table-level SELECT and UPDATE on
-- outbox_events cover the new column. No trigger is added.
--
-- The plan numbered this migration 072; 072 was not used and 079 is already applied, so the Migrator would refuse
-- a lower number as out of order.
alter table outbox_events add column if not exists outcome_uncertain_at timestamptz;
comment on column outbox_events.outcome_uncertain_at is
  'Set when Runtime Gateway answered command_outcome_uncertain; cleared on delivery or on a definite gateway answer.';
