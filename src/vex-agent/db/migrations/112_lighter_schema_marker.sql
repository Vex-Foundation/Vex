-- Positive identity marker for the Lighter migration range that follows.
--
-- WHY A MARKER EXISTS AT ALL. The Lighter work was developed on a branch whose
-- migrations occupied 079..120, numbers main had already used. Those branch-era
-- developer databases carry Lighter tables at numbers this build now assigns to
-- entirely different files, so replaying forward would apply the wrong SQL to a
-- schema that already has the table. The numbers alone cannot tell the two
-- histories apart: both look like "schema_version at 120". This table is the
-- positive discriminator that can - it exists only when a database was migrated
-- by a build carrying THIS numbering, because 112 is the first Lighter file in
-- it and every later Lighter file runs after it.
--
-- The runner (src/lib/db/migrate-runner.ts) reads it before planning: any
-- `lighter_%` table without this marker, or any of the branch-era lineage
-- tables, refuses the run. Vex never converts or deletes such a database.
--
-- The marker's single row is a constant, not user data. Do not add rows.

CREATE TABLE IF NOT EXISTS lighter_schema_marker (
  lineage    TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO lighter_schema_marker (lineage)
VALUES ('main-2026-09')
ON CONFLICT (lineage) DO NOTHING;
