-- 069 — the user-form continuation's COMPLETION marker.
--
-- WHY A SECOND COLUMN, WHEN `result_message_id` ALREADY EXISTS.
--
-- They record two different facts, and the §C3b resume conflated them exactly
-- as the approval lifecycle once conflated "a resume started" with "a resume
-- finished":
--
--   result_message_id  — the form's outcome is IN THE TRANSCRIPT. Stamped in
--                        the same transaction as the tool-result row, so the
--                        two can never disagree.
--   resume_consumed_at — a resumed TURN has completed for that result. This is
--                        the only thing that ends the continuation's
--                        eligibility.
--
-- The gap between them is real and was unrecoverable. The chat resume stamps
-- the result, then claims the session lease, then runs the turn. Between the
-- stamp and the lease:
--
--   * an operator Stop committing there saw no live lease, no approval
--     lifecycle and — because the outstanding-form predicate keyed off
--     `result_message_id IS NULL` — no outstanding form either. It concluded
--     nothing would observe a stop request, retired it, and the dispatch then
--     ran a model turn on a stopped session. On the launch path.
--   * a busy lease, a crash or a restart there left a stamped row that the
--     durable scan could no longer see, because that scan used the same
--     predicate. The agent's turn was parked forever holding an answered tool
--     call nobody would ever deliver.
--
-- With this column both are closed by the same fact: work is owed while
-- `resume_consumed_at IS NULL`, whether or not the result has been appended,
-- and the recovery scan reads `result_message_id` only to decide WHICH half is
-- still owed — append-then-dispatch, or dispatch-only.
--
-- Expand-only: nullable, no default, no backfill. Every existing row reads as
-- "not consumed", which is the safe direction — a row whose turn really did
-- complete is re-dispatched at most once more, and the gated dispatch is
-- idempotent about that (the transcript already carries its result).

ALTER TABLE token_launch_intents
  ADD COLUMN IF NOT EXISTS resume_consumed_at TIMESTAMPTZ;

-- The durable floor's candidate set, and nothing else: rows that parked an
-- agent turn and have not yet had one complete. Rows leave it permanently once
-- consumed, so the index stays small no matter how many launches accumulate.
CREATE INDEX IF NOT EXISTS idx_token_launch_intents_unconsumed_form
  ON token_launch_intents (created_at)
  WHERE tool_call_id IS NOT NULL AND resume_consumed_at IS NULL;
