-- Keep attendance as data on the calendar row, rather than a dashboard control.
ALTER TABLE schedule
  ADD COLUMN IF NOT EXISTS attendance_status VARCHAR(20) NOT NULL DEFAULT 'not_recorded';

-- Preserve any attendance that was recorded with the earlier status field.
UPDATE schedule
SET attendance_status = CASE status
  WHEN 'attended' THEN 'attended'
  WHEN 'missed' THEN 'missed'
  ELSE attendance_status
END,
status = CASE WHEN status IN ('attended', 'missed') THEN 'scheduled' ELSE status END;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schedule_attendance_value') THEN
    ALTER TABLE schedule
      ADD CONSTRAINT schedule_attendance_value
      CHECK (attendance_status IN ('not_recorded', 'attended', 'missed'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_parent_title_start
  ON schedule (parent_id, title, start_time);

-- Extra activities create multi-event days for the points model to evaluate.
INSERT INTO schedule (
  parent_id, title, description, category, start_time, end_time, location, address, with_whom, status, attendance_status
) VALUES
(
  '3c8bb77b-bdf6-444d-a656-ca8046e766b3',
  'Lunch at Maple Street Café with Mike',
  'A relaxed lunch after Susan''s clinic visit to talk through the rest of the week.',
  'Family', '2026-10-02 12:00:00-05', '2026-10-02 13:00:00-05',
  'Maple Street Café', '1200 S 5th St, Springfield, IL 62703', 'Mike Carter (Son)', 'scheduled', 'not_recorded'
),
(
  '3c8bb77b-bdf6-444d-a656-ca8046e766b3',
  'Church Choir Practice',
  'An afternoon rehearsal for Sunday''s choir service.',
  'Church', '2026-10-07 13:00:00-05', '2026-10-07 14:15:00-05',
  'First Community Church - Choir Room', '600 S 5th St, Springfield, IL 62701', 'Church Choir', 'scheduled', 'not_recorded'
),
(
  '3c8bb77b-bdf6-444d-a656-ca8046e766b3',
  'Mystery Book Club Discussion',
  'Small library book-club discussion of the month''s mystery novel.',
  'Social', '2026-10-14 10:30:00-05', '2026-10-14 11:30:00-05',
  'Lincoln Library - Community Room', '326 S 7th St, Springfield, IL 62701', 'Library Book Club', 'scheduled', 'not_recorded'
),
(
  '3c8bb77b-bdf6-444d-a656-ca8046e766b3',
  'Sunday Family Brunch',
  'Brunch with Mike and the grandchildren before the afternoon at home.',
  'Family', '2026-10-18 12:00:00-05', '2026-10-18 13:15:00-05',
  'Maple Street Café', '1200 S 5th St, Springfield, IL 62703', 'Mike, Emma, and Lucas', 'scheduled', 'not_recorded'
),
(
  '3c8bb77b-bdf6-444d-a656-ca8046e766b3',
  'Pumpkin Patch Visit with Grandchildren',
  'A short afternoon outing to choose pumpkins and take family photos.',
  'Family', '2026-10-25 13:00:00-05', '2026-10-25 14:30:00-05',
  'Willow Creek Pumpkin Patch', '2800 W Jefferson St, Springfield, IL 62702', 'Mike, Emma, and Lucas', 'scheduled', 'not_recorded'
),
(
  '3c8bb77b-bdf6-444d-a656-ca8046e766b3',
  'Evening Card Game with Neighbor Jim',
  'A casual card-game visit after the garden work.',
  'Social', '2026-10-21 18:30:00-05', '2026-10-21 19:30:00-05',
  'Home - Living Room', '1428 Maple Ridge Ln, Springfield, IL 62704', 'Jim Miller (Neighbor)', 'scheduled', 'not_recorded'
)
ON CONFLICT (parent_id, title, start_time) DO NOTHING;
