-- SESSIONS: the chat session's own model (F06, per-session model picker).
--
-- WHY THIS EXISTS. Every session ran the one global model (`AGENT_MODEL`).
-- The composer now lets the operator pick a model per session, and the pick
-- has to reach the turns nobody typed (wake continuations of a
-- Full-Autonomous session, approval and launch-form resumes), which have no
-- composer to ask. So it lives on the session row, the way the reasoning
-- effort does (migration 174).
--
-- model_provider    the inference backend the pick was made under:
--                   `openrouter` (bring your own key) or `vexcloud` (Vex
--                   Inference). No value list here on purpose: the app
--                   validates it, so a later backend needs no migration. A
--                   pick made under one backend is not used while the other
--                   is active; that turn runs on the default model and says
--                   so.
-- model_id          the catalogue model id, e.g. `anthropic/claude-sonnet-5.5`.
-- model_updated_at  when the operator last picked.
--
-- All three NULL means the operator never picked (every row written before
-- this migration): the session runs on the default model, as before. The
-- three are written together or not at all.
--
-- Mission runs do NOT read these columns: a mission's model is part of its
-- accepted contract (`constraints_json.model`, contract hash v10).
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; the CHECK is added only once.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS model_provider TEXT,
  ADD COLUMN IF NOT EXISTS model_id TEXT,
  ADD COLUMN IF NOT EXISTS model_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_model_pair_chk'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_model_pair_chk
      CHECK (
        (model_provider IS NULL AND model_id IS NULL AND model_updated_at IS NULL)
        OR (
          model_provider IS NOT NULL
          AND model_id IS NOT NULL
          AND model_updated_at IS NOT NULL
          AND char_length(model_provider) BETWEEN 1 AND 32
          AND char_length(model_id) BETWEEN 1 AND 200
        )
      );
  END IF;
END
$$;
