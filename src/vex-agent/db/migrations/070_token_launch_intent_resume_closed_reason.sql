-- 070 — WHY a form continuation was closed without a turn ever running.
--
-- 069 gave the continuation its completion marker: work is owed while
-- `resume_consumed_at IS NULL`. That is the right eligibility rule and it has
-- one consequence nobody had a way to record — a continuation that can NEVER
-- complete stays owed forever.
--
-- Live evidence: intent aa5401f2 warned
-- `trench.launch_form_expiry.resume_failed status=400` every ~60s sweep,
-- indefinitely. Its SESSION had been deleted minutes earlier, so every attempt
-- rebuilt a prompt from a history that no longer existed and every attempt got
-- the same deterministic refusal. The sweep was doing exactly what it was told:
-- the row was outstanding, so it retried, forever.
--
-- Two closures need to be representable, and both are TERMINAL:
--
--   session_deleted             the session the turn belongs to is gone (row
--                               removed or soft-deleted). There is nothing left
--                               to resume — not a failure to retry.
--   resume_failed_deterministic the same deterministic provider refusal on two
--                               consecutive attempts against an unchanged
--                               prompt. A third attempt cannot differ.
--
-- Both are written TOGETHER WITH `resume_consumed_at`, so a closed continuation
-- leaves the outstanding set permanently and the reason is never orphaned from
-- the fact. NULL means the ordinary path: a resumed turn actually completed.
--
-- NO MONEY SEMANTICS. This column describes the owed MODEL TURN only. The
-- launch's own status, hash, fee and outcome columns are untouched — a closed
-- continuation says nothing about whether a token was created.
--
-- Expand-only: nullable, no default, no backfill. Every existing row reads as
-- "completed normally or still owed", which is what those rows are.

ALTER TABLE token_launch_intents
  ADD COLUMN IF NOT EXISTS resume_closed_reason TEXT;

-- The vocabulary is closed, and enforced here rather than only in TypeScript:
-- a reason nobody can decode is worse than none. `NOT VALID` is deliberately
-- NOT used — the column is new, so no existing row can violate it.
ALTER TABLE token_launch_intents
  DROP CONSTRAINT IF EXISTS token_launch_intents_resume_closed_reason_known;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_resume_closed_reason_known
  CHECK (
    resume_closed_reason IS NULL
    OR resume_closed_reason IN ('session_deleted', 'resume_failed_deterministic')
  );
