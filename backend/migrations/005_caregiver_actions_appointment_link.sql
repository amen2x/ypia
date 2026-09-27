-- Optional, backend-verified link from a voice-created caregiver action to the
-- real stored appointment it refers to, so calendar export can use authoritative
-- appointment data instead of free-text action prose. Nullable and additive —
-- existing actions are unaffected, no backfill.

ALTER TABLE caregiver_actions
  ADD COLUMN IF NOT EXISTS appointment_id text
  REFERENCES appointments(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_caregiver_actions_appointment_id
  ON caregiver_actions(appointment_id)
  WHERE appointment_id IS NOT NULL;
