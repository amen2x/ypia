-- Idempotency/retry tracking for post-conversation memory review, so a
-- conversation is never reviewed twice and a failed review stays retryable
-- without ever being silently marked as successfully reviewed.

ALTER TABLE voice_conversations
  ADD COLUMN IF NOT EXISTS memory_review_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS memory_review_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS memory_reviewed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'voice_conversations_memory_review_status_check'
  ) THEN
    ALTER TABLE voice_conversations
      ADD CONSTRAINT voice_conversations_memory_review_status_check
      CHECK (memory_review_status IN ('pending', 'reviewed', 'failed'));
  END IF;
END $$;
