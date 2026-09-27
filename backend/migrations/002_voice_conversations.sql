-- Voice conversations: ownership + synced transcript metadata for a parent's
-- ElevenLabs Yupia conversations. No audio and no ElevenLabs credentials are
-- ever stored here. Safe to run multiple times (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS voice_conversations (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    parent_id text NOT NULL REFERENCES parents(id),
    elevenlabs_conversation_id text NOT NULL UNIQUE,
    transcript jsonb,
    summary text,
    main_language text,
    started_at timestamptz,
    ended_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voice_conversations_parent_id ON voice_conversations(parent_id);
