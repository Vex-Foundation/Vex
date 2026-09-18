-- The surface a session belongs to.
--
-- The Lighter desk keeps its own conversations: a trading session carries the
-- desk's market context and its order previews, and listing it between the
-- agent shell's sessions would put trade-review turns in a rail that has no
-- desk to act on them. NULL is the agent shell (every row written before this
-- migration), 'lighter' is the desk. The value is set once at create time and
-- never rewritten: a session does not move between surfaces.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS workspace TEXT
  CHECK (workspace IS NULL OR workspace IN ('lighter'));

CREATE INDEX IF NOT EXISTS sessions_workspace_live
  ON sessions(scope, workspace, started_at DESC)
  WHERE deleted_at IS NULL;
