-- 090_wallet_transaction_intents_activity_unique.sql - restore uniqueness on
-- `wallet_transaction_intents.activity_id` (audit finding F).
--
-- RUNS AFTER 089.
--
-- WHAT WAS WRONG. 087 created `idx_wallet_transaction_intents_activity` as a
-- plain partial index over `activity_id` (the repair lanes' traversal index,
-- see 087's header near that CREATE INDEX). A plain index enforces no
-- uniqueness. `stampActivityWith` (`db/repos/wallet-transaction-intents.ts`)
-- links exactly ONE intent to exactly one `agent_activity` row, once, via its
-- own `activity_id IS NULL` idempotent-by-refusal CAS predicate - so the
-- application already treats the link as 1:1 - but nothing in the schema
-- stopped a future writer from stamping the SAME `activity_id` onto a second
-- intent, which would make the repair lanes' `activity_id` traversal (and any
-- future `activity_id`-keyed lookup) ambiguous about which intent owns which
-- money-state row.
--
-- THE FIX. A partial UNIQUE index, `WHERE activity_id IS NOT NULL` so the many
-- rows that never reached T2 (pending, cancelled, expired - see 087's status
-- lifecycle table) stay unconstrained, exactly like 087's own partial index
-- does. This does not replace `idx_wallet_transaction_intents_activity`: that
-- index stays as the repair lanes' traversal index (a unique index would also
-- serve equality lookups, but 087 named it for a different purpose and
-- dropping/recreating it here is unnecessary churn on a live index).
--
-- Forward-only; idempotent (`CREATE UNIQUE INDEX IF NOT EXISTS`).

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transaction_intents_activity_unique
  ON wallet_transaction_intents (activity_id)
  WHERE activity_id IS NOT NULL;
