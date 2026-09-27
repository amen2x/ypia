-- Calendar engagement points are intentionally non-medical: they reflect the
-- value of completing a planned activity, not a person's health or worth.
ALTER TABLE schedule
  ADD COLUMN IF NOT EXISTS point_value INTEGER,
  ADD COLUMN IF NOT EXISTS points_earned INTEGER,
  ADD COLUMN IF NOT EXISTS points_review TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schedule_point_value_range') THEN
    ALTER TABLE schedule
      ADD CONSTRAINT schedule_point_value_range CHECK (point_value IS NULL OR point_value BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schedule_points_earned_range') THEN
    ALTER TABLE schedule
      ADD CONSTRAINT schedule_points_earned_range
      CHECK (points_earned IS NULL OR (points_earned >= 0 AND points_earned <= point_value));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schedule_attendance_status') THEN
    ALTER TABLE schedule
      ADD CONSTRAINT schedule_attendance_status CHECK (status IN ('scheduled', 'attended', 'missed'));
  END IF;
END $$;
