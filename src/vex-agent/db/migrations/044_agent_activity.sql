-- Agent Scan Phase 1 (plan §4.1 + §11.1) — the `agent_activity` table.
--
-- Replaces per-protocol PnL/lot projections with ONE plain, append-mostly
-- record of every EVM swap ATTEMPT (not just successes): pending at/before
-- broadcast, confirmed or definitively_failed once the chain settles it. One
-- `protocol_executions` row (the existing audit intent) can now fan out into
-- one-or-more `agent_activity` EVENT rows (`event_role`: an allowance reset,
-- an allowance grant, and the swap itself can each get their own row), keyed
-- by `(protocol_execution_id, event_index)` for idempotency.
--
-- Write protocol (§11.1, enforced by CAS in the repo AND by CHECK here —
-- FIX-SPINE round 1, Codex findings 3/5/6/7):
--   1. `protocol_executions` intent row + the initial `agent_activity` event
--      row(s) (one-or-more — allowance_reset/allowance/swap can each get
--      their own row) are created BEFORE any allowance/swap broadcast.
--   2. The handler signs locally, computes the tx hash from the signed
--      payload, and PERSISTS tx_hash/from_address/nonce/submit_attempted_at
--      (CAS `WHERE status='pending' AND tx_hash IS NULL` — no overwrite of an
--      already-staged hash) — only THEN does it broadcast.
--      `markBroadcastAccepted` (CAS `WHERE tx_hash IS NOT NULL AND
--      broadcast_at IS NULL`) stamps `broadcast_at` once the RPC submit
--      itself is accepted, so a crash between "hash persisted" and "broadcast
--      accepted" leaves an exact, repairable shape, and the two steps can
--      never run out of order.
--   3. AMBIGUITY NEVER TERMINALIZES: finalization is a compare-and-set
--      (`pending -> confirmed | definitively_failed`) driven ONLY by a
--      DEFINITIVE receipt. A missing receipt, an RPC error, or the viem
--      `waitForTransactionReceipt` throw (confirmation could not be
--      determined — src/tools/evm-chains/receipt-guard.ts:29-37) NEVER
--      finalizes the row — it stays `pending` forever, re-checked by the
--      repair sweep (`src/vex-agent/sync/agent-activity-repair.ts`), which
--      only stamps `last_checked_at`. A MINED REVERT is the one repair-sweep
--      definitive-failure path (`failure_code = 'mined_revert'`).
--      `confirmation_timeout` stays in the closed enum but is NEVER
--      auto-set by the repair sweep — reserved for a future
--      operator/manual path, not a time-based escalation.
--   4. Terminal rows (`confirmed` / `definitively_failed`) are immutable —
--      every finalizing UPDATE in the repo is `WHERE status = 'pending'`,
--      AND the CHECK constraints below make an invalid terminal state
--      (e.g. `confirmed` with no hash, or `definitively_failed` with no
--      failure_code) impossible to persist even from a repo-layer bug.
--
-- Amounts are TEXT (lossless — no float rounding on wei/lamports-scale
-- values). Requested legs (token_in/out + amount_in/out) are the QUOTE-time
-- echo and may be present even on a pre-broadcast failure; EXECUTED legs come
-- ONLY from receipt Transfer-delta decoding at confirm time — a quote never
-- masquerades as a settlement. USD figures are labeled estimates
-- (`usd_source`), never treated as ledger truth.
--
-- `proj_activity` is UNCHANGED and keeps serving legacy/non-migrated
-- protocols read-only; there is no backfill into `agent_activity` (historical
-- rows have irrecoverable mixed units). The compatibility feed
-- (`db/repos/transactions.ts`) unions both without duplicating rows.

CREATE TABLE IF NOT EXISTS agent_activity (
  id                       BIGSERIAL PRIMARY KEY,
  protocol_execution_id    BIGINT NOT NULL REFERENCES protocol_executions(id) ON DELETE RESTRICT,
  event_index              SMALLINT NOT NULL DEFAULT 0,
  event_role               TEXT NOT NULL CHECK (event_role IN ('allowance_reset', 'allowance', 'swap')),
  record_version           SMALLINT NOT NULL DEFAULT 1,

  kind                     TEXT NOT NULL CHECK (kind IN ('swap')),
  protocol                 TEXT NOT NULL,
  chain_id                 BIGINT NOT NULL,
  chain_slug               TEXT,

  status                   TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'confirmed', 'definitively_failed')),
  -- 11-member closed enum (FIX-SPINE round 1, finding 7/C1 grew it from 10):
  -- `mined_revert` is the repair sweep's ONE definitive-failure path (a
  -- receipt lookup that came back reverted); `confirmation_timeout` stays
  -- reserved (never auto-set — see the header note).
  failure_code             TEXT CHECK (failure_code IN (
                              'route_not_found', 'slippage', 'deadline_expired',
                              'insufficient_liquidity', 'allowance_or_balance',
                              'chain_unsupported', 'simulation_reverted', 'mined_revert',
                              'broadcast_error', 'confirmation_timeout', 'unknown'
                            )),
  -- Redacted (lib/diagnostics/text-redaction `redact()`) + hard-capped to 500
  -- chars AT THE REPO BOUNDARY (agent-activity.ts) before it ever reaches
  -- this column — never raw provider/RPC text.
  failure_reason           TEXT,

  -- Requested legs (quote-time echo; nullable — a hashless pre-broadcast
  -- failure may carry these without ever reaching a signed payload).
  token_in_address         TEXT,
  token_in_symbol          TEXT,
  token_in_decimals        SMALLINT,
  amount_in_human          TEXT,
  amount_in_raw            TEXT,
  token_out_address        TEXT,
  token_out_symbol         TEXT,
  token_out_decimals       SMALLINT,
  amount_out_human         TEXT,
  amount_out_raw           TEXT,

  -- Executed legs — receipt Transfer-delta truth ONLY, set at confirm time.
  executed_amount_in_human  TEXT,
  executed_amount_in_raw    TEXT,
  executed_amount_out_human TEXT,
  executed_amount_out_raw   TEXT,

  -- Labeled USD estimates (never ledger truth).
  usd_in_est               NUMERIC,
  usd_out_est              NUMERIC,
  usd_fee_est              NUMERIC,
  usd_source               TEXT,

  tx_hash                  TEXT,
  from_address             TEXT,
  nonce                    BIGINT,
  wallet_address           TEXT NOT NULL,
  session_id               TEXT,
  route_provenance         JSONB,

  submit_attempted_at      TIMESTAMPTZ,
  broadcast_at             TIMESTAMPTZ,
  confirmed_at             TIMESTAMPTZ,
  last_checked_at          TIMESTAMPTZ,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uniq_agent_activity_event UNIQUE (protocol_execution_id, event_index),

  -- ── Conditional-state invariants (FIX-SPINE round 1, finding 3/C8) ──────
  -- A terminal row cannot be missing the fields that define its terminal
  -- state, and a `pending` row cannot carry terminal fields (belt-and-
  -- suspenders alongside the repo's CAS `WHERE status='pending'` guards —
  -- these make an invalid state impossible to persist even from a repo bug).
  CONSTRAINT agent_activity_confirmed_has_hash CHECK (
    status <> 'confirmed' OR (tx_hash IS NOT NULL AND confirmed_at IS NOT NULL)
  ),
  CONSTRAINT agent_activity_confirmed_swap_has_executed_legs CHECK (
    status <> 'confirmed' OR event_role <> 'swap'
    OR (executed_amount_in_raw IS NOT NULL AND executed_amount_out_raw IS NOT NULL)
  ),
  CONSTRAINT agent_activity_failed_has_code CHECK (
    status <> 'definitively_failed' OR failure_code IS NOT NULL
  ),
  CONSTRAINT agent_activity_pending_has_no_terminal_fields CHECK (
    status <> 'pending' OR (confirmed_at IS NULL AND failure_code IS NULL)
  )
);

-- Agent Scan feed hot path (keyset pagination, newest first).
CREATE INDEX IF NOT EXISTS idx_agent_activity_feed
  ON agent_activity (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_agent_activity_wallet
  ON agent_activity (wallet_address, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_activity_session
  ON agent_activity (session_id, created_at DESC)
  WHERE session_id IS NOT NULL;

-- UNIQUE (not just indexed) — FIX-SPINE round 1, finding 5/C6: each on-chain
-- broadcast can back exactly one agent_activity row; this is the DB-level
-- half of "no two rows ever share a signed transaction" (the repo-level half
-- is markActivityBroadcast's CAS `WHERE tx_hash IS NULL`).
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_activity_tx_hash
  ON agent_activity (tx_hash)
  WHERE tx_hash IS NOT NULL;

-- Repair-sweep hot path — pending rows are the only candidates it re-checks.
CREATE INDEX IF NOT EXISTS idx_agent_activity_pending
  ON agent_activity (submit_attempted_at)
  WHERE status = 'pending';

-- ── Memory reconcile retirement (plan §4.4/§11.3) ───────────────────────────
--
-- The async reconcile job kind is retired this phase (outcome-resolver /
-- reconcile-policy / reconcile-judge / reconcile worker deleted — W4).
-- `memory_jobs.status` gains a new terminal value `retired`; every
-- non-terminal (`pending` / `running` / `failed` — `failed` is the
-- auto-retry-pending state, not yet `permanently_failed`) `reconcile` job is
-- terminalized so no future claim can ever pick one up. `consolidate` jobs
-- and already-terminal reconcile jobs (`completed` / `permanently_failed`)
-- are left untouched — history stays readable.
--
-- Expand-only: the named CHECK from `001_initial.sql` is widened in place
-- (drop + re-add, same pattern as 034/035_swap_prequotes_*_kind.sql). No
-- column is dropped; 001_initial.sql's historical text is not edited.

ALTER TABLE memory_jobs
  DROP CONSTRAINT IF EXISTS mj_status_valid;

ALTER TABLE memory_jobs
  ADD CONSTRAINT mj_status_valid CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'permanently_failed', 'retired')
  );

UPDATE memory_jobs
  SET status = 'retired'
  WHERE job_kind = 'reconcile'
    AND status IN ('pending', 'running', 'failed');

-- ── Polymarket sync retirement (plan §4.6/§11.3) ────────────────────────────
--
-- The Polymarket integration is removed entirely (W5). Disable the installed
-- balances job so a live process never enqueues a new run for it (a fresh
-- seed no longer inserts this row, but an ALREADY-INSTALLED database still
-- has it from `seedSyncJobs()`), and terminalize ONLY the runs that belong to
-- THAT job and are still pending/running. `_global`/`prediction_settlement`
-- (Jupiter) and every other job/run is untouched.

UPDATE protocol_sync_jobs
  SET enabled = false
  WHERE namespace = 'polymarket'
    AND sync_type = 'balances';

UPDATE protocol_sync_runs
  SET status = 'failed',
      ended_at = NOW(),
      error = 'retired: polymarket removed'
  WHERE status IN ('pending', 'running')
    AND sync_job_id IN (
      SELECT id FROM protocol_sync_jobs
      WHERE namespace = 'polymarket' AND sync_type = 'balances'
    );

-- ── protocol_executions.execution_status normal-path fix ────────────────────
--
-- No schema change — `db/repos/executions.ts`'s `recordExecution` (the
-- non-intent, post-hoc capture path used by every non-Hyperliquid mutation)
-- omitted `execution_status` on INSERT and relied on the column DEFAULT
-- 'succeeded' (migration 039), so a failed execution captured through that
-- path was mislabeled `succeeded`. Fixed in the repo (explicit CASE on
-- `success`, mirroring `completeExecutionIntent`); no historical backfill —
-- existing mislabeled rows are not corrected (irrecoverable which ones were
-- genuinely `intent` vs `succeeded` before this fix).
