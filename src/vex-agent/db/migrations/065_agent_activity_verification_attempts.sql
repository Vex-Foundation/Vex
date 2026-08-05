-- SURFACE A STALLED VERIFICATION — never auto-fail it (Wave P, owner decree
-- 2026-08-03).
--
-- THE PROBLEM. A pending row whose chain cannot be verified stays pending
-- FOREVER, silently. The bridge verifier already mints precise reasons for
-- this — `no_safe_rpc`, `receipt_unavailable`, `signature_status_unavailable`,
-- `not_yet_confirmed`, `malformed_fill_hash` — and then drops every one of them
-- into a `debug` log. Nothing reaches the UI, and nothing reaches the agent: it
-- sees `pending` and cannot distinguish "still mining" from "we have been
-- unable to look for forty minutes". That is the blind-retry failure mode the
-- agent-facing-errors decree names, applied to a non-error.
--
-- WHAT THIS MIGRATION DOES NOT DO. It does not add a status, does not touch the
-- `agent_activity_status` CHECK, and does not enable any time-based escalation
-- to `definitively_failed`. The never-auto-fail policy is UNCHANGED and remains
-- non-negotiable: `no_safe_rpc` in particular means the transaction's outcome is
-- UNKNOWN, and recording an unknown outcome as failed would report a possibly
-- successful transfer of real funds as a failure.
--
-- `stalled_verification` is therefore a DERIVED read-side state —
-- `status = 'pending' AND verification_attempts >= STALLED_VERIFICATION_ATTEMPTS`
-- — computed by the readers, never stored, never written to `status`.
--
-- COUNTER SEMANTICS. `verification_attempts` counts CONSECUTIVE inconclusive
-- checks and RESETS TO 0 on any successful observation, so it measures a STALL
-- rather than age. That reset is what keeps an offline or rate-limited machine
-- from producing a permanent false "stalled" flag once connectivity returns.
--
-- EXPAND-ONLY. Two nullable/defaulted columns, `IF NOT EXISTS`, no CHECK
-- change, no backfill, no rewrite of existing rows. Every pre-065 row reads as
-- `verification_attempts = 0` (not stalled) and `last_verification_reason NULL`
-- (no reason known yet), which is exactly the truth about a row nobody has
-- failed to verify yet.
--
-- NUMBERING. 065 is the gap between the committed 064 and 066.

ALTER TABLE agent_activity
  ADD COLUMN IF NOT EXISTS verification_attempts INT NOT NULL DEFAULT 0;

ALTER TABLE agent_activity
  ADD COLUMN IF NOT EXISTS last_verification_reason TEXT;

COMMENT ON COLUMN agent_activity.verification_attempts IS
  'Consecutive inconclusive verification attempts; resets to 0 on any successful observation. Derived state only — never a failure trigger.';

COMMENT ON COLUMN agent_activity.last_verification_reason IS
  'Why the last verification attempt could not conclude (e.g. no_safe_rpc, receipt_unavailable). Surfaced to the UI and the agent verbatim as a bounded string.';
