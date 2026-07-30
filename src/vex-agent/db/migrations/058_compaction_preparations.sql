-- Compaction preparations — outbox FSM for the runtime-automatic background
-- compaction of a live session (compaction v2, contracts C1-C5/C10).
--
-- WHAT THIS TABLE IS. At the warning band the runtime forks TWO independent
-- background branches off one frozen conversation prefix:
--   Branch A (`summary_*`) — a new rolling session summary. Readiness of the
--     whole preparation == branch A succeeded.
--   Branch B (`chunks_*`)  — narrative memory chunks for `session_memories`.
-- They are two SEPARATE workers with two SEPARATE leases, retry budgets and
-- heartbeats. There is deliberately NO shared lease column: branch B may still
-- be running (and is still allowed to land rows) long after the row itself has
-- reached `applied` or `superseded`.
--
-- ROW FSM (`status`):
--   preparing → summary_ready → apply_requested → applying → applied
--   preparing | summary_ready                              → failed
--   preparing | summary_ready                              → superseded
--   apply_requested | applying                             → failed
--   applying                                               → apply_requested
-- Superseding `apply_requested`/`applying` is FORBIDDEN (C3): once a cutover is
-- requested it either applies or terminalizes.
--
-- DURABLE TWO-PHASE APPLY (frozen design). The cutover spans two transactions:
--   Tx A commits `apply_requested → applying`, preserving `apply_source` and
--     stamping `apply_locked_by` (the runner lease that owns the cutover).
--   Tx B re-acquires the full lock order (session advisory lock → queued-stop
--     gate → sessions row → this row → money rows), re-checks the stop gate,
--     evaluates the money gate, performs the cutover and commits `applied`
--     together with the `sessions.checkpoint_generation` bump.
--   A pre-cutover crash or deferral returns the row to `apply_requested` —
--     NEVER to `summary_ready`. The request survives; only the attempt is lost.
--   Stale recovery discriminates the two sides of Tx B's COMMIT by the ONLY
--     safe signal: `sessions.checkpoint_generation = target_checkpoint_generation`
--     means the cutover committed → `applied`; anything else means it did not →
--     `apply_requested`. Never infer from timestamps.
--   A generation conflict or an otherwise invalid preparation becomes terminal
--     `failed` — an eternal `apply_requested` row is a parked session.
--
-- IMMUTABLE CORPUS (C2). `corpus_text` + `corpus_sha256` + `corpus_format_version`
-- are written ONCE, at fork time, under the caller's `sessions ... FOR UPDATE`.
-- The corpus is TEXT, not JSONB, on purpose: JSONB normalizes/reorders object
-- keys on read, which would silently break the sha256 determinism fingerprint
-- that both branches and EVERY retry rely on to prove they read the same bytes.
-- `corpus_text` is NULLABLE only because of retention (below) — a live row
-- always has it.
--
-- RETENTION. Every preparation carries a full transcript copy, so the corpus is
-- pruned (column nulled, `corpus_pruned_at` stamped, all audit columns kept) as
-- soon as it can no longer be needed. That requires BOTH the row and branch B to
-- be terminal, and the crossing can happen in either order, so the prune runs
-- atomically at BOTH: when the row terminalizes while branch B is already
-- terminal, and when branch B terminalizes while the row already is.
--
-- BRANCH-B FREEZE BARRIER (C5). `chunks_frozen_output` holds the COMPLETE
-- insert-ready snapshot — including the server-generated outstanding-item ids
-- and timestamps and the pinned `body_md` schema version — persisted BEFORE any
-- `session_memories` insert. Freezing only the model's texts would NOT be
-- deterministic, because the render step generates fresh UUIDs/timestamps. Every
-- crash retry re-inserts exactly that snapshot through the existing
-- `(session_id, content_hash)` active-row upsert; there is no delete-then-insert
-- path and no second LLM call. `chunks_status = 'frozen'` is therefore an
-- INSERT-ONLY tail phase: it is claimed by heartbeat-lease only, it never
-- increments `chunks_attempt_count`, and "attempt 3 → freeze → crash" stays
-- retryable forever.
--
-- CHUNK ACCOUNTING SPANS THE FREEZE BARRIER, so the counters do too, and each
-- names its phase:
--   `chunks_rejected_by_exclusion_at_freeze` / `..._by_redaction_at_freeze`
--       what Branch B discarded BEFORE freezing — live-state exclusion and
--       output-side redaction. Successor of `compact_jobs.chunks_rejected_by_*`.
--       Written once, by the freeze step.
--   `chunks_inserted` / `chunks_deduped`
--       the INSERT phase outcome. Nothing is rejected at insert: the snapshot
--       was already validated and redacted, so a chunk that does not become a
--       new row was collapsed by the `(session_id, content_hash)` active-row
--       upsert onto an identical existing memory.
-- Reading a freeze counter as an insert counter (or the reverse) misattributes
-- where the memories went, which is the whole reason the phase is in the name.
--
-- Audit columns hold provider/model NAMES and cost only. No secrets, no keys,
-- no prompt bodies.

CREATE TABLE IF NOT EXISTS compaction_preparations (
  id                           SERIAL PRIMARY KEY,
  session_id                   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

  status                       TEXT NOT NULL DEFAULT 'preparing'
    CHECK (status IN ('preparing','summary_ready','apply_requested','applying',
                      'applied','failed','superseded')),

  -- ── C1/C2 immutable fork-time input (written once, under the sessions lock)
  -- `watermark_message_id` is the MAX live message id in the locked row set —
  -- NOT `source_end_message_id` (that name belongs to compact_jobs and means the
  -- post-hoc archive range).
  watermark_message_id         INTEGER NOT NULL,
  base_checkpoint_generation   INTEGER NOT NULL,
  target_checkpoint_generation INTEGER NOT NULL
    CHECK (target_checkpoint_generation = base_checkpoint_generation + 1),
  -- Pre-fork `sessions.summary`. NULL = the session had none. Branch A REPLACES
  -- the rolling summary, so without this earlier compacted history is lost.
  frozen_session_summary       TEXT,
  corpus_text                  TEXT,
  corpus_sha256                CHAR(64) NOT NULL,
  corpus_format_version        INTEGER NOT NULL,
  corpus_message_count         INTEGER NOT NULL,
  corpus_bytes                 INTEGER NOT NULL,
  corpus_redaction_hard        INTEGER NOT NULL DEFAULT 0,
  corpus_redaction_mask        INTEGER NOT NULL DEFAULT 0,
  corpus_pruned_at             TIMESTAMPTZ,

  -- ── Branch A (summary) — own lease, own retry budget
  summary_status               TEXT NOT NULL DEFAULT 'pending'
    CHECK (summary_status IN ('pending','running','succeeded','failed','permanently_failed')),
  summary_attempt_count        INTEGER NOT NULL DEFAULT 0,
  summary_max_attempts         INTEGER NOT NULL DEFAULT 3,
  summary_next_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  summary_locked_at            TIMESTAMPTZ,
  summary_locked_by            TEXT,
  summary_heartbeat_at         TIMESTAMPTZ,
  summary_last_error           TEXT,
  summary_output               TEXT,
  summary_prompt_version       TEXT,
  summary_provider             TEXT,
  summary_model                TEXT,
  summary_completed_at         TIMESTAMPTZ,
  summary_cost_usd             NUMERIC(10,4),

  -- ── Branch B (chunks) — own lease, own retry budget, insert-only tail
  chunks_status                TEXT NOT NULL DEFAULT 'pending'
    CHECK (chunks_status IN ('pending','running','frozen','succeeded','failed','permanently_failed')),
  chunks_attempt_count         INTEGER NOT NULL DEFAULT 0,
  chunks_max_attempts          INTEGER NOT NULL DEFAULT 3,
  chunks_next_attempt_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  chunks_locked_at             TIMESTAMPTZ,
  chunks_locked_by             TEXT,
  chunks_heartbeat_at          TIMESTAMPTZ,
  chunks_last_error            TEXT,
  chunks_frozen_output         JSONB
    CHECK (chunks_frozen_output IS NULL OR jsonb_typeof(chunks_frozen_output) = 'object'),
  chunks_frozen_output_sha256  CHAR(64),
  chunks_frozen_at             TIMESTAMPTZ,
  -- TWO PHASES, TWO SETS OF COUNTERS. The `_at_freeze` suffix is load-bearing:
  -- these count what Branch B's processing DISCARDED while building the
  -- snapshot (live-state exclusion, output-side redaction), which is the
  -- successor of `compact_jobs.chunks_rejected_by_*` and answers "why did this
  -- compaction produce so few memories?".
  chunks_rejected_by_exclusion_at_freeze INTEGER NOT NULL DEFAULT 0,
  chunks_rejected_by_redaction_at_freeze INTEGER NOT NULL DEFAULT 0,
  -- Insert-phase outcome. Nothing is rejected here — the snapshot was already
  -- validated and redacted before it was frozen — so the only thing the insert
  -- can lose is a chunk the existing `(session_id, content_hash)` active-row
  -- upsert collapsed into a row that already existed.
  chunks_inserted              INTEGER NOT NULL DEFAULT 0,
  chunks_deduped               INTEGER NOT NULL DEFAULT 0,
  chunks_landed_after_supersession BOOLEAN NOT NULL DEFAULT FALSE,
  chunks_provider              TEXT,
  chunks_model                 TEXT,
  chunks_completed_at          TIMESTAMPTZ,
  chunks_cost_usd              NUMERIC(10,4),

  -- ── Apply audit
  apply_source                 TEXT
    CHECK (apply_source IS NULL OR apply_source IN
             ('ui_button','agent_tool','auto_full_autonomous','forced_critical')),
  apply_requested_at           TIMESTAMPTZ,
  apply_started_at             TIMESTAMPTZ,
  apply_locked_by              TEXT,
  apply_heartbeat_at           TIMESTAMPTZ,
  apply_attempt_count          INTEGER NOT NULL DEFAULT 0,
  -- Money-state findings observed at a `forced_critical` apply: recorded for
  -- audit and then deliberately NOT used as a gate (C7).
  money_gate_bypass_reasons    JSONB
    CHECK (money_gate_bypass_reasons IS NULL
           OR jsonb_typeof(money_gate_bypass_reasons) = 'array'),
  applied_generation           INTEGER,
  applied_at                   TIMESTAMPTZ,
  superseded_by_id             INTEGER REFERENCES compaction_preparations(id) ON DELETE SET NULL,
  last_error                   TEXT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at                 TIMESTAMPTZ,

  -- ── Invariants that encode C2/C5 in the schema itself
  -- The corpus is only ever absent because retention pruned it.
  CONSTRAINT cprep_corpus_present_unless_pruned
    CHECK (corpus_text IS NOT NULL OR corpus_pruned_at IS NOT NULL),
  -- Branch A cannot be `succeeded` without an output, and the row cannot claim
  -- readiness (or anything past it) without one either.
  CONSTRAINT cprep_summary_output_present
    CHECK (summary_status <> 'succeeded' OR summary_output IS NOT NULL),
  CONSTRAINT cprep_ready_requires_summary
    CHECK (status NOT IN ('summary_ready','apply_requested','applying','applied')
           OR summary_output IS NOT NULL),
  -- The freeze barrier: no `frozen`/`succeeded` chunks phase without a snapshot.
  CONSTRAINT cprep_frozen_output_present
    CHECK (chunks_status NOT IN ('frozen','succeeded') OR chunks_frozen_output IS NOT NULL),
  -- `applied` always records the generation the cutover actually committed.
  CONSTRAINT cprep_applied_generation_present
    CHECK (status <> 'applied' OR applied_generation IS NOT NULL),
  -- A supersession link exists only on a superseded row, and never self-refers.
  CONSTRAINT cprep_supersession_link_shape
    CHECK (superseded_by_id IS NULL OR status = 'superseded'),
  CONSTRAINT cprep_supersession_not_self
    CHECK (superseded_by_id IS NULL OR superseded_by_id <> id)
);

-- ONE live preparation per session. This partial unique is also the conflict
-- ARBITER used by the fork-time insert (`ON CONFLICT (session_id) WHERE status
-- IN (...) DO NOTHING`), which is why the predicate below and the one in
-- `create.ts` must stay verbatim-identical.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cprep_live_per_session
  ON compaction_preparations(session_id)
  WHERE status IN ('preparing','summary_ready','apply_requested','applying');

-- Branch-A poll: due rows awaiting an LLM attempt.
CREATE INDEX IF NOT EXISTS idx_cprep_summary_due
  ON compaction_preparations(summary_status, summary_next_attempt_at)
  WHERE summary_status IN ('pending','failed');

-- Branch-B poll: due rows awaiting an LLM attempt. `frozen` is NOT here — the
-- insert-only tail has its own claim path with its own index below.
CREATE INDEX IF NOT EXISTS idx_cprep_chunks_due
  ON compaction_preparations(chunks_status, chunks_next_attempt_at)
  WHERE chunks_status IN ('pending','failed');

-- Branch-B insert-only tail: frozen rows whose lease is free or expired.
CREATE INDEX IF NOT EXISTS idx_cprep_chunks_frozen_tail
  ON compaction_preparations(chunks_next_attempt_at, chunks_heartbeat_at)
  WHERE chunks_status = 'frozen';

-- Stale-lease sweeps, one per independent lease.
CREATE INDEX IF NOT EXISTS idx_cprep_summary_running_heartbeat
  ON compaction_preparations(summary_heartbeat_at)
  WHERE summary_status = 'running';

CREATE INDEX IF NOT EXISTS idx_cprep_chunks_running_heartbeat
  ON compaction_preparations(chunks_heartbeat_at)
  WHERE chunks_status = 'running';

CREATE INDEX IF NOT EXISTS idx_cprep_applying_heartbeat
  ON compaction_preparations(apply_heartbeat_at)
  WHERE status = 'applying';

-- UI surface / history read.
CREATE INDEX IF NOT EXISTS idx_cprep_session_created
  ON compaction_preparations(session_id, created_at DESC, id DESC);

COMMENT ON TABLE compaction_preparations IS
  'Compaction v2 outbox FSM. Two INDEPENDENT branch leases (summary_*, chunks_*) — never one shared lease. Corpus columns are write-once at fork time under the sessions row lock; corpus_text is pruned (nulled + corpus_pruned_at) only once BOTH the row and branch B are terminal. Superseding apply_requested/applying is forbidden. Chunk accounting spans the freeze barrier: chunks_rejected_by_*_at_freeze count what Branch B discarded while BUILDING the snapshot, chunks_inserted/chunks_deduped are the INSERT outcome (nothing is rejected at insert — the snapshot was already validated and redacted). chunks_frozen_output is the complete insert-ready snapshot persisted BEFORE any session_memories insert; chunks_status=frozen is an insert-only tail that never re-runs the LLM and never increments chunks_attempt_count. Apply is two-phase: Tx A commits applying, Tx B commits applied with the generation bump; pre-cutover crash returns to apply_requested and stale recovery discriminates solely by sessions.checkpoint_generation = target_checkpoint_generation.';
