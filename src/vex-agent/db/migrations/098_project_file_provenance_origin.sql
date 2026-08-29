-- 098: Vex Studio provenance records HOW Vex came to own an artifact (stage B0).
--
-- WHAT WAS WRONG
--
-- `project_file_provenance` recorded WHAT Vex owns and never HOW it came to own
-- it, and the installer writes rows for two materially different events:
--
--   1. Vex REPLACED the bytes. It rendered an entry, an import line or a
--      generated document and wrote it to disk. Those bytes are Vex's own
--      output and nobody else's.
--   2. Vex ADOPTED bytes that were ALREADY THERE. The reconciler finalizes an
--      artifact whose existing content is byte-for-byte what a fresh render
--      produces, so that a write whose provenance commit was lost to a crash or
--      an unreachable database is not refused as a collision forever.
--
-- Adoption cannot tell "Vex wrote this and forgot to record it" from "the user
-- had written exactly this before Vex was ever installed" - the bytes are
-- identical by construction. That ambiguity was harmless while provenance only
-- ever authorized a REWRITE (rewriting identical bytes with identical bytes is
-- a no-op). Stage B0's project TEARDOWN made it harmful: it treats every
-- provenance row as authorship proof, so deleting a project DELETED a `vex` MCP
-- entry, or an `@AGENTS.md` import line, that the user had authored themselves
-- before they ever installed Vex.
--
-- THE COLUMN
--
-- `origin` splits the two events, and the teardown may remove only `written`
-- artifacts. `adopted` ones are kept, reported to the user as an ownership
-- refusal, and the cleanup obligation is discharged by that answer.
--
-- THE DEFAULT IS THE CONSERVATIVE ONE. Every row that already exists was
-- written before this distinction was recorded, so its origin is genuinely
-- unknown - and `adopted` is the answer that cannot destroy a user's bytes.
-- The cost of getting it wrong in that direction is an artifact left on disk
-- and named in the delete report; the cost of the other direction is silent
-- deletion of content Vex did not author. New adoptions default to it too, and
-- only an actual Vex write passes `written` explicitly.

ALTER TABLE project_file_provenance
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'adopted';

-- Added by name and scoped to this relation, for the reason migration 092 and
-- 097 state: `pg_constraint.conname` is unique per TABLE, so an unscoped
-- existence check can find a same-named constraint on a different relation and
-- skip adding this one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_file_provenance_origin_check'
       AND conrelid = 'project_file_provenance'::regclass
  ) THEN
    ALTER TABLE project_file_provenance
      ADD CONSTRAINT project_file_provenance_origin_check
      CHECK (origin IN ('written', 'adopted'));
  END IF;
END
$$;
