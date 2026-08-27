-- 095 - Z500 allocation-sync run ledger (indexiy-ansem.md).
--
-- RUNS AFTER 094. One table, one job: make the daily Indexify allocation
-- sync IDEMPOTENT PER SCHEDULE WINDOW and leave a complete, sanitized audit
-- record for every scheduled or catch-up evaluation.
--
-- ── Why `window_id` is UNIQUE, and why that is the whole design ────────────
--
-- The workflow's spec demands, in one clause each: only one execution may own
-- a schedule window; concurrent workers must not double-mutate the Stack for
-- one window; a restart must not rerun a completed window; catch-up must not
-- duplicate a completed run. All four are the same database fact: an
-- INSERT .. ON CONFLICT (window_id) DO NOTHING that returns no row confers no
-- ownership. The window id is the scheduled UTC midnight in ISO form
-- ("2026-08-28T00:00:00.000Z"), so the identity is derivable from the clock
-- alone and identical across processes and restarts.
--
-- ── Why a `running` row can be TAKEN OVER but never simply rerun ───────────
--
-- A worker that died mid-run may have died AFTER sending the Indexify
-- mutation. Rerunning the window could double-mutate; abandoning it would
-- leave the window forever unowned. The workflow therefore reclaims a
-- `running` row only after Z500_STALE_RUNNING_TAKEOVER_MS, and the takeover
-- performs RECONCILIATION ONLY (read allocation + version history, compare
-- against the desired allocation persisted in `record`) — it never sends a
-- second mutation. `takeover_count` records how often that happened.
--
-- ── Column notes ───────────────────────────────────────────────────────────
--
--   trigger_type  - 'scheduled' when claimed within the on-time tolerance of
--                   the window start; 'catch-up' otherwise (restart/downtime).
--   status        - 'running' | 'succeeded' | 'failed'. Two terminal states
--                   only: "no change was needed" is a SUCCESS (outcome says
--                   why), and every fail-closed branch is a FAILURE with the
--                   stack untouched.
--   outcome       - the one-word why for either terminal state. CHECKed so a
--                   typo cannot invent a vocabulary member downstream
--                   dashboards have never seen.
--   record        - the full sanitized audit record (source snapshot
--                   metadata, ranked/selected/excluded mints with reasons,
--                   previous/desired allocations, mutation + reconciliation
--                   details, versions). JSONB because its shape grows with
--                   the workflow; the columns above are the queryable spine.
--                   The Indexify API key never appears here - the writer
--                   sanitizes every error string before persisting.

CREATE TABLE IF NOT EXISTS z500_sync_runs (
  id               BIGSERIAL PRIMARY KEY,
  window_id        TEXT NOT NULL UNIQUE,
  scheduled_at     TIMESTAMPTZ NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  trigger_type     TEXT NOT NULL CHECK (trigger_type IN ('scheduled', 'catch-up')),
  status           TEXT NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running', 'succeeded', 'failed')),
  outcome          TEXT
                     CHECK (outcome IS NULL OR outcome IN (
                       'allocation_updated',
                       'no_change_needed',
                       'reconciled_already_applied',
                       'source_unavailable',
                       'source_stale',
                       'source_invalid',
                       'insufficient_eligible_tokens',
                       'indexify_unavailable',
                       'mutation_rejected',
                       'mutation_unresolved',
                       'takeover_unresolved',
                       'internal_error'
                     )),
  takeover_count   INTEGER NOT NULL DEFAULT 0,
  record           JSONB NOT NULL DEFAULT '{}'::jsonb,
  error            TEXT
);

-- The tick asks "is the current window done?" every few minutes; the UNIQUE
-- index on window_id already serves that lookup. This partial index serves
-- the takeover sweep's "stale running rows" question without scanning
-- terminal history.
CREATE INDEX IF NOT EXISTS idx_z500_sync_runs_running
  ON z500_sync_runs (started_at)
  WHERE status = 'running';
