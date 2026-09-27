-- Optional, explicitly-supplied structured scheduling for non-medical caregiver
-- actions (e.g. "take Susan to the park on Sept 28 at 9am"). Nullable and
-- additive — existing actions and the appointment_id link are unaffected, no
-- backfill. When appointment_id is also set, the linked appointment remains
-- authoritative for calendar metadata (enforced in the read path, not here).

ALTER TABLE caregiver_actions
  ADD COLUMN IF NOT EXISTS scheduled_date date,
  ADD COLUMN IF NOT EXISTS scheduled_time time,
  ADD COLUMN IF NOT EXISTS scheduled_end_time time;
