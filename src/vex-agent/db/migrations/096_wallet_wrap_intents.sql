-- 096: the durable wrap intent.
--
-- A native <-> wrapped-native conversion gets its OWN table, for the same
-- reason 087 refused to share `wallet_intents`: a confirm handler must not be
-- able to consume a proposal built by a different lane. `gateConfirm` on the
-- 087 table discriminates on wallet FAMILY, not on a kind, so a wrap intent
-- stored there could be signed by `WalletEvmTransactionConfirm` - which plans a
-- Vex fee, decodes generic calldata, and settles a legless activity row. Two
-- shapes, two tables, two confirms.
--
-- WHAT THIS TABLE DOES NOT HAVE, and the absence is the design:
--
--   * NO fee column, of any kind. A wrap extracts no value: it is a utility
--     conversion the user needs in order to use their own asset. Migration 051
--     recorded that decision for the activity row and 088's kind/role binding
--     makes a fee LEG on `kind = 'wrap'` a database impossibility. This table
--     is the third lock: generic Vex-fee planning has nothing here to read or
--     write, so it is unreachable from a wrap intent by construction rather
--     than by a branch someone can later delete. The same shape is what
--     Uniswap's own `WrapTrade` type encodes (`swapFee: undefined`,
--     `slippageTolerance: 0` as literal types) and what Rabby's fee hook
--     returns as its FIRST branch for a wrap pair.
--   * NO slippage, min-out, route, quote or expiry-of-price column. The
--     contract converts 1:1 by construction, so there is no price to bind and
--     nothing to be filled worse than. `expires_at` bounds the APPROVAL, not a
--     price.
--   * NO recipient column. The wrapped-native contract credits `msg.sender`,
--     so the recipient IS the signer and cannot be redirected. A column would
--     imply a choice that does not exist.
--
-- The amount is ONE value, not two. `deposit()` and `withdraw(uint256)` convert
-- exactly 1:1, so a single `amount_raw` describes both legs; storing an in and
-- an out would create two sources of truth for one quantity.
--
-- `payload_json` holds the derived `{ to, data, valueWei }` triple. It is
-- stored, but confirm does NOT trust it: confirm re-derives the triple from the
-- bound direction, contract and amount and compares all three fields before
-- signing. It is persisted so a crash-recovery reader can see exactly what was
-- proposed without re-running the deriver.
--
-- Forward-only; idempotent IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS wallet_wrap_intents (
  intent_id                TEXT PRIMARY KEY,
  session_id               TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  wallet_address           TEXT NOT NULL,

  -- EVM only. The wrapped-native capability registry
  -- (`tools/evm-chains/wrapped-native.ts`) is an eip155 table, and a Solana
  -- wSOL account has a different lifecycle (rent, close-to-unwrap) that this
  -- shape would misdescribe. A Solana arm is additive and would carry its own
  -- evidence columns.
  chain_alias              TEXT NOT NULL,
  chain_id                 BIGINT NOT NULL,

  direction                TEXT NOT NULL CHECK (direction IN ('wrap', 'unwrap')),

  -- The contract identity, copied from the verified registry at prepare and
  -- BOUND into the digest. Stored rather than re-read so that a later registry
  -- edit cannot silently change what an already-approved proposal signs.
  wrapped_native_address   TEXT NOT NULL,
  wrapped_native_symbol    TEXT NOT NULL,
  wrapped_native_decimals  SMALLINT NOT NULL,

  -- Raw base units, decimal digits, positive. TEXT because wei exceeds BIGINT
  -- and no amount on this path may ever touch floating point.
  amount_raw               TEXT NOT NULL CHECK (amount_raw ~ '^[1-9][0-9]*$'),

  payload_json             JSONB NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  preview_json             JSONB NOT NULL CHECK (jsonb_typeof(preview_json) = 'object'),
  -- MANDATORY gas caps, per the wallet-intent fee-bounds contract. Vex never
  -- derives a spending limit from a network estimate, so there is no NULL
  -- state: a prepare without caps refuses and returns the estimate as a hint.
  fee_bounds_json          JSONB NOT NULL CHECK (jsonb_typeof(fee_bounds_json) = 'object'),

  -- VERSIONED SHA-256 over every sign-relevant field: resource identity,
  -- wallet, chain, direction, contract identity, amount, derived payload, fee
  -- bounds, expiry, and the RENDERED card. Confirm refuses an unknown version
  -- rather than comparing across schemes.
  proposal_digest          TEXT NOT NULL,
  proposal_digest_version  TEXT NOT NULL,

  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'consuming',
    'executed',
    'failed',
    'broadcast_unconfirmed',
    'superseded_unproven',
    'audit_failed',
    'cancelled',
    'expired',
    -- The transaction CONFIRMED and its receipt proved a quantity that
    -- CONTRADICTS the approved amount. Not `executed` (that asserts it happened
    -- as approved) and not `failed` (the transaction is on-chain and the funds
    -- moved). Same status, same meaning and the same hash-required invariant
    -- migration 093 gave `wallet_intents`. It blocks the compaction
    -- money-state gate until a human resolves it.
    'review_required'
  )),
  failure_stage            TEXT CHECK (failure_stage IN (
    'pre_broadcast',
    'chain_reverted',
    'crashed_before_broadcast'
  )),

  -- Stamped in the SAME transaction as the claim, so a crash can never strand a
  -- claimed intent with no activity row to recover from.
  activity_id              BIGINT REFERENCES agent_activity(id) ON DELETE SET NULL,

  expires_at               TIMESTAMPTZ NOT NULL,
  consumed_at              TIMESTAMPTZ,
  cancelled_at             TIMESTAMPTZ,
  tx_hash                  TEXT,
  failure_reason           TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The derived payload must agree with the direction it claims. `deposit()`
  -- carries its amount in `value` and its calldata is the constant selector;
  -- `withdraw(uint256)` carries the amount in calldata and sends no value.
  -- Written flat so the repo's SQL check evaluator can run it against concrete
  -- rows, and comment-free inside the body because that evaluator has no
  -- comment token.
  CONSTRAINT wallet_wrap_intents_direction_payload CHECK (
    (direction = 'wrap'
       AND payload_json ->> 'data' = '0xd0e30db0'
       AND payload_json ->> 'valueWei' = amount_raw)
    OR
    (direction = 'unwrap'
       AND payload_json ->> 'data' LIKE '0x2e1a7d4d%'
       AND payload_json ->> 'valueWei' = '0')
  ),

  -- The transaction is always sent TO the bound wrapped-native contract.
  CONSTRAINT wallet_wrap_intents_payload_target CHECK (
    payload_json ->> 'to' = wrapped_native_address
  ),

  -- `failure_stage` exists exactly when the row is `failed`.
  CONSTRAINT wallet_wrap_intents_failure_stage CHECK (
    (status = 'failed' AND failure_stage IS NOT NULL)
    OR
    (status <> 'failed' AND failure_stage IS NULL)
  ),

  -- THE EVIDENCE RULE, part 1: the statuses that are NOT `failed`. Carried
  -- across from 087 unchanged; the reasoning there applies here without
  -- alteration.
  CONSTRAINT wallet_wrap_intents_evidence CHECK (
    (status IN ('pending', 'consuming', 'cancelled', 'expired', 'audit_failed')
       AND tx_hash IS NULL AND failure_stage IS NULL)
    OR
    (status IN ('executed', 'broadcast_unconfirmed', 'superseded_unproven', 'review_required')
       AND tx_hash IS NOT NULL AND failure_stage IS NULL)
    OR
    status = 'failed'
  ),

  -- THE EVIDENCE RULE, part 2: `failed` splits by STAGE. A chain revert is a
  -- real transaction and MUST carry the hash the operator reads the receipt
  -- from; a pre-broadcast failure and a crash before broadcast MUST NOT carry
  -- one, because a hash would assert a broadcast that never happened.
  CONSTRAINT wallet_wrap_intents_failed_evidence CHECK (
    status <> 'failed'
    OR (failure_stage = 'chain_reverted' AND tx_hash IS NOT NULL)
    OR (failure_stage IN ('pre_broadcast', 'crashed_before_broadcast') AND tx_hash IS NULL)
  )
);

-- Per-session listing and the money-state gate's session-scoped scan.
CREATE INDEX IF NOT EXISTS idx_wallet_wrap_intents_session
  ON wallet_wrap_intents (session_id);

-- TTL sweep hot path: only `pending` rows are candidates.
CREATE INDEX IF NOT EXISTS idx_wallet_wrap_intents_status_expires
  ON wallet_wrap_intents (status, expires_at)
  WHERE status = 'pending';

-- Repair-lane hot path: the small set of rows a chain observer owns.
CREATE INDEX IF NOT EXISTS idx_wallet_wrap_intents_unconfirmed
  ON wallet_wrap_intents (status)
  WHERE status IN ('consuming', 'broadcast_unconfirmed');

-- The activity link the repair lanes traverse when they terminalize an activity
-- row and have to settle the intent that owns it.
CREATE INDEX IF NOT EXISTS idx_wallet_wrap_intents_activity
  ON wallet_wrap_intents (activity_id)
  WHERE activity_id IS NOT NULL;

-- One wrap intent per activity row, mirroring 090 for the 087 table: the
-- activity row is the audit identity, and two intents claiming the same one
-- would make the settlement lanes unable to say which proposal it proves.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_wrap_intents_activity_unique
  ON wallet_wrap_intents (activity_id)
  WHERE activity_id IS NOT NULL;

-- NO activity vocabulary change. `kind = 'wrap'` with roles `wrap` / `unwrap`
-- has existed since migration 051, the role/kind binding in 088 already admits
-- exactly those two roles and no fee role, and the TypeScript unions are in
-- step (the lockstep test proves it). Restating those CHECKs here would risk
-- dropping a member that a later migration added, for no gain.
