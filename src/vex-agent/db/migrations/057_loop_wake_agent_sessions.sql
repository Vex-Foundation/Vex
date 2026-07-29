-- NUMBERING: 057 is FINAL. The migration runner applies only version > MAX(applied), so
-- "reserving" a number for a later wave is impossible — a higher number shipped first
-- permanently skips the lower one on every DB it reached. The compaction wave takes the
-- next free number at ITS build time (see compaction-wave.plan.md C1). Do not renumber.
--
-- Session-scoped wake requests for Full-Autonomous AGENT sessions.
--
-- Migration 011 asserted "mission_run_id is required. Wake requests only resume
-- mission runs; agent sessions never expose loop_defer." The first half is what
-- changes here; the second half still holds — `loop_defer` remains mission-only
-- and still writes a non-null `mission_run_id`.
--
-- What changed (owner decision 2026-07-29): a Full-Autonomous AGENT session that
-- exhausts a runtime slice (`iteration_limit` / `timeout`) now schedules the same
-- 5 s continuation a mission run gets, so a long autonomous tool sequence is not
-- cut off mid-work. An agent session has NO `mission_runs` row — there is nothing
-- to park and nothing for the executor to claim by run status — so the wake row
-- must be able to reference the session alone. The executor branches on
-- `mission_run_id IS NULL` and claims the SESSION LEASE instead
-- (`engine/wake/executor/agent-session.ts`).
--
-- Expand-only and reversible: no data is rewritten, every existing row keeps a
-- non-null `mission_run_id`, and old code paths that only ever read mission wakes
-- are unaffected because they select by `mission_run_id`. To reverse, delete the
-- session-scoped rows (`WHERE mission_run_id IS NULL`) and re-add the constraint.
--
-- Both invariants from 011 are untouched: one pending row per session
-- (`uniq_loop_wake_pending_per_session`) and the executor's partial due index.

ALTER TABLE loop_wake_requests
  ALTER COLUMN mission_run_id DROP NOT NULL;

COMMENT ON COLUMN loop_wake_requests.mission_run_id IS
  'The mission run this wake resumes, or NULL for a session-scoped continuation of a Full-Autonomous agent session (no run row exists). The wake executor branches on NULL: run-status claim vs session-lease claim.';
