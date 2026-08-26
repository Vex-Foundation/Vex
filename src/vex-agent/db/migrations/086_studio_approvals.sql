-- 086_studio_approvals.sql - Vex Studio approval state machine (stage A3)
--
-- RUNS AFTER 085.
--
-- WHAT THIS ADDS. `approval_intents` gains an ORIGIN. Every row written before
-- this migration, and every row the agent turn loop writes after it, is
-- `origin = 'agent'` and behaves exactly as it always has. A row enqueued by
-- the Vex Studio MCP surface carries `origin = 'studio_mcp'` plus the four
-- facts that make a Studio dispatch decidable at commit time (the project it
-- belongs to, the scope version it was admitted under, the digest of the exact
-- envelope the human approved, and the dispatch generation that was current
-- when it was enqueued), and the two facts that record its outcome (the whole
-- tool result and that result's byte size).
--
-- NO NEW STATE AXIS. `decision` (`approved | rejected | rejected_stop`) and
-- `execution_status` (`not_started | dispatching | succeeded | failed |
-- indeterminate`) already model everything the Studio arm needs. "Expired" is
-- already `rejected` with the expiry reason; a terminal refusal is `rejected`
-- with `refusal_reason` naming which of the six causes fired. Adding
-- `refused`/`settled` states would have created a second spelling of the same
-- fact.
--
-- WHY `project_id` HAS NO CASCADE. A deleted project must leave a REFUSED
-- AUDIT ROW behind, never a vanished one: the row is the record that an
-- external agent asked Vex to move funds and was told no. Project deletion is
-- a later stage and refuses the project's pending intents first, deletes
-- second.
--
-- WHY `session_id` STAYS NOT NULL. A Studio intent carries its project's
-- BACKING SESSION id. That id is what keys the session control lock, so every
-- A3 transaction can take the same lock the agent paths take, in the same
-- global order, and the two can never form a cycle.
--
-- SETTLEMENT IS WHOLE. `settlement` stores the complete `ToolResult` of the
-- dispatched call, output included, with no ceiling and no cut; the codec
-- (`engine/core/approval-runtime/studio/settlement-codec.ts`) is the one owner
-- of the JSON-safe projection and `settlement_bytes` records the size of the
-- body actually stored. The equality of the two is proven by the codec test,
-- not by a constraint, because a constraint cannot see the serialized body.

ALTER TABLE approval_intents
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'agent'
    CHECK (origin IN ('agent', 'studio_mcp')),
  -- NO `ON DELETE` action on purpose: see the header.
  ADD COLUMN IF NOT EXISTS project_id TEXT NULL REFERENCES projects(id),
  ADD COLUMN IF NOT EXISTS scope_version_at_enqueue INTEGER NULL,
  ADD COLUMN IF NOT EXISTS request_digest TEXT NULL,
  ADD COLUMN IF NOT EXISTS dispatch_generation_at_enqueue BIGINT NULL,
  ADD COLUMN IF NOT EXISTS refusal_reason TEXT NULL
    -- Two families, one column. The first six refuse a PENDING intent (an
    -- owner cancelled it before anybody decided). The last four record why an
    -- APPROVED intent never dispatched, or dispatched into an expiry: they are
    -- written by the pre-dispatch refusal CAS and by the expiry path, always
    -- together with the terminal state that makes the row non-approvable.
    CHECK (refusal_reason IN (
      'lock', 'disconnect', 'cancelled',
      'project_deleted', 'scope_changed', 'vex_quit',
      'stopped', 'generation_superseded', 'scope_unavailable', 'expired'
    )),
  ADD COLUMN IF NOT EXISTS settlement JSONB NULL,
  ADD COLUMN IF NOT EXISTS settlement_bytes INTEGER NULL
    CHECK (settlement_bytes >= 0);

-- The refusal sweeps ask exactly one question: "which of this project's Studio
-- intents are still undecided?". A partial index keeps that scan off every
-- agent row in the table.
CREATE INDEX IF NOT EXISTS idx_approval_intents_studio_pending
  ON approval_intents (project_id)
  WHERE origin = 'studio_mcp' AND decision IS NULL;

-- ── studio_runtime_gate: the durable dispatch generation ───────────────────
--
-- An in-memory generation is NOT a linearization point. A continuation can
-- read generation N, await the dispatch-slot CAS, the user locks Vex (scrub +
-- an in-memory invalidate to N+1), and the pending CAS still commits. Putting
-- the generation in a row the slot statement reads under `FOR SHARE` makes a
-- committed slot claim MEAN "dispatch began before the lock": a claim that
-- arrives after the advance commits matches zero rows and is refused.
--
-- Single row by construction (`CHECK (id = 1)`), monotonic by contract: lock
-- and unlock both INCREMENT, so a pre-lock generation is never reused and a
-- pre-lock intent can never be dispatched after a re-unlock without a fresh
-- enqueue.
CREATE TABLE IF NOT EXISTS studio_runtime_gate (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  dispatch_generation BIGINT NOT NULL DEFAULT 1 CHECK (dispatch_generation >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO studio_runtime_gate (id, dispatch_generation)
VALUES (1, 1)
ON CONFLICT (id) DO NOTHING;
