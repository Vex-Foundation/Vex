-- SESSIONS: the chat session's chosen reasoning effort (Kairos E-1).
--
-- WHY THIS EXISTS. The operator picks a reasoning effort per chat session in
-- the composer, but the pick travelled only with the interactive turn that
-- carried it. A turn nobody typed (a wake continuation of a Full-Autonomous
-- session, an approval resume, a launch-form resume) had no pick at all and
-- fell back to the provider's model default, which for some models is a much
-- higher effort than the operator chose. The effort then changed between the
-- operator's turns and the agent's own continuations of the same session.
--
-- `reasoning_effort` is written whenever an interactive chat turn carries a
-- pick, and a turn without one (wake-driven, resumed) uses it instead of the
-- provider default. NULL means the operator never picked (every row written
-- before this migration): those turns keep sending no effort, as before.
--
-- Mission runs do NOT read this column: their effort is part of the accepted
-- mission contract (`constraints_json.reasoningEffort`, contract hash v8).
--
-- IDEMPOTENT: `ADD COLUMN IF NOT EXISTS`; existing rows keep NULL.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS reasoning_effort TEXT
  CHECK (
    reasoning_effort IS NULL
    OR reasoning_effort IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
  );
