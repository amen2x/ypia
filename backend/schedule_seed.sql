-- ============================================================================
-- Schedule Table and Monthly Events Seed for Susan Carter (Tiger Data)
-- Person: Susan Carter (Age 74, Springfield, IL)
-- Month: October 2026 (CDT / UTC-5)
-- Format:
--   - ONLY calendar events/outings/appointments (NO daily routines or meds)
--   - Normally 1 event per day, with rest days (no events) scattered naturally
-- ============================================================================

-- The parent profile linked to parent@gmail.com / child@gmail.com.
-- Override this when seeding another family, for example:
-- psql "$TIMESCALE_SERVICE_URL" -v schedule_parent_id="<parent UUID>" -f backend/schedule_seed.sql
\if :{?schedule_parent_id}
\else
  \set schedule_parent_id '3c8bb77b-bdf6-444d-a656-ca8046e766b3'
\endif

-- ----------------------------------------------------------------------------
-- 1. RESET THE SCHEDULE TABLE (Cleans out old rows/tuples)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS schedule CASCADE;

CREATE TABLE schedule (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id UUID DEFAULT :'schedule_parent_id'::uuid,
    title VARCHAR(150) NOT NULL,
    description TEXT,
    category VARCHAR(50) NOT NULL, -- Medical, Church, Social, Family, Errands, Community
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    location VARCHAR(150) NOT NULL,
    address VARCHAR(255) NOT NULL,
    with_whom VARCHAR(150) NOT NULL,
    status VARCHAR(50) DEFAULT 'scheduled',
    attendance_status VARCHAR(20) NOT NULL DEFAULT 'not_recorded',
    point_value INTEGER,
    points_earned INTEGER,
    points_review TEXT,
    CONSTRAINT schedule_point_value_range CHECK (point_value IS NULL OR point_value BETWEEN 0 AND 100),
    CONSTRAINT schedule_points_earned_range CHECK (points_earned IS NULL OR (points_earned >= 0 AND points_earned <= point_value)),
    CONSTRAINT schedule_attendance_status CHECK (status IN ('scheduled', 'attended', 'missed')),
    CONSTRAINT schedule_attendance_value CHECK (attendance_status IN ('not_recorded', 'attended', 'missed')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_schedule_time ON schedule(start_time, end_time);
CREATE INDEX idx_schedule_category ON schedule(category);

-- Ensure Susan exists in parents table if applicable
INSERT INTO parents (id, full_name, background_notes)
VALUES (
    :'schedule_parent_id'::uuid,
    'Susan Carter',
    '74 years old. Retired elementary school librarian (28 years, retired 2015). Widowed, husband Robert passed away 3 years ago. Lives on Maple Ridge Lane, Springfield, IL for 40+ years. Son Mike checks in regularly. Sister Carol lives in Peoria. Close friend Linda from church. Cat: Whiskers. Enjoys gardening, mystery novels, baking, classic country music. Prefers morning appointments.'
)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. CALENDAR EVENTS FOR OCTOBER 2026
-- (Notice: Some days like Oct 5, 9, 16, 19, 24, 30 are quiet days with NO events)
-- ----------------------------------------------------------------------------

INSERT INTO schedule (
    title,
    description,
    category,
    start_time,
    end_time,
    location,
    address,
    with_whom
) VALUES

-- Week 1 (Oct 1 - Oct 4)
(
    'Porch Coffee & Catch-up with Linda',
    'Linda stops by Susan''s front porch for morning tea and conversation about upcoming church plans.',
    'Social',
    '2026-10-01 10:00:00-05',
    '2026-10-01 11:30:00-05',
    'Home - Front Porch',
    '1428 Maple Ridge Ln, Springfield, IL 62704',
    'Linda Henderson (Church Friend)'
),
(
    'Routine Blood Pressure Check & Lab Review',
    '6-month routine wellness checkup and blood pressure reading with Dr. Evans. Scheduled in the morning per Susan''s preference.',
    'Medical',
    '2026-10-02 09:00:00-05',
    '2026-10-02 10:15:00-05',
    'Springfield Memorial Clinic',
    '701 N 1st St, Springfield, IL 62781',
    'Dr. Robert Evans, MD (Accompanied by son Mike Carter)'
),
(
    'Lunch & Apple Pie Baking with Grandkids',
    'Mike brings grandchildren Emma and Lucas over to make homemade apple pie and play cards.',
    'Family',
    '2026-10-03 11:30:00-05',
    '2026-10-03 13:30:00-05',
    'Home - Kitchen',
    '1428 Maple Ridge Ln, Springfield, IL 62704',
    'Mike Carter, Emma (Granddaughter), Lucas (Grandson)'
),
(
    'Sunday Worship Service & Fellowship Hour',
    'Traditional Sunday morning church service followed by coffee and fellowship in the parish hall.',
    'Church',
    '2026-10-04 09:30:00-05',
    '2026-10-04 11:30:00-05',
    'First Community Church of Springfield',
    '600 S 5th St, Springfield, IL 62701',
    'Linda Henderson & Church Congregation'
),

-- Mon Oct 5: [No events - Quiet rest day at home]

-- Week 2 (Oct 6 - Oct 11)
(
    'Weekly Grocery Shopping Run with Son Mike',
    'Mike drives Susan to Hy-Vee for weekly grocery run: milk, bread, dark roast coffee, and baking ingredients.',
    'Errands',
    '2026-10-06 09:15:00-05',
    '2026-10-06 10:45:00-05',
    'Hy-Vee Grocery Store',
    '2115 S MacArthur Blvd, Springfield, IL 62704',
    'Mike Carter (Son)'
),
(
    'Church Women''s Auxiliary Monthly Meeting',
    'Monthly meeting to organize autumn food pantry donations and church floral arrangements.',
    'Church',
    '2026-10-07 10:00:00-05',
    '2026-10-07 11:30:00-05',
    'First Community Church - Fellowship Hall',
    '600 S 5th St, Springfield, IL 62701',
    'Linda Henderson & Women''s Auxiliary Group'
),
(
    'Prescription Refill Pickup & Pharmacy Consult',
    'Picking up 90-day medication refills and brief consultation with the pharmacist.',
    'Medical',
    '2026-10-08 10:00:00-05',
    '2026-10-08 10:45:00-05',
    'Walgreens Pharmacy',
    '2020 S MacArthur Blvd, Springfield, IL 62704',
    'Greg Patel, RPh (Pharmacist)'
),

-- Fri Oct 9: [No events - Quiet rest day at home]

(
    'Fall Garden Plant Exchange with Neighbor Jim',
    'Meeting neighbor Jim by the fence to trade perennial cuttings and chat about winterizing vegetable beds.',
    'Community',
    '2026-10-10 10:30:00-05',
    '2026-10-10 11:30:00-05',
    'Home - Backyard Garden',
    '1428 Maple Ridge Ln, Springfield, IL 62704',
    'Jim Miller (Neighbor)'
),
(
    'Sunday Morning Worship & Choir Service',
    'Weekly church service, hymn singing, and greeting friends.',
    'Church',
    '2026-10-11 09:30:00-05',
    '2026-10-11 11:30:00-05',
    'First Community Church of Springfield',
    '600 S 5th St, Springfield, IL 62701',
    'Linda Henderson & Church Community'
),

-- Week 3 (Oct 12 - Oct 18)
(
    'Telephone Catch-up with Sister Carol',
    'Long-distance phone call catching up with sister Carol in Peoria to discuss family and Thanksgiving recipes.',
    'Family',
    '2026-10-12 14:00:00-05',
    '2026-10-12 15:00:00-05',
    'Home - Living Room',
    '1428 Maple Ridge Ln, Springfield, IL 62704',
    'Carol Davis (Sister - via Phone)'
),
(
    'Annual Optometry & Vision Exam',
    'Yearly eye examination, glaucoma test, and updated reading glasses prescription.',
    'Medical',
    '2026-10-13 09:30:00-05',
    '2026-10-13 10:45:00-05',
    'Springfield Eye Center',
    '1025 S 6th St, Springfield, IL 62703',
    'Dr. Patricia Vance, OD (Accompanied by Mike Carter)'
),
(
    'Lincoln Library - Mystery Books Exchange',
    'Returning completed mystery novels and picking up reserved Agatha Christie and Louise Penny books.',
    'Errands',
    '2026-10-14 14:00:00-05',
    '2026-10-14 15:15:00-05',
    'Lincoln Library (Springfield Public Library)',
    '326 S 7th St, Springfield, IL 62701',
    'Sarah Collins (Librarian)'
),
(
    'Morning Porch Tea & Muffins with Linda',
    'Linda visits Susan''s home for warm herbal tea and homemade pumpkin muffins on the porch.',
    'Social',
    '2026-10-15 10:00:00-05',
    '2026-10-15 11:30:00-05',
    'Home - Front Porch',
    '1428 Maple Ridge Ln, Springfield, IL 62704',
    'Linda Henderson'
),

-- Fri Oct 16: [No events - Quiet rest day at home]

(
    'Afternoon Scrabble & Visit with Grandkids',
    'Emma and Lucas visit for an afternoon board game and stories about grandpa Robert.',
    'Family',
    '2026-10-17 13:30:00-05',
    '2026-10-17 15:30:00-05',
    'Home - Living Room',
    '1428 Maple Ridge Ln, Springfield, IL 62704',
    'Emma, Lucas, and Mike Carter'
),
(
    'Sunday Worship Service & Autumn Altar Decorating',
    'Sunday morning service, staying afterward to help decorate the church altar for autumn.',
    'Church',
    '2026-10-18 09:30:00-05',
    '2026-10-18 11:45:00-05',
    'First Community Church of Springfield',
    '600 S 5th St, Springfield, IL 62701',
    'Linda Henderson & Altar Guild'
),

-- Mon Oct 19: [No events - Quiet rest day at home]

-- Week 4 (Oct 20 - Oct 25)
(
    'Mid-Month Grocery Shopping with Son Mike',
    'Shopping trip to Hy-Vee for pantry staples, soup ingredients, and fresh produce.',
    'Errands',
    '2026-10-20 09:15:00-05',
    '2026-10-20 10:30:00-05',
    'Hy-Vee Grocery Store',
    '2115 S MacArthur Blvd, Springfield, IL 62704',
    'Mike Carter (Son)'
),
(
    'Garden Bed Winterization with Neighbor Jim',
    'Jim helps Susan mulch the garden beds and pull down the wooden tomato stakes for winter.',
    'Community',
    '2026-10-21 10:00:00-05',
    '2026-10-21 11:30:00-05',
    'Home - Backyard Garden',
    '1428 Maple Ridge Ln, Springfield, IL 62704',
    'Jim Miller (Neighbor)'
),
(
    'Church Prayer Circle & Morning Fellowship',
    'Weekly quiet prayer group and coffee in the church library room.',
    'Church',
    '2026-10-22 10:00:00-05',
    '2026-10-22 11:15:00-05',
    'First Community Church',
    '600 S 5th St, Springfield, IL 62701',
    'Linda Henderson & Prayer Circle'
),
(
    'Whiskers'' Annual Veterinary Wellness Exam',
    'Annual vet examination, weight check, and rabies vaccine update for 6-year-old cat Whiskers.',
    'Medical',
    '2026-10-23 09:30:00-05',
    '2026-10-23 10:30:00-05',
    'Lincoln Land Animal Clinic',
    '1801 W Monroe St, Springfield, IL 62704',
    'Dr. Donald Miller, DVM (Mike driving; with Whiskers)'
),

-- Sat Oct 24: [No events - Quiet rest day at home]

(
    'Sunday Worship Service & Harvest Potluck',
    'Sunday service followed by the annual church autumn potluck in the fellowship hall.',
    'Church',
    '2026-10-25 09:30:00-05',
    '2026-10-25 12:30:00-05',
    'First Community Church of Springfield',
    '600 S 5th St, Springfield, IL 62701',
    'Linda Henderson & Church Congregation'
),

-- Week 5 (Oct 26 - Oct 31)
(
    'Telephone Call with Sister Carol',
    'Afternoon phone check-in with Carol to finalize Thanksgiving travel details.',
    'Family',
    '2026-10-26 14:00:00-05',
    '2026-10-26 15:00:00-05',
    'Home - Living Room',
    '1428 Maple Ridge Ln, Springfield, IL 62704',
    'Carol Davis (Sister - via Phone)'
),
(
    'Lincoln Library - Reserving Winter Reading List',
    'Dropping off read mystery books and reserving large-print winter novels.',
    'Errands',
    '2026-10-27 13:30:00-05',
    '2026-10-27 14:45:00-05',
    'Lincoln Library',
    '326 S 7th St, Springfield, IL 62701',
    'Sarah Collins (Librarian)'
),
(
    'Semi-Annual Dental Cleaning & Oral Exam',
    'Routine dental exam and cleaning. Morning slot chosen to avoid late-day fatigue.',
    'Medical',
    '2026-10-28 09:30:00-05',
    '2026-10-28 10:45:00-05',
    'Prairie Dental Arts',
    '1100 S 5th St, Springfield, IL 62703',
    'Dr. Thomas Wright, DDS (Accompanied by Mike Carter)'
),
(
    'Morning Porch Tea & Conversation with Linda',
    'Morning visit with Linda on the porch sharing slices of fresh banana bread.',
    'Social',
    '2026-10-29 10:00:00-05',
    '2026-10-29 11:15:00-05',
    'Home - Front Porch',
    '1428 Maple Ridge Ln, Springfield, IL 62704',
    'Linda Henderson'
),

-- Fri Oct 30: [No events - Quiet rest day at home]

(
    'Front Porch Quiet Halloween Candy Handout',
    'Sitting on the porch with son Mike and grandchildren Emma & Lucas to hand out candy to neighborhood children.',
    'Family',
    '2026-10-31 16:30:00-05',
    '2026-10-31 18:00:00-05',
    'Home - Front Porch',
    '1428 Maple Ridge Ln, Springfield, IL 62704',
    'Mike Carter, Emma, Lucas'
),
(
    'Lunch at Maple Street Café with Mike',
    'A relaxed lunch after Susan''s clinic visit to talk through the rest of the week.',
    'Family',
    '2026-10-02 12:00:00-05',
    '2026-10-02 13:00:00-05',
    'Maple Street Café',
    '1200 S 5th St, Springfield, IL 62703',
    'Mike Carter (Son)'
),
(
    'Church Choir Practice',
    'An afternoon rehearsal for Sunday''s choir service.',
    'Church',
    '2026-10-07 13:00:00-05',
    '2026-10-07 14:15:00-05',
    'First Community Church - Choir Room',
    '600 S 5th St, Springfield, IL 62701',
    'Church Choir'
),
(
    'Mystery Book Club Discussion',
    'Small library book-club discussion of the month''s mystery novel.',
    'Social',
    '2026-10-14 10:30:00-05',
    '2026-10-14 11:30:00-05',
    'Lincoln Library - Community Room',
    '326 S 7th St, Springfield, IL 62701',
    'Library Book Club'
),
(
    'Sunday Family Brunch',
    'Brunch with Mike and the grandchildren before the afternoon at home.',
    'Family',
    '2026-10-18 12:00:00-05',
    '2026-10-18 13:15:00-05',
    'Maple Street Café',
    '1200 S 5th St, Springfield, IL 62703',
    'Mike, Emma, and Lucas'
),
(
    'Evening Card Game with Neighbor Jim',
    'A casual card-game visit after the garden work.',
    'Social',
    '2026-10-21 18:30:00-05',
    '2026-10-21 19:30:00-05',
    'Home - Living Room',
    '1428 Maple Ridge Ln, Springfield, IL 62704',
    'Jim Miller (Neighbor)'
),
(
    'Pumpkin Patch Visit with Grandchildren',
    'A short afternoon outing to choose pumpkins and take family photos.',
    'Family',
    '2026-10-25 13:00:00-05',
    '2026-10-25 14:30:00-05',
    'Willow Creek Pumpkin Patch',
    '2800 W Jefferson St, Springfield, IL 62702',
    'Mike, Emma, and Lucas'
);
