-- RUNNER LEASES: a claim token per claim (lease fencing).
--
-- WHY THIS EXISTS. A `runner_leases` row named its holder only by `owner_id`,
-- and several runners use a FIXED owner id per work item (`retry-<run>`,
-- `wake-executor-<wake>`, `recover-<run>`, `lighter-setup-<intent>`). Renewal,
-- release and the same-owner re-claim all matched on `owner_id`, so two runners
-- that happened to share an owner id could both "hold" the lease: the second
-- claim refreshed the first one's row, and either could renew or release it.
--
-- `claim_token` identifies ONE claim. `acquireLease` mints a fresh random token
-- on every new claim (a first insert, or a takeover of an expired lease); a
-- same-owner call while the lease is live is an idempotent refresh only when it
-- presents the current token. `renewLease` / `releaseLease` match on
-- `session_id + claim_token`, and fenced writes lock the row by the same pair
-- (`db/lease-fence.ts`), so a runner whose claim was taken over can no longer
-- renew, release or write.
--
-- BACKFILL. A row that exists when this runs belongs to a claim made by code
-- that never saw a token, so it gets a random one nobody holds. The runner that
-- owned it (if it is still alive across an upgrade, which a desktop restart
-- makes impossible in practice) can then not renew it, and the row simply
-- expires on its TTL like an orphaned lease does today.
--
-- The column DEFAULT keeps any INSERT that does not name the column valid; the
-- application always supplies its own token.
--
-- IDEMPOTENT: every step is a no-op on a re-run.
ALTER TABLE runner_leases
  ADD COLUMN IF NOT EXISTS claim_token TEXT;

UPDATE runner_leases
   SET claim_token = gen_random_uuid()::text
 WHERE claim_token IS NULL;

ALTER TABLE runner_leases
  ALTER COLUMN claim_token SET DEFAULT gen_random_uuid()::text;

ALTER TABLE runner_leases
  ALTER COLUMN claim_token SET NOT NULL;
