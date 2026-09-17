-- Desk approvals: a THIRD origin for approval_intents.
--
-- A `desk` row is enqueued by the Lighter desk's own buttons (Long/Short,
-- Close, Cancel) with no model turn in front of it. Main prepares the exact
-- same Lighter intent the agent lane would (the tool handlers own every order
-- rule), the user confirms the same card, and main dispatches the same
-- follow-up tool. What differs is the side effects of the decision: a desk row
-- has no transcript to append a tool result to and no turn to resume, so it
-- settles on the row alone (`execution_status` + `execution_result_hash`) and
-- the desk reads the outcome from the approve reply.
--
-- Every row written before this migration keeps `origin = 'agent'`.

ALTER TABLE approval_intents
  DROP CONSTRAINT IF EXISTS approval_intents_origin_check;

ALTER TABLE approval_intents
  ADD CONSTRAINT approval_intents_origin_check
    CHECK (origin IN ('agent', 'studio_mcp', 'desk'));
