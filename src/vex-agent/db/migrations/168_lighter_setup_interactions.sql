-- Durable continuation for an Agent turn parked on first-time Lighter setup.
-- The modal settles the row exactly once; its result message is stamped in the
-- same transaction as the transcript append before the original turn resumes.

CREATE TABLE lighter_setup_interactions (
  intent_id UUID PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('core', 'rhc')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'cancelled')),
  result_message_id BIGINT NULL REFERENCES messages(id),
  resume_consumed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, tool_call_id),
  CHECK (status = 'pending' OR updated_at >= created_at)
);

CREATE INDEX lighter_setup_interactions_pending_session_idx
  ON lighter_setup_interactions(session_id, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX lighter_setup_interactions_resume_idx
  ON lighter_setup_interactions(updated_at ASC)
  WHERE status <> 'pending' AND resume_consumed_at IS NULL;
