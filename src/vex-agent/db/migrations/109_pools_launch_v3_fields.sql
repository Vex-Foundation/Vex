-- THE pools.fun V3 LAUNCH FIELDS: STOCK PAIRS, THE FEES-TO-HOLDERS BINDING, AND
-- THE THIRD ATTESTATION SIGNATURE.
--
-- Three unrelated-looking changes, one launch. The V3 contract suite made a
-- pools.fun launch able to do two things it could not do before - pair against a
-- tokenised stock, and hand its creator fee stream to the token's holders - and
-- the AgentScan attestation registry needs a proof of that launch that no column
-- in this database can currently hold. All three are durable facts ABOUT ONE
-- ROW, written by one handler, in one transaction, so they arrive together
-- rather than as three migrations that are only ever applied as a set.
--
-- ── 1. WHY `stock` WAS OUT, AND WHAT CHANGED ───────────────────────────────
--
-- Migration 082 wrote: "Only WETH and USDG are launchable on PartyFactory today:
-- `allowedPairedAsset` returns false for the tokenised stocks... 'stock'
-- therefore stays OUT of the vocabulary until a real stock address passes the
-- live check - a value the database refuses is better than a launch that
-- reverts."
--
-- That live check has now passed, on the V3 factory rather than the one 082
-- measured. All 194 rows of the launchpad's own `GET /pools-fun/launch-assets`
-- answer `allowedPairedAsset(asset) = true`, and `pricingModeFor(asset)` names
-- how each is priced: 35 `CHAINLINK_STOCK` (launch with an EMPTY attestation)
-- and 159 `SIGNED_STOCK` (the launch must carry a backend-signed quote the
-- factory accepts only 30 to 120 seconds after it was observed). Measured
-- 2026-09-04 against the verified V3 factory; the per-asset table is in
-- `agents-colab/agents_dm/pools-fun-probe-2026-09-04/captures/`.
--
-- So the CHECK is widened, on 082's own stated condition, and the SYMBOLIC value
-- stays symbolic: `paired_asset = 'stock'` says the KIND, and the existing
-- `paired_asset_address` says WHICH stock. Both are needed and neither is
-- redundant - one of 194 stocks is not identifiable from the word "stock", and
-- an address with no kind cannot be rendered without reading the factory again.
--
-- ── 2. THE HOLDERS BINDING, AND WHY IT IS TWO FACTS AND NOT ONE ────────────
--
-- A fees-to-holders launch does NOT put a recipient address in its calldata. It
-- carries a SENTINEL constant the gateway publishes (`FEES_TO_HOLDERS`,
-- `_PAIRED`, `_BOTH`), and the gateway RESOLVES that sentinel to a distributor
-- it deploys inside the very same transaction before it emits `GatewayLaunch`.
-- So the address that was SIGNED and the address in the RECEIPT are different by
-- construction, and neither is wrong.
--
-- A single column would therefore have to lie about one of them. Three exist
-- instead, and they are ordered in time:
--
--   holder_rewards_mode         the INTENT, in the user's terms ("holders, paid
--                               in the paired asset"). Known at authorization.
--   holder_rewards_sentinel     the constant that expresses that intent in the
--                               bytes that were signed. Known at authorization,
--                               and the thing the verifier's point 15 held the
--                               calldata to.
--   holder_rewards_distributor  the address the gateway resolved it to, PROVEN
--                               from this launch's own
--                               `DistributorDeployed(token, distributor, mode)`
--                               event. Not knowable until a receipt exists.
--
-- The CHECK below encodes exactly that and nothing stricter. The intent pair is
-- all-or-nothing: a mode with no sentinel is an intent nobody signed, and a
-- sentinel with no mode is a constant nobody can read back into a product
-- decision. The distributor is free to be NULL while the pair is set - that is
-- the ordinary state of every holders launch between authorization and
-- settlement - but it may NEVER be set without them, because an address with no
-- intent behind it is a fee destination this database cannot account for.
--
-- ── 3. THE THIRD SIGNATURE ─────────────────────────────────────────────────
--
-- `launched_tokens` already holds two creator signatures and they sign different
-- strings. `attest_signature` (071) is trench.express's badge and happens to
-- sign AgentScan's canonical message. `pools_attest_signature` (094) signs
-- pools.fun's own venue-prefixed message and is REFUSED by AgentScan, whose
-- recovery reads it as a different message and would answer with a definitive
-- rejection that burns the row.
--
-- `agentscan_attest_signature` is the third, over AgentScan's canonical
-- `VEX-attest:<chainId>:<token>` (`src/vex-agent/agentscan/attest-message.ts`,
-- mirroring the server's `packages/contract/src/attest.ts`). It is
-- LAUNCHPAD-NEUTRAL on purpose: the registry covers several launchpads on
-- several chains, the column belongs to the attestation lane rather than to
-- pools.fun, and Virtuals will fill the same column when its launch lane can
-- sign one.
--
-- It can only be produced at LAUNCH TIME, by the handler that still holds the
-- signer: the message names the token, the token's address exists only once the
-- receipt is decoded, and no sweep in this process holds a key. A launch that
-- could not sign leaves this NULL, which the sweep counts as a named gap rather
-- than as work to retry.
--
-- ── COMPATIBILITY AND ROLLBACK ─────────────────────────────────────────────
--
-- EXPAND-ONLY. Nothing is dropped, nothing is narrowed, and no existing member
-- of any restated CHECK is removed. Every column added is NULLABLE with no
-- default, so every constraint validates cleanly against every installed
-- database with no NOT VALID and no backfill, and no historical row can fail
-- one: a pre-109 row has all three holders columns NULL, which the CHECK's first
-- arm admits.
--
-- OLD CODE ON A NEW DATABASE is safe. A widened CHECK accepts everything the
-- narrower one did; the new columns are nullable and are named by no old
-- INSERT or UPDATE, so an old build's writes still succeed and it simply never
-- sets them. It also never READS them, so it renders a holders launch exactly as
-- it does today: by its `fee_recipient_address`, which on such a row is the
-- sentinel. That is a display gap in an old binary, not a wrong number.
--
-- NEW CODE ON AN OLD DATABASE is the direction that fails, and it fails CLOSED
-- and immediately: the INSERT names columns that do not exist and errors before
-- any launch is authorized. The migration runner is forward-only and runs at
-- startup, so this is the ordinary ordering rather than a state to design for.
--
-- ROLLBACK is by restoring migration 082's `token_launch_intents_paired_asset_check`
-- body after deleting any intent row with `paired_asset = 'stock'`, and dropping
-- the four added columns. Dropping them loses the holders binding of any launch
-- already made and the AgentScan proof of any token not yet attested; the
-- launches themselves are unaffected, and the distributor remains recoverable
-- from the receipt. There is no down script - this repository's runner is
-- forward-only.
--
-- Mirror: run `node vex-app/scripts/copy-migrations.mjs` after this file is
-- final; `vex-app/scripts/check-build-artifacts.mjs` is the gate.
--
-- Forward-only; idempotent (drop-and-recreate named constraints, ADD COLUMN IF
-- NOT EXISTS).

-- ── 1. Stock pairs ─────────────────────────────────────────────────────────
--
-- Restated in full because a CHECK cannot be extended in place. Both members of
-- 082's list are carried across byte-for-byte; dropping one would make the rows
-- already written under it unwritable.

ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_paired_asset_check;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_paired_asset_check
  CHECK (paired_asset IS NULL OR paired_asset IN ('weth', 'usdg', 'stock'));

-- A stock pair without an address names no asset. The kind and the identity are
-- two columns precisely so this can be required, and it is required only for
-- the value that needs it: `weth` and `usdg` are identified by their kind alone.
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_stock_has_address;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_stock_has_address
  CHECK (paired_asset IS DISTINCT FROM 'stock' OR paired_asset_address IS NOT NULL);

-- ── 2. The fees-to-holders binding ─────────────────────────────────────────

ALTER TABLE token_launch_intents
  ADD COLUMN IF NOT EXISTS holder_rewards_mode        TEXT,
  ADD COLUMN IF NOT EXISTS holder_rewards_sentinel    TEXT,
  ADD COLUMN IF NOT EXISTS holder_rewards_distributor TEXT;

-- The mode's vocabulary is the launchpad's own and is CLOSED: the gateway
-- publishes exactly three sentinels and the deployer's `DistributorDeployed`
-- carries exactly three ordinals. A fourth value would be a mode this build
-- cannot name, which the decoder refuses rather than records.
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_holder_rewards_mode_valid;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_holder_rewards_mode_valid
  CHECK (holder_rewards_mode IS NULL OR holder_rewards_mode IN ('token', 'paired', 'both'));

-- THE INTENT IS ALL OR NOTHING; THE DISTRIBUTOR IS A LATER FACT.
--
-- Arm 1: an ordinary launch - none of the three.
-- Arm 2: a holders launch - mode AND sentinel together, distributor free,
--        because it is unknowable until the receipt is decoded and the row is
--        written before the transaction is broadcast.
-- What no arm admits: a distributor with no intent behind it, a mode with no
-- sentinel, or a sentinel with no mode.
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_holder_rewards_binding;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_holder_rewards_binding
  CHECK (
    (holder_rewards_mode IS NULL
     AND holder_rewards_sentinel IS NULL
     AND holder_rewards_distributor IS NULL)
    OR (holder_rewards_mode IS NOT NULL AND holder_rewards_sentinel IS NOT NULL)
  );

-- A pools.fun launch is the only protocol that has these fields at all; a Trench
-- launch has no paired asset and no fee-stream sentinel by construction.
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_holder_rewards_pools_only;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_holder_rewards_pools_only
  CHECK (holder_rewards_mode IS NULL OR protocol = 'pools_fun');

-- ── 3. The AgentScan attestation signature ─────────────────────────────────

ALTER TABLE launched_tokens
  ADD COLUMN IF NOT EXISTS agentscan_attest_signature TEXT;

-- The AgentScan submission sweep's hot path: rows that carry the canonical
-- signature and have never been submitted. Partial, so it indexes the candidate
-- set rather than the table - the overwhelming majority of rows are already
-- attested or were never signable.
CREATE INDEX IF NOT EXISTS idx_launched_tokens_agentscan_attest_pending
  ON launched_tokens (agentscan_attest_attempted_at NULLS FIRST, id)
  WHERE agentscan_attest_signature IS NOT NULL
    AND agentscan_attested_at IS NULL;
