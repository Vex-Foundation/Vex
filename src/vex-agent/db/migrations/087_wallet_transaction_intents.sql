-- Stage A4b - wallet_transaction_intents: durable intents for the GENERIC
-- signing tools (WalletEvmTransactionPrepare/Confirm,
-- WalletSolanaTransactionPrepare/Confirm).
--
-- WHY A NEW TABLE AND NOT A `kind` COLUMN ON `wallet_intents`.
-- `wallet_intents` is transfer-shaped: `to_address` and `amount` are NOT NULL
-- and carry transfer semantics, its reads and CAS predicates carry no kind, and
-- `WalletSendConfirm` checks the wallet family but not the kind. A transaction
-- intent living in that table could therefore be consumed by the TRANSFER
-- confirm, which would broadcast a transfer-shaped plan built from a payload
-- that is not a transfer. Two shapes, two tables, two confirms.
--
-- STATUS LIFECYCLE (the A4b transition table T1-T8; WTI = this table,
-- AA = agent_activity, PE = protocol_executions). Every transition is a CAS on
-- the named from-status; the evidence column of each row is a CHECK below.
--
--   T1 prepare                       insert `pending`            tx_hash NULL
--   T2 confirm claim (one tx)        pending -> consuming        no hash yet
--   T3a confirmed return             consuming -> executed       tx_hash REQUIRED
--   T3b chain_failed return          consuming -> failed         tx_hash REQUIRED
--                                    failure_stage `chain_reverted`
--   T3c pre_broadcast_failed return  consuming -> failed         tx_hash NULL REQUIRED
--                                    failure_stage `pre_broadcast`
--   T3d confirmation_unknown return  consuming -> broadcast_unconfirmed
--                                    tx_hash REQUIRED
--   T4a crash, no staged hash        consuming -> failed         tx_hash NULL REQUIRED
--                                    failure_stage `crashed_before_broadcast`
--   T4b crash, staged hash present   consuming -> broadcast_unconfirmed
--                                    tx_hash REQUIRED
--   T5 repair reads chain evidence   broadcast_unconfirmed -> executed | failed
--   T6 repair terminalizes unproven  broadcast_unconfirmed -> superseded_unproven
--   T7 TTL sweep                     pending -> expired
--   T8 owner cancel                  pending -> cancelled
--
-- `audit_failed` is the staged-evidence write failing BEFORE broadcast: nothing
-- was signed, so `tx_hash` is NULL and the row releases the money-state gate
-- while flagging itself for investigation.
--
-- THE `failure_stage` DISCRIMINATOR EXISTS SO THE EVIDENCE RULE IS EXPRESSIBLE.
-- `failed` is reached from three different places with two opposite evidence
-- obligations: a chain revert MUST carry the hash the operator needs to read the
-- receipt, while a pre-broadcast failure and a crash-before-broadcast MUST NOT
-- carry one, because a hash would assert a broadcast that never happened.
-- Without a discriminator column the CHECK could only say "tx_hash MAY be set",
-- which is not a rule. `wallet_intents` has exactly that weaker CHECK, and its
-- failed-with-hash rows are why the money-state gate has to treat them as
-- unresolved.
--
-- SESSION OWNERSHIP. Every mutation and lookup in
-- `db/repos/wallet-transaction-intents.ts` carries `session_id` in the
-- predicate, and every writer is client-bound (contract C7) so it serializes
-- with the compaction money-state gate on the session control lock.
--
-- REDACTION. `failure_reason` is a structural label only
-- (`ErrorKind:shortSha256(message)`); raw RPC or provider text, calldata and
-- signatures MUST NEVER reach this column. `payload_json` holds the caller's
-- own proposal (calldata / message bytes), which is not a secret and is exactly
-- what the approval card must display; it never travels to telemetry.
--
-- Forward-only; idempotent IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS wallet_transaction_intents (
  intent_id                TEXT PRIMARY KEY,
  session_id               TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  wallet_address           TEXT NOT NULL,

  -- Wallet FAMILY, never a chain. `chain_alias`/`chain_id` carry the chain.
  family                   TEXT NOT NULL CHECK (family IN ('eip155', 'solana')),
  chain_alias              TEXT,
  chain_id                 BIGINT,

  -- The caller's proposal, strict per-family shape, validated in the repo's
  -- parser before it is trusted: EVM `{ to, data, valueWei }`, Solana
  -- `{ messageBase64 }` (the CANONICAL unsigned message bytes, fee payer and
  -- fresh blockhash already installed at prepare).
  payload_json             JSONB NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  -- The fail-closed decode result: the effects the user approves.
  decoded_json             JSONB NOT NULL CHECK (jsonb_typeof(decoded_json) = 'object'),
  preview_json             JSONB NOT NULL CHECK (jsonb_typeof(preview_json) = 'object'),
  -- MANDATORY effective fee bounds. All caps are REQUIRED CALLER INPUTS; no
  -- derivation invents money policy, so there is no NULL state to model.
  fee_bounds_json          JSONB NOT NULL CHECK (jsonb_typeof(fee_bounds_json) = 'object'),

  -- VERSIONED SHA-256 over EVERY sign-relevant field (resource identity,
  -- family, wallet, chain, canonical payload, decoded effects, fee bounds,
  -- blockhash evidence, expiry). A digest over payload bytes alone cannot
  -- detect drift in the authority fields, so the version travels with it and
  -- confirm refuses an unknown version rather than comparing across schemes.
  proposal_digest          TEXT NOT NULL,
  proposal_digest_version  TEXT NOT NULL,

  -- Solana blockhash evidence. `last_valid_block_height` is the AUTHORITY for
  -- expiry (block height does not convert to a timestamp); `expires_at` is the
  -- displayed 60 s cap.
  recent_blockhash         TEXT,
  last_valid_block_height  BIGINT,

  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'consuming',
    'executed',
    'failed',
    'broadcast_unconfirmed',
    'superseded_unproven',
    'audit_failed',
    'cancelled',
    'expired'
  )),
  failure_stage            TEXT CHECK (failure_stage IN (
    'pre_broadcast',
    'chain_reverted',
    'crashed_before_broadcast'
  )),

  -- Stamped in the SAME transaction as the T2 claim, so a crash can never
  -- strand a claimed intent with no activity row to recover from. Nullable
  -- because T1..T2-exclusive rows (pending, expired, cancelled) never have one.
  activity_id              BIGINT REFERENCES agent_activity(id) ON DELETE SET NULL,

  expires_at               TIMESTAMPTZ NOT NULL,
  consumed_at              TIMESTAMPTZ,
  cancelled_at             TIMESTAMPTZ,
  tx_hash                  TEXT,
  failure_reason           TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Family/chain coherence: an EVM intent names its chain both ways and has no
  -- blockhash; a Solana intent has no EVM chain and MUST carry its height
  -- evidence, because confirm rechecks the height before signing.
  CONSTRAINT wallet_transaction_intents_family_chain CHECK (
    (family = 'eip155'
       AND chain_alias IS NOT NULL AND chain_id IS NOT NULL
       AND recent_blockhash IS NULL AND last_valid_block_height IS NULL)
    OR
    (family = 'solana'
       AND chain_id IS NULL
       AND recent_blockhash IS NOT NULL AND last_valid_block_height IS NOT NULL)
  ),

  -- `failure_stage` exists exactly when the row is `failed`.
  CONSTRAINT wallet_transaction_intents_failure_stage CHECK (
    (status = 'failed' AND failure_stage IS NOT NULL)
    OR
    (status <> 'failed' AND failure_stage IS NULL)
  ),

  -- THE EVIDENCE RULE, part 1: the statuses that are NOT `failed`.
  --
  -- Written as a flat OR of AND clauses rather than a CASE so it can be
  -- evaluated against concrete rows by the repo test suite's SQL check
  -- evaluator, which answers "would Postgres accept this row?" instead of
  -- asserting that a string is present in the file.
  CONSTRAINT wallet_transaction_intents_evidence CHECK (
    -- Nothing has been signed yet, or the row died before it could be. The
    -- staged-evidence write failing BEFORE broadcast (`audit_failed`) belongs
    -- here for the same reason: nothing was signed.
    (status IN ('pending', 'consuming', 'cancelled', 'expired', 'audit_failed')
       AND tx_hash IS NULL AND failure_stage IS NULL)
    OR
    -- The bytes reached the network. `executed` has definitive evidence,
    -- `broadcast_unconfirmed` has none yet, `superseded_unproven` never will;
    -- all three have a hash, and none of them is a failure stage.
    (status IN ('executed', 'broadcast_unconfirmed', 'superseded_unproven')
       AND tx_hash IS NOT NULL AND failure_stage IS NULL)
    OR
    -- `failed` is governed entirely by the constraint below.
    status = 'failed'
  ),

  -- THE EVIDENCE RULE, part 2: `failed` splits by STAGE.
  --
  -- This is the reason `failure_stage` exists as a column. A chain revert is a
  -- real transaction and MUST carry the hash the operator reads the receipt
  -- from; a pre-broadcast failure and a crash before broadcast MUST NOT carry
  -- one, because a hash would assert a broadcast that never happened.
  -- `wallet_intents` has only the weaker "tx_hash MAY be set" rule, and its
  -- failed-with-hash rows are exactly why the money-state gate has to treat
  -- them as unresolved.
  --
  -- For a row that is not `failed` the leading disjunct is TRUE, so the
  -- `failure_stage` comparisons are never reached in Postgres regardless of
  -- their UNKNOWN value.
  CONSTRAINT wallet_transaction_intents_failed_evidence CHECK (
    status <> 'failed'
    OR (failure_stage = 'chain_reverted' AND tx_hash IS NOT NULL)
    OR (failure_stage IN ('pre_broadcast', 'crashed_before_broadcast') AND tx_hash IS NULL)
  )
);

-- Per-session listing and the money-state gate's session-scoped scan.
CREATE INDEX IF NOT EXISTS idx_wallet_transaction_intents_session
  ON wallet_transaction_intents (session_id);

-- TTL sweep (T7) hot path: only `pending` rows are candidates.
CREATE INDEX IF NOT EXISTS idx_wallet_transaction_intents_status_expires
  ON wallet_transaction_intents (status, expires_at)
  WHERE status = 'pending';

-- Repair-lane hot path (T5/T6): the small set of rows a chain observer owns.
CREATE INDEX IF NOT EXISTS idx_wallet_transaction_intents_unconfirmed
  ON wallet_transaction_intents (status)
  WHERE status IN ('consuming', 'broadcast_unconfirmed');

-- The activity link the repair lanes traverse when they terminalize an
-- activity row and have to settle the intent that owns it.
CREATE INDEX IF NOT EXISTS idx_wallet_transaction_intents_activity
  ON wallet_transaction_intents (activity_id)
  WHERE activity_id IS NOT NULL;

-- ── ACTIVITY VOCABULARY: kind `transaction` and its four roles ────────────
--
-- A generic signed transaction is NOT a transfer and it is NOT a swap. The
-- transfer arm (084) carries exactly one input leg, which a proposal Vex did
-- not build cannot honestly populate: an approve moves nothing, a contract call
-- moves whatever the contract decides, and an SPL instruction set may move
-- several things at once. Filing any of those under `transfer` would state an
-- asset and an amount nobody proved, and letting it fall through to the feed's
-- ELSE arm would render it as a spot trade with a route, a price and a
-- counterparty it never had - the exact falsehood migrations 051, 053 and 084
-- each record the cost of.
--
-- FOUR ROLES, one per DECODED EFFECT, so a feed can say what the transaction
-- did without re-decoding calldata:
--   tx_approve              an ERC-20 / Permit2 spending grant
--   tx_contract_call        any other decoded contract call
--   tx_native_transfer      `data = 0x` to an address proven to have no code
--   tx_spl_instruction_set  a decoded Solana instruction set
-- They are prefixed because this enum is global: a bare `approve` would sit
-- beside `allowance` and read as the same thing on a different arm.
--
-- THE ROWS CARRY NO LEGS. `agent_activity_second_leg_roles_only` (053/082) is
-- deliberately NOT restated: none of these roles appears in its allowlist,
-- which is the correct answer. The family-scoped nonce and Solana-evidence
-- CHECKs (045/049) are likewise untouched and are satisfied the same way the
-- transfer path satisfies them - the writer stages locally-signed evidence
-- BEFORE it broadcasts.
--
-- Every existing member below is carried across byte-for-byte from 084 (the
-- current state). A CHECK cannot be amended in place, so a restatement that
-- dropped a member would make those rows unwritable.

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_event_role_valid;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_event_role_valid
  CHECK (event_role IN (
    'allowance_reset', 'allowance', 'swap',
    'bridge_deposit', 'bridge_fee', 'bridge_fill_expected', 'bridge_fill_observed', 'bridge_refund',
    'lend_deposit', 'lend_withdraw', 'lend_borrow_operate',
    'predict_buy', 'predict_sell', 'predict_claim', 'predict_close',
    'wrap', 'unwrap',
    'yield_pt', 'yield_yt', 'yield_py', 'yield_lp', 'yield_sy', 'yield_claim',
    'token_launch',
    'trench_fee',
    'swap_fee',
    'pools_fee', 'pools_claim',
    'wallet_transfer',
    'tx_approve', 'tx_contract_call', 'tx_native_transfer', 'tx_spl_instruction_set'
  ));

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_valid;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_kind_valid
  CHECK (kind IN (
    'swap', 'bridge', 'lend', 'prediction', 'wrap', 'yield', 'launch', 'claim',
    'transfer', 'transaction'
  ));

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_role_binding;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_kind_role_binding
  CHECK (
    (kind = 'swap'   AND event_role IN ('allowance_reset', 'allowance', 'swap', 'trench_fee', 'swap_fee'))
    OR
    (kind = 'bridge' AND event_role IN (
      'allowance_reset', 'allowance',
      'bridge_deposit', 'bridge_fee',
      'bridge_fill_expected', 'bridge_fill_observed', 'bridge_refund'
    ))
    OR
    (kind = 'lend' AND event_role IN (
      'allowance_reset', 'allowance',
      'lend_deposit', 'lend_withdraw', 'lend_borrow_operate'
    ))
    OR
    (kind = 'prediction' AND event_role IN (
      'predict_buy', 'predict_sell', 'predict_claim', 'predict_close'
    ))
    OR
    (kind = 'wrap' AND event_role IN ('wrap', 'unwrap'))
    OR
    (kind = 'yield' AND event_role IN (
      'allowance_reset', 'allowance',
      'yield_pt', 'yield_yt', 'yield_py', 'yield_lp', 'yield_sy', 'yield_claim'
    ))
    OR
    (kind = 'launch' AND event_role IN (
      'allowance_reset', 'allowance',
      'token_launch', 'trench_fee',
      'pools_fee'
    ))
    OR
    (kind = 'claim' AND event_role IN ('pools_claim'))
    OR
    (kind = 'transfer' AND event_role IN ('wallet_transfer'))
    OR
    (kind = 'transaction' AND event_role IN (
      'tx_approve', 'tx_contract_call', 'tx_native_transfer', 'tx_spl_instruction_set'
    ))
  );
