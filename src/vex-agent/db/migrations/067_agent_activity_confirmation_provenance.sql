-- SEPARATE PROVENANCE FOR "HOW WE KNOW THE STATUS" AND "HOW WE KNOW THE MONEY"
-- (R1, owner feedback 2026-08-03: a `confirmed` row with `executedAmount* = null`
-- and `amountBasis: "estimated"` forever, with nothing on it saying why).
--
-- THE PROBLEM. `confirmed` today means three different things indistinguishably:
-- "we decoded our own receipt", "a sweep glanced at a receipt status and learned
-- nothing about amounts", and "a provider said so". The agent cannot tell them
-- apart, so it cannot tell a settled trade from one whose amounts are still
-- unknown — and no fallback can find the second kind, because every repair sweep
-- is guarded to `status = 'pending'`.
--
-- WHY FOUR COLUMNS AND NOT A REUSE OF 065. `verification_attempts` /
-- `last_verification_reason` mean, exactly, *how many consecutive verification
-- CHECKS could not conclude, and why the last one failed*. A successful
-- confirmation is not a failed check, a still-pending row's reason is not a
-- failed check either, and a provider observation's clock is not a verification
-- clock. Storing any of those in 065's columns would make that migration's own
-- COMMENT false — and the comment is what the next session reads.
--
--   confirmation_source         how the row's TERMINAL STATUS was established
--   settlement_source           how its EXECUTED AMOUNTS were established, or
--                               why they are absent — INDEPENDENT of the status
--                               fact, so a late decode can never overwrite how
--                               the status was proven
--   pending_reason              why a still-PENDING row is pending; CLEARED by
--                               every terminalizing CAS, so a terminal row never
--                               stores a reason it "is pending"
--   provider_status_observed_at when this row's `provider_status` was observed,
--                               for provider-to-provider ordering ONLY.
--                               Deliberately NOT `last_checked_at`, which has
--                               three other writers: a verification write landing
--                               between two provider observations would push that
--                               clock past the newer observation and the ordering
--                               guard would drop the FRESHER provider status.
--
-- The vocabularies are TypeScript closed unions with lockstep tests
-- (`db/repos/agent-activity/provenance-vocabulary.ts`), deliberately not DB
-- CHECKs: this migration is expand-only and a CHECK would make every future
-- code a migration — the same reasoning 065 recorded for its own column.
--
-- EXPAND-ONLY. Three nullable TEXT columns and one nullable TIMESTAMPTZ,
-- `IF NOT EXISTS`, no backfill, no CHECK change. Every pre-067 row reads as all
-- four NULL, which is the truth about a row whose provenance was never recorded.
--
-- NUMBERING. 067 follows the committed 066 (060 is a pre-existing gap).

ALTER TABLE agent_activity
  ADD COLUMN IF NOT EXISTS confirmation_source TEXT;

ALTER TABLE agent_activity
  ADD COLUMN IF NOT EXISTS settlement_source TEXT;

ALTER TABLE agent_activity
  ADD COLUMN IF NOT EXISTS pending_reason TEXT;

ALTER TABLE agent_activity
  ADD COLUMN IF NOT EXISTS provider_status_observed_at TIMESTAMPTZ;

COMMENT ON COLUMN agent_activity.confirmation_source IS
  'How this row''s TERMINAL STATUS was established: tool_response (the venue handler decoded its own receipt at return), receipt_status_only_evm / receipt_status_only_solana (a repair sweep proved inclusion and nothing else), provider_fill_verified (independent proof of a bridge fill). NULL on every pending row and on every pre-067 row. Never says anything about the amounts — see settlement_source.';

COMMENT ON COLUMN agent_activity.settlement_source IS
  'How this row''s EXECUTED AMOUNTS were established, or why they are absent: tool_response, receipt_decoded_late, provider_verified, conflict_quarantined (two decoders disagreed — no money was written and the row is durably excluded from the fallback), amounts_incomplete, amounts_undecodable. Independent of confirmation_source: a row can be status-confirmed by a sweep and amount-proven later, and neither may overwrite the other.';

COMMENT ON COLUMN agent_activity.pending_reason IS
  'Why a still-PENDING row is pending, in a closed vocabulary (e.g. broadcast_ambiguous_confirm, settlement_undecodable, provider_fill_unverified). Distinct from last_verification_reason, which keeps its 065 meaning: why the last verification CHECK could not conclude. Cleared by every terminalizing CAS.';

COMMENT ON COLUMN agent_activity.provider_status_observed_at IS
  'When this row''s provider_status was observed. Provider-to-provider ordering ONLY — it exists because last_checked_at is shared with 065 verification bookkeeping, whose writers would otherwise make a newer provider observation look stale.';
