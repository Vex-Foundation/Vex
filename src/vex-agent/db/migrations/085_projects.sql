-- 085_projects.sql - Vex Studio project entity (stage P)
--
-- RUNS AFTER 084.
--
-- WHAT THIS ADDS. A Vex Studio project is a folder under the projects root plus
-- ONE backing `sessions` row. There is no new session kind and no new session
-- mode: the backing row is an ordinary `mode = 'agent'` session carrying
-- `scope = 'vex_studio'`, so every agent-mode read in the app (which filters
-- `scope = 'vex_app'`) keeps ignoring it, while every gate keyed by session id
-- (approvals, wallet scope, permission) sees a normal session.
--
-- OWNERSHIP AND AUTHORITY.
--   * `projects` owns Studio semantics: name, slug, relative root path,
--     permission, agent id list, scope version.
--   * `project_wallets` is AUTHORITATIVE for a project's wallet selection. The
--     backing session's four `selected_*_wallet_*` columns are a COMPATIBILITY
--     MIRROR, written in the same transaction so session-keyed consumers agree
--     with the project. A reader that needs the truth reads `project_wallets`.
--   * `studio_settings.projects_root` records the realpath of the projects root
--     at first project creation. Every later projects operation asserts the
--     configured root still equals it and fails closed otherwise; moving the
--     root is a separate, explicit workflow, not an implicit re-home.
--
-- IMMUTABILITY. `root_path` is relative to the projects root and equals the
-- slug. It is immutable, enforced in the app layer (vex-app
-- `src/main/database/projects/*`) rather than by a column constraint, because a
-- future explicit root-migration workflow must be able to rewrite it under its
-- own transaction.
--
-- AGENT IDS. `agents` is a closed list validated at the IPC boundary
-- (`shared/schemas/projects.ts` STUDIO_AGENT_IDS), deliberately NOT a CHECK
-- constraint: the roster of supported coding agents changes on product time,
-- and a migration per new agent id would be ceremony with no safety gain. The
-- database only guarantees the column is a text array.

-- ── studio_settings: single row, the projects-root anchor ──────────────────
CREATE TABLE IF NOT EXISTS studio_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  projects_root TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── projects ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  -- Same id scheme as `sessions`: a main-minted UUID stored as TEXT.
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- Relative to `studio_settings.projects_root`, equals `slug`, immutable.
  root_path TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('restricted', 'full')),
  backing_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  agents TEXT[] NOT NULL DEFAULT '{}',
  -- Monotonic optimistic-concurrency token for scope edits. An approval
  -- enqueued under version N is refused at commit when the project has moved on.
  scope_version INTEGER NOT NULL DEFAULT 1 CHECK (scope_version >= 1),
  generator_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_backing_session ON projects(backing_session_id);

-- ── project_wallets: authoritative per-family selection ───────────────────
-- Exactly one row per family is written by the create path. A row with both
-- columns NULL means "no selection for this family" and is NOT the same as a
-- missing row: the create path always writes both families, so a missing row
-- is a corrupt project, not an unselected wallet.
--
-- Same atomicity rule as migration 026: the wallet id and the address snapshot
-- are either both present or both absent. The non-reusable id makes a removed
-- wallet unresolvable (fail closed); the address pins the choice so a force
-- re-import under the same id is detected as drift instead of silently signing
-- with a new key.
CREATE TABLE IF NOT EXISTS project_wallets (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  family TEXT NOT NULL CHECK (family IN ('evm', 'solana')),
  wallet_id TEXT,
  address TEXT,
  PRIMARY KEY (project_id, family),
  CONSTRAINT chk_project_wallets_atomic CHECK (
    (wallet_id IS NULL AND address IS NULL)
    OR (wallet_id IS NOT NULL AND address IS NOT NULL)
  )
);
