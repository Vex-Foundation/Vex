-- VIRTUALS AGENT LAUNCHES: A THIRD LAUNCHPAD, AND THE ONE NEW STATE IT NEEDS.
--
-- A Virtuals launch is not shaped like the two launchpads this table already
-- serves, and the difference is the whole reason for this migration.
--
-- On trench.express and pools.fun, ONE transaction creates the token. The
-- creator signs, the receipt names the token, and the launch is over. On
-- Virtuals it takes TWO, and only the first is ours:
--
--   1. `BondingV5.preLaunch(...)`  - the creator's transaction. It mints the
--      agent token, creates the pair, takes the creator's VIRTUAL and emits
--      `PreLaunched`. The agent EXISTS but does not trade and is not listed.
--   2. `BondingV5.launch(token)`   - the VIRTUALS KEEPER's transaction, about a
--      minute later. It runs the initial purchase, starts the curve and starts
--      the anti-sniper clock, emitting `Launched`. Only after this does
--      `api.virtuals.io` index the agent.
--
-- Vex signs (1) and must NEVER send (2): on 2026-09-04 our own `launch()` on
-- Robinhood beat the keeper to token `0xd1eF7097` and the agent was never
-- indexed, while the Base agent whose `launch()` the keeper ran was indexed as
-- id 139289 within minutes. The keeper's transaction is what the platform's own
-- pipeline watches.
--
-- So a Virtuals launch has a real, durable, NON-FAILING state that no existing
-- launchpad has: the creator's transaction confirmed, the money left the
-- wallet, the agent exists - and the second half has not been observed yet.
-- That state is `awaiting_keeper`.

-- ── 1. `virtuals` joins the launchpad discriminator ─────────────────────────
--
-- Dropped and re-added rather than edited: a CHECK cannot be extended in place.
-- Both existing members are carried across unchanged.

ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_protocol_check;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_protocol_check
  CHECK (protocol IN ('trench', 'pools_fun', 'virtuals'));

-- ── 2. The Virtuals launch fields ───────────────────────────────────────────
--
-- ONE JSONB COLUMN, NOT A DOZEN FLAT ONES, and the choice is deliberate.
--
-- Migration 082 gave pools.fun eight flat columns because every one of them is
-- read back by a query that filters or joins on it. Nothing filters on a
-- Virtuals launch's anti-sniper type, its cores array or its calldata
-- fingerprint: they are read as one block by the handler that owns the launch,
-- to show a person what they authorized and to hold the pre-sign re-read
-- against it. That is exactly the shape `authorization_json` already has on
-- this table, and it is read the same way - as `unknown`, schema-validated by
-- the reader before anything acts on it, because a stored row is untrusted
-- input (rule 04).
--
-- The fields that DO have a query on them are not in here at all: the chain,
-- the wallet, the name, the symbol, the description, the links, the image id,
-- the committed amount (`prebuy_raw`/`prebuy_decimals`), the transaction hash
-- and the token address are the table's own columns and mean exactly what they
-- mean for the other two launchpads. A second copy inside the blob would be a
-- second source of truth.
ALTER TABLE token_launch_intents
  ADD COLUMN IF NOT EXISTS virtuals JSONB;

-- A Virtuals intent without its block cannot be shown, re-verified or settled;
-- another launchpad's intent must not carry one.
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_virtuals_block;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_virtuals_block
  CHECK (
    (protocol = 'virtuals' AND virtuals IS NOT NULL)
    OR (protocol <> 'virtuals' AND virtuals IS NULL)
  );

-- ── 3. `awaiting_keeper` ────────────────────────────────────────────────────
--
-- NON-TERMINAL, AND DELIBERATELY NOT A FAILURE. The pre-launch succeeded. The
-- creator's VIRTUAL is inside BondingV5. The token address is known and the
-- transaction hash is real. The only thing that has not happened is an
-- observation of somebody else's transaction, and the sweep will make it later
-- without any signer.
--
-- Naming it `terminal_failure` would assert the launch did not happen, which
-- nothing established; naming it `broadcast_pending` would say the outcome of
-- OUR transaction is unknown, which is false - it confirmed. It is its own
-- state because it is its own fact.
--
-- MetaMask's PendingTransactionTracker turns a not-found timeout into a FAILED
-- transaction (`PendingTransactionTracker.ts:490-495`); the Vex wallet-reference
-- audit records that as an explicit rejection and this state is the shape of
-- that rejection in the schema.
--
-- Every previously admitted value is carried across unchanged (082's list).
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_status_check;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_status_check
  CHECK (status IN (
    'previewed',
    'awaiting_user_form',
    'authorized',
    'consuming',
    'broadcast_pending',
    'confirmed',
    'awaiting_keeper',
    'terminal_failure',
    'cancelled',
    'expired',
    'superseded_unproven'
  ));

-- WHAT THE STATE ASSERTS, as database facts rather than as a comment.
--
-- Reaching `awaiting_keeper` means all three of these were established, so a
-- row that claims the state without them is a bug the schema refuses to store:
-- the pre-launch was SIGNED (a hash), the receipt was DECODED (a token
-- address), and this only ever happens on Virtuals (the two-transaction shape
-- is the whole reason the state exists).
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_awaiting_keeper_is_proven;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_awaiting_keeper_is_proven
  CHECK (
    status <> 'awaiting_keeper'
    OR (protocol = 'virtuals' AND tx_hash IS NOT NULL AND token_address IS NOT NULL)
  );

-- The sweep's candidate query: oldest first, so a launch never starves behind
-- newer ones. Partial, because the population is tiny next to the table.
CREATE INDEX IF NOT EXISTS idx_token_launch_intents_awaiting_keeper
  ON token_launch_intents (created_at ASC)
  WHERE status = 'awaiting_keeper';

-- ── 4. `launched_tokens.agentscan_attest_signature` ─────────────────────────
--
-- THE THIRD SIGNATURE, and why neither existing column can be reused.
--
-- The AgentScan attestation registry verifies exactly one message,
-- `canonicalAttestMessage(chainId, tokenAddress)` = `VEX-attest:<chainId>:<addr>`
-- (`packages/contract/src/attest.ts`). `attest_signature` (migration 071) signs
-- that message and is the trench.express proof. `pools_attest_signature`
-- (migration 094) signs pools.fun's OWN venue-prefixed message, a deliberately
-- different one, so sending it to AgentScan would be a proof over the wrong
-- bytes and would burn the row on a definitive refusal.
--
-- So pools.fun and Virtuals each owe AgentScan a signature over the canonical
-- message, produced at launch time by the handler that still holds the signer -
-- nothing later has one. The column is named for the REGISTRY it serves rather
-- than for a venue, precisely so the second launchpad that needs it does not
-- mint a third copy: the pools.fun launch lane writes the same column for its
-- own rows. `IF NOT EXISTS` because the two lanes ship independently and
-- whichever merges first creates it.
ALTER TABLE launched_tokens
  ADD COLUMN IF NOT EXISTS agentscan_attest_signature TEXT;

COMMENT ON COLUMN launched_tokens.agentscan_attest_signature IS
  'Creator signature over AgentScan''s canonical attest message (VEX-attest:<chainId>:<lowercased token>), '
  'produced at launch time while the launching handler still holds the signer. Distinct from attest_signature '
  '(trench.express, same message, historical column) and from pools_attest_signature (pools.fun''s own '
  'venue-prefixed message, which AgentScan refuses). Write-once.';
