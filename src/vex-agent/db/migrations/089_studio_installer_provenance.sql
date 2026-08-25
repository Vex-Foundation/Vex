-- 089_studio_installer_provenance.sql - Vex Studio installer provenance (A5b)
--
-- RUNS AFTER 088.
--
-- WHY THIS EXISTS. The Studio installer writes files into a folder the user
-- also owns, and it must be able to answer one question before every write:
-- "is the thing currently sitting at the Vex path something VEX wrote?" A
-- marker inside the file cannot answer it for a JSON server entry (there is
-- nowhere to put one that is not also user-editable), and trusting the shape of
-- the entry would mean any tool that happened to write `mcpServers.vex` could
-- have its config silently replaced. So the answer lives here, in privileged
-- main-process storage the user's editor cannot reach.
--
-- WHAT PROVENANCE PROVES, AND WHAT IT DOES NOT.
--   * `entry_hash` is the digest of the Vex-owned REGION Vex last wrote (the
--     server entry, or the managed-block body). It proves ownership: an entry
--     whose digest matches is ours to rewrite, and one that does not match is a
--     COLLISION that refuses with a report rather than a clobber.
--   * `content_hash` is the digest of the WHOLE file as Vex left it. It answers
--     the different question of whether anything moved underneath us, and it is
--     what the optimistic pre-replacement check compares against.
--   * Neither authorizes DELETION of a file. A5 never deletes files; a
--     deselected agent has its ENTRY removed from a file that stays.
--
-- COMMITTED PER FILE, DELIBERATELY. A reconciliation run writes several files.
-- Each successful replacement commits its own provenance row immediately, so a
-- run that dies after the third file leaves three proven rows and a Repair
-- completes the rest instead of re-colliding with Vex's own writes.
--
-- CHANGE NOTES are the user-visible half of the same record: the bounded log
-- the `AGENTS.md` managed block renders. They live here rather than being
-- parsed back out of the file because the file is the OUTPUT - reading a
-- generated artifact to learn what to generate would make a user's edit inside
-- the block change what Vex believes its own history was.

-- ── projects: what the last COMPLETE reconciliation covered ───────────────
-- `generator_version` already exists (migration 085, never written until now)
-- and becomes the generator FINGERPRINT: the Vex version plus the installer
-- revision. A row whose fingerprint differs from the running build's has files
-- that predate this build and is owed a regeneration even if its scope never
-- moved. Both columns are advanced ONLY after a run that reconciled every
-- artifact of the scope it reloaded.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS last_rendered_scope_version INTEGER;

-- ── project_file_provenance ──────────────────────────────────────────────
-- One row per (project, artifact). `artifact_key` is the installer's stable
-- identifier for the artifact - `agent:codex`, `agents-md`, `claude-md`,
-- `protocols-doc` - and NOT a path: the path is derived from the registry and
-- can change with a client's schema, while the identity of "Codex's config"
-- does not.
CREATE TABLE IF NOT EXISTS project_file_provenance (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  artifact_key TEXT NOT NULL,
  -- Repo-relative POSIX path Vex wrote, recorded for reporting and for
  -- detecting that the registry moved an artifact to a new file.
  relative_path TEXT NOT NULL,
  -- Digest of the Vex-owned region. NULL only for artifacts that own no region
  -- inside a larger file.
  entry_hash TEXT,
  -- Digest of the whole file as Vex left it.
  content_hash TEXT NOT NULL,
  written_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, artifact_key)
);

-- ── project_change_notes ─────────────────────────────────────────────────
-- The rolling log rendered into the managed block. Bounded by the application
-- (`STUDIO_CHANGE_NOTE_LIMIT`) rather than by a constraint: the bound is
-- product copy that ships with the renderer, and a migration per bound change
-- would be ceremony with no safety gain.
CREATE TABLE IF NOT EXISTS project_change_notes (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The Vex version that wrote the note.
  version TEXT NOT NULL,
  -- Calendar date shown to a human, `YYYY-MM-DD`.
  note_date TEXT NOT NULL,
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 400),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_change_notes_project
  ON project_change_notes(project_id, id DESC);
