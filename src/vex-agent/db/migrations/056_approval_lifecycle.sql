-- Approval lifecycle columns on approval_intents (HERMES wave 1, 2026-07-28).
--
-- Why a NEW numbered file rather than an edit of 024: the runner applies only
-- `version > MAX(schema_version)` (src/lib/db/migrate-runner.ts
-- listPendingMigrations), so editing 024 would be invisible to every
-- already-initialized database. Forward-only, idempotent, no backfill.
-- Mirrored byte-identically into vex-app/resources/migrations/ by
-- vex-app/scripts/copy-migrations.mjs (wired into prebuild/predev).
--
-- The four new columns close the approval-resume holes:
--
--   `dispatch_started_at`  — stamped by the CAS `not_started -> dispatching`.
--                            The reconciler needs a DB-visible age for a
--                            dispatch that may have crashed mid-flight. It is
--                            an INPUT to the staleness decision, never the
--                            whole decision: a live runner lease always wins
--                            (a heartbeated lease legitimately outlives any
--                            fixed age).
--
--   `result_message_id`    — the `messages.id` of the tool-result row, written
--                            in the SAME transaction as that row. This makes
--                            "execution succeeded but no tool result exists"
--                            unrepresentable, and it is half of the durable
--                            pending-resume predicate.
--
--   `resumed_at`           — attempt audit ONLY. Stamped when a resume is
--                            attempted. It is NEVER a gate: a crash after
--                            stamping but before the lease-held core started
--                            consuming must still recover.
--
--   `resume_consumed_at`   — the COMPLETION marker, and the ONLY thing that
--                            ends resume eligibility. Written ONCE, after the
--                            resumed turn core has durably returned and while
--                            its lease is still held. Eligible pending resume
--                            is `result_message_id IS NOT NULL AND
--                            resume_consumed_at IS NULL`.
--
--                            A START marker here is the bug this column has
--                            already grown twice: stamping when a resume
--                            BEGINS makes every crash between the stamp and
--                            the end of the turn permanent — the row leaves
--                            every scan while the agent was never woken, and
--                            nothing reconciles it again. Concurrency is NOT
--                            this column's job: two simultaneous resumes are
--                            impossible because every resume path holds the
--                            session/run runner lease end-to-end. This column
--                            answers only "has a resume already finished?",
--                            which is what stops a LATER pass from waking the
--                            agent for a result it has already observed.
--
--   `resume_cue_message_id`— `messages.id` of the `approval_resolved` engine
--                            cue, written in the SAME transaction as that row.
--                            The cue is a prompt-contract artifact announcing
--                            that a pending approval resolved, so a second copy
--                            after a partial turn would tell the model a second
--                            approval had resolved when none had. Because
--                            eligibility now ends at
--                            completion, an approval can legitimately be
--                            attempted more than once; binding the cue to the
--                            approval makes it exactly-once regardless of how
--                            many attempts run. Same shape as
--                            `result_message_id` above — the id and the row it
--                            names commit together, so "cue recorded but no
--                            cue in the transcript" is unrepresentable.
--
-- `execution_status` gains 'indeterminate': the honest terminal state for an
-- approved dispatch whose outcome cannot be proven (process died between the
-- `dispatching` mark and the result commit). Recovery must NEVER re-dispatch an
-- approved money-path tool, so the outcome is reported as unknown — not as
-- success and not as failure.

ALTER TABLE approval_intents ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ;
ALTER TABLE approval_intents ADD COLUMN IF NOT EXISTS result_message_id INTEGER;
ALTER TABLE approval_intents ADD COLUMN IF NOT EXISTS resumed_at TIMESTAMPTZ;
ALTER TABLE approval_intents ADD COLUMN IF NOT EXISTS resume_consumed_at TIMESTAMPTZ;
ALTER TABLE approval_intents ADD COLUMN IF NOT EXISTS resume_cue_message_id INTEGER;

-- Widen the execution_status CHECK to admit 'indeterminate'. DROP ... IF EXISTS
-- before ADD keeps the pair idempotent under re-run; the constraint name is the
-- Postgres default for the inline column CHECK created in migration 024.
ALTER TABLE approval_intents
  DROP CONSTRAINT IF EXISTS approval_intents_execution_status_check;
ALTER TABLE approval_intents
  ADD CONSTRAINT approval_intents_execution_status_check CHECK (
    execution_status IN (
      'not_started', 'dispatching', 'succeeded', 'failed', 'indeterminate'
    )
  );

-- Durable deferred-resume lookup (end-of-turn hook + reconciler pass): the
-- partial predicate matches the eligibility rule exactly, so the index stays
-- tiny — rows leave it permanently once consumed.
CREATE INDEX IF NOT EXISTS idx_approval_intents_pending_resume
  ON approval_intents (session_id)
  WHERE result_message_id IS NOT NULL AND resume_consumed_at IS NULL;

-- Reconciler scan for decided-but-incomplete executions. Also partial: a
-- settled approval (succeeded/failed/indeterminate) drops out for good.
CREATE INDEX IF NOT EXISTS idx_approval_intents_incomplete_execution
  ON approval_intents (decided_at)
  WHERE decision = 'approved'
    AND execution_status IN ('not_started', 'dispatching');
