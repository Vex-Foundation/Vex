-- Durable owner for a lock/quit refusal sweep that did not finish.
--
-- The dispatch generation and the pending cause are written in one UPDATE.
-- A process crash can therefore lose neither the fence nor the reason still
-- owed to pending Studio approvals. Startup repairs this row before readiness.

ALTER TABLE studio_runtime_gate
  ADD COLUMN IF NOT EXISTS pending_refusal_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS pending_refusal_since TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
     FROM pg_constraint
     WHERE conname = 'studio_runtime_gate_pending_refusal_reason_check'
       AND conrelid = 'studio_runtime_gate'::regclass
  ) THEN
    ALTER TABLE studio_runtime_gate
      ADD CONSTRAINT studio_runtime_gate_pending_refusal_reason_check
      CHECK (pending_refusal_reason IS NULL OR pending_refusal_reason IN ('lock', 'vex_quit'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
     FROM pg_constraint
     WHERE conname = 'studio_runtime_gate_pending_refusal_pair_check'
       AND conrelid = 'studio_runtime_gate'::regclass
  ) THEN
    ALTER TABLE studio_runtime_gate
      ADD CONSTRAINT studio_runtime_gate_pending_refusal_pair_check
      CHECK (
        (pending_refusal_reason IS NULL AND pending_refusal_since IS NULL)
        OR
        (pending_refusal_reason IS NOT NULL AND pending_refusal_since IS NOT NULL)
      );
  END IF;
END $$;
