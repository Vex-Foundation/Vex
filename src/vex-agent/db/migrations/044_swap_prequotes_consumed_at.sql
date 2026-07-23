-- Single-use prequotes: a successful gated execute consumes the matched
-- ticket so it cannot authorize another broadcast of the same identity
-- until a new quote is recorded. Unconsumed + unexpired is the gate's
-- "fresh" definition; multi-fill under one quote is no longer possible.
--
-- Forward-only; idempotent IF NOT EXISTS. Existing rows stay usable
-- (consumed_at NULL) until they expire or are consumed by a future execute.

ALTER TABLE swap_prequotes
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;

-- Gate hot path: newest fresh *unconsumed* row for a (session, match_hash, kind).
CREATE INDEX IF NOT EXISTS idx_swap_prequotes_match_unconsumed
  ON swap_prequotes (session_id, match_hash, kind, created_at DESC)
  WHERE consumed_at IS NULL;
