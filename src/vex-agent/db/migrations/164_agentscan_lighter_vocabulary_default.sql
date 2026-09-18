-- Migration 152 walked existing rows to vocabulary_version 4 but left the
-- column DEFAULT at 3. ensureSingleton() inserts a bare (id) row and relies on
-- that default, so every install that registered after 152 ran was stamped at
-- 3 forever - permanently below LIGHTER_VOCABULARY_VERSION, so no Lighter fill
-- or funding leg was ever enqueued to agentscan_outbox for it. Fix the default
-- for new rows and sweep any row still stuck below 4.
ALTER TABLE agentscan_reporting_state
  ALTER COLUMN vocabulary_version SET DEFAULT 4;

UPDATE agentscan_reporting_state
   SET vocabulary_version = 4, updated_at = NOW()
 WHERE id = 1 AND vocabulary_version < 4;
