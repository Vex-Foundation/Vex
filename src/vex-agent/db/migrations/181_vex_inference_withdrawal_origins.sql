-- VEX INFERENCE WITHDRAWAL ORIGINS: which withdrawals on a Vex Inference
-- account THIS app created, and which ones it did not.
--
-- Withdrawals now wait a rolling cooling period (12 hours by default) before
-- the backend sends them, and the user can cancel one until then (owner
-- decision 2026-10-21). A cooling withdrawal this app did not create is a
-- SECURITY NOTICE: someone with the account's session may be draining it.
-- The app needs to know, across restarts, which ids it created itself.
--
-- OWNER. The Electron main process (`vex-app/src/main/vex-cloud/funding/
-- withdrawal-origins.ts`), through
-- `src/vex-agent/db/repos/vex-inference-withdrawal-origins.ts`. No agent
-- tool, no model output and no renderer request writes these rows directly:
-- `created_here` is written only after Vex Inference answered a withdrawal
-- create of this app with the withdrawal, `foreign` only by the main-process
-- scan, and `dismissed_at` only by the user's "It was me" on a notice the
-- main process itself raised.
--
-- vex_inference_withdrawal_origins (one row per account and withdrawal id)
--   origin         `created_here`: this app created it, never a notice.
--                  `foreign`: a cooling withdrawal this app did not create;
--                  the row is written exactly once, when the scan first sees
--                  it, and that write is the moment the one engine notice
--                  for that id is emitted.
--   recorded_at    when the row was written.
--   dismissed_at   the user said "It was me": the notice does not return for
--                  this id. Only a `foreign` row can carry it.
--
-- A `foreign` row becomes `created_here` when this app later learns the id
-- was its own (a withdrawal whose create answer was lost, resolved by Check
-- status): the notice then disappears.
--
-- RETENTION. One small row per withdrawal of the account; nothing is
-- deleted, so a dismissed id can never raise its notice again. Bounded by
-- the account's withdrawals, which the backend's daily limit bounds.
--
-- COMPATIBILITY. A new table; code from before 181 never reads it. After a
-- downgrade the rows stay unused, and a later upgrade reads them as written.
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS vex_inference_withdrawal_origins (
  account_id     TEXT NOT NULL CHECK (account_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  withdrawal_id  TEXT NOT NULL CHECK (withdrawal_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  origin         TEXT NOT NULL CHECK (origin IN ('created_here', 'foreign')),
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  dismissed_at   TIMESTAMPTZ NULL,
  PRIMARY KEY (account_id, withdrawal_id),
  CHECK (origin = 'foreign' OR dismissed_at IS NULL)
);
