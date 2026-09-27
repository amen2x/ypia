-- Durable, backend-validated memories extracted from Yupia voice conversations.
-- Gemini proposes candidates; the backend is the final authority on what gets
-- inserted here. Rows are only ever inserted, never updated/overwritten, so an
-- apparent contradiction between an old and new memory is never silently
-- resolved automatically. Safe to run multiple times (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS parent_memories (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    parent_id text NOT NULL REFERENCES parents(id),
    fact text NOT NULL,
    normalized_fact text NOT NULL,
    category text NOT NULL,
    source_conversation_id text REFERENCES voice_conversations(id),
    source_turn_index integer,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parent_memories_parent_id ON parent_memories(parent_id);

-- Deterministic dedupe: the same normalized fact is never stored twice for a parent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_parent_memories_dedupe
  ON parent_memories(parent_id, normalized_fact);
