-- 097: Vex Studio project SOFT DELETE (stage B0).
--
-- WHY A TOMBSTONE AND NOT A DELETE
--
-- A hard `DELETE FROM projects` is not available here, and that is a property
-- of the schema rather than a preference:
--
--   * `approval_intents.project_id` references `projects(id)` with NO `ON
--     DELETE` action (migration 086, deliberately). The record that an external
--     agent asked Vex to move funds is exactly what must not vanish with the
--     project, so while any audit row points at a project, the delete raises a
--     foreign-key violation. A live test in the Studio lane asserts this.
--   * `approval_intents.session_id` IS `ON DELETE CASCADE` on `sessions`. So
--     hard-deleting the project's backing session - the obvious way to "finish
--     the job" - would cascade away the very refusal rows 086 preserves.
--   * Sessions are never hard-deleted anywhere in this app
--     (`main/database/sessions/delete.ts`); they are tombstoned.
--
-- So deletion is a tombstone, and every authority gate reads active-only.
--
-- THE CLEANUP STATE MACHINE
--
-- Removing a project's installed artifacts (and, when the user asked, trashing
-- its folder) happens AFTER the authority commit and can fail: a file may be
-- locked, a disk full, a trash service unavailable. That work is therefore a
-- DURABLE OBLIGATION carried on the row rather than a best-effort side effect.
--
--   none          - not a tombstone; the column is meaningless for live rows.
--   pending       - tombstoned, artifacts still to be removed, folder kept.
--   trash_pending - tombstoned, artifacts still to be removed, folder to trash.
--   done          - nothing left to do.
--
-- THERE IS DELIBERATELY NO `failed` STATE. A failure leaves the row in
-- `pending`/`trash_pending` with `cleanup_attempts` incremented, because that
-- is the truth: the obligation still stands and something must retry it. A
-- `failed` state would be a place for work to go and be forgotten, and the
-- recovery owners (startup repair, and a repeated delete request) key off
-- "still pending", not off a terminal label.
--
-- `cleanup_last_error` is bounded to 500 characters and holds a REDACTED
-- sentence; provider payloads, stack traces and absolute paths never go here.
--
-- THE SLUG UNIQUENESS MOVES TO A PARTIAL INDEX
--
-- `projects.slug` is unique and doubles as the project's directory name under
-- the projects root. A tombstone must not hold its slug hostage forever, or a
-- user could never recreate a project by the same name. So the table-wide
-- UNIQUE is replaced by a UNIQUE INDEX over ACTIVE rows only.
--
-- The constraint's name was VERIFIED against a live schema rather than assumed:
-- `slug TEXT NOT NULL UNIQUE` in migration 085 is an inline unnamed constraint,
-- and `pg_constraint` reports PostgreSQL's generated name `projects_slug_key`.
-- The drop is still `IF EXISTS` so a re-run is a no-op.
--
-- Recreating a slug whose tombstone has NOT finished cleaning up is refused in
-- the app layer with `projects.slug_cleanup_pending`: the remover still owns
-- that directory, and racing it for the filesystem is how you delete the new
-- project's files instead of the old one's.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS cleanup_state TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS cleanup_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cleanup_last_error TEXT NULL;

-- CHECKs added by name, idempotently: `ADD COLUMN IF NOT EXISTS` skips the
-- whole clause when the column already exists, so an inline CHECK would be
-- silently absent on a re-run. Same pattern as migration 092.
--
-- Each existence check is scoped with `conrelid = 'projects'::regclass`, the
-- same way migration 092 scopes its own. `pg_constraint.conname` is unique per
-- TABLE, not per database, so an unscoped lookup finds a same-named constraint
-- on any other relation and then skips adding this one - leaving the table
-- silently unconstrained. The scoped predicate asks the question that was
-- actually meant: does THIS table already carry it?
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'projects_cleanup_state_check'
       AND conrelid = 'projects'::regclass
  ) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_cleanup_state_check
      CHECK (cleanup_state IN ('none', 'pending', 'trash_pending', 'done'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'projects_cleanup_attempts_check'
       AND conrelid = 'projects'::regclass
  ) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_cleanup_attempts_check
      CHECK (cleanup_attempts >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'projects_cleanup_last_error_check'
       AND conrelid = 'projects'::regclass
  ) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_cleanup_last_error_check
      CHECK (cleanup_last_error IS NULL OR char_length(cleanup_last_error) <= 500);
  END IF;

  -- THE PAIR CONSTRAINT: the tombstone and the cleanup state are ONE fact, and
  -- the database is where that is enforced rather than only in the writers.
  --
  --   * a LIVE row (`deleted_at IS NULL`) is `none`. The column is meaningless
  --     for a live project, and a live row carrying `pending` would be picked up
  --     by the startup cleanup sweep and have its installed artifacts torn out
  --     from under a project the user still has open.
  --   * a TOMBSTONE is never `none`. `none` on a tombstone reads as "nothing was
  --     ever owed", so the sweep would skip it and the project's AGENTS.md block
  --     would keep claiming live Vex authority forever.
  --
  -- Both directions are the invariant the delete path already maintains; this
  -- makes a future writer that forgets one half fail loudly at the write instead
  -- of quietly at the sweep. Pre-existing rows satisfy it: they are all live and
  -- all default to 'none'.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'projects_cleanup_state_tombstone_check'
       AND conrelid = 'projects'::regclass
  ) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_cleanup_state_tombstone_check
      CHECK (
        (deleted_at IS NULL AND cleanup_state = 'none')
        OR (deleted_at IS NOT NULL AND cleanup_state <> 'none')
      );
  END IF;
END
$$;

-- Slug uniqueness over ACTIVE projects only.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_slug_key;

CREATE UNIQUE INDEX IF NOT EXISTS projects_slug_active_key
  ON projects (slug)
  WHERE deleted_at IS NULL;

-- Every list and gate reads active rows; the tombstone sweep reads unfinished
-- cleanups. Both are served here, and the partial predicate keeps the index
-- proportional to the work outstanding rather than to the table.
CREATE INDEX IF NOT EXISTS idx_projects_active
  ON projects (created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_projects_cleanup_outstanding
  ON projects (deleted_at)
  WHERE cleanup_state IN ('pending', 'trash_pending');
