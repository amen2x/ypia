-- Caregiver actions: short requests a parent sends to their caregiver,
-- created either through the Yupia voice assistant or manually.
-- Safe to run multiple times (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS caregiver_actions (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    parent_id text NOT NULL REFERENCES parents(id),
    created_by_user_id text REFERENCES users(id),
    action_text text NOT NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    source text NOT NULL DEFAULT 'voice',
    elevenlabs_conversation_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_caregiver_actions_parent_id ON caregiver_actions(parent_id);
