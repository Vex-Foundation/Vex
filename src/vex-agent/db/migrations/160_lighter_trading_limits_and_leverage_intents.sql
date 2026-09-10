-- Lighter trading limits, leverage intents and the capital-commitment ledger.
--
-- THREE TABLES, THREE DIFFERENT CONTRACTS. Read this header before adding a
-- column to any of them.
--
-- 1. `lighter_trading_limits` is USER PREFERENCE. The agent reads the capital
--    share as information and never as authority: the privileged executor
--    enforces it. A row here approves nothing, signs nothing and grants no
--    capability. `revision` is the compare-and-set token a Settings surface
--    holds while a person edits, so a second editor is told rather than
--    overwritten.
--
-- 2. `lighter_leverage_intents` is AUDIT AND RECONCILIATION of one
--    user-originated leverage change. It is NOT a cache of the account's
--    leverage: Lighter owns that number, the app reads it live wherever it is
--    shown or used, and a local copy would go stale the moment the user
--    touches Lighter's own interface. What is stored here is the consent that
--    was captured, the identity of the transaction that carried it, and enough
--    evidence for a later process to prove the outcome without signing again.
--
-- 3. `lighter_capital_commitments` is VEX'S OWN IN-FLIGHT ACCOUNTING. Admission
--    inserts a row inside the same transaction that decides the order fits the
--    user's share, under an account-scoped advisory lock, so two sessions
--    racing towards the same budget serialize instead of both being admitted.
--    The ledger is complete per account by construction: every commitment Vex
--    makes is a row, so summing the live rows for an account is the whole of
--    what Vex has promised on it. It is never derived from a bounded repair
--    listing.
--
-- Public consent and transaction identity only. Private keys, signatures,
-- signed transaction payloads, auth tokens and decrypted vault material must
-- never be stored in any of these tables.

CREATE TABLE IF NOT EXISTS lighter_trading_limits (
  environment                 TEXT NOT NULL CHECK (environment IN ('core', 'rhc')),
  wallet_address              TEXT NOT NULL CHECK (
    wallet_address = LOWER(wallet_address)
    AND wallet_address ~ '^0x[0-9a-f]{40}$'
  ),
  -- NULL means "no ceiling", the owner's chosen default. 0 is deliberately not
  -- accepted: a share of nothing is expressed by disabling the integration,
  -- not by a limit that silently refuses every order.
  agent_capital_share_percent INTEGER CHECK (
    agent_capital_share_percent IS NULL
    OR agent_capital_share_percent BETWEEN 1 AND 100
  ),
  revision                    BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (environment, wallet_address)
);

CREATE TABLE IF NOT EXISTS lighter_leverage_intents (
  intent_id                          TEXT PRIMARY KEY,
  environment                        TEXT NOT NULL CHECK (environment IN ('core', 'rhc')),
  wallet_address                     TEXT NOT NULL CHECK (
    wallet_address = LOWER(wallet_address)
    AND wallet_address ~ '^0x[0-9a-f]{40}$'
  ),
  account_index                      BIGINT NOT NULL CHECK (account_index >= 0),
  api_key_index                      INTEGER NOT NULL CHECK (api_key_index BETWEEN 4 AND 254),
  market_index                       INTEGER NOT NULL CHECK (market_index BETWEEN 0 AND 254),
  -- The provider's own 10000 scale. Resolved and FROZEN at proposal time, so
  -- "max" can never mean one thing on the confirmation card and another at
  -- signing.
  requested_initial_margin_fraction  INTEGER NOT NULL CHECK (
    requested_initial_margin_fraction BETWEEN 1 AND 10000
  ),
  requested_margin_mode              INTEGER NOT NULL CHECK (requested_margin_mode IN (0, 1)),
  -- The terms the human consented to: current fraction and mode, open position
  -- size and side, the market minimum, and the observations shown beside them.
  observed_before_json               JSONB NOT NULL,
  execution_state                    TEXT NOT NULL DEFAULT 'proposed' CHECK (
    execution_state IN (
      -- Main issued the proposal; nothing is signed and no nonce is held.
      'proposed',
      -- The confirmation window closed with no Confirm. Terminal.
      'expired',
      -- Confirm arrived and consent was recorded, then the change was refused
      -- with NOTHING SIGNED: either a live invariant refused it before the
      -- reservation, or the attempt was interrupted before the signer produced
      -- a hash. Terminal, and there is no transaction identity to retain.
      'refused_unsubmitted',
      'signing',
      'signed',
      'submission_staged',
      'submitted',
      'completed',
      'ambiguous',
      'rejected',
      -- SIGNED, then consent or the wire expiry elapsed with NO send attempt
      -- started. Terminal; the hash is retained, which is what distinguishes
      -- this state from `refused_unsubmitted`.
      'expired_unsubmitted'
    )
  ),
  -- When the person pressed Confirm. This is the consent record for a
  -- user-originated Settings action, which has no approval-queue row.
  consented_at                       TIMESTAMPTZ,
  -- What the live re-read showed at Confirm, beside the bound terms.
  revalidation_json                  JSONB,
  nonce_value                        TEXT CHECK (nonce_value IS NULL OR nonce_value ~ '^[0-9]+$'),
  -- The WIRE expiry of the signed transaction, persisted in the SAME
  -- transaction as the nonce reservation so a crash between them is impossible.
  tx_expiry_ms                       BIGINT CHECK (tx_expiry_ms IS NULL OR tx_expiry_ms > 0),
  signer_tx_hash                     TEXT CHECK (signer_tx_hash IS NULL OR signer_tx_hash ~ '^[0-9a-f]{1,128}$'),
  -- Set in the statement that immediately precedes sendTx. Marks a POSSIBLE
  -- send attempt, never proof that bytes reached Lighter.
  send_attempt_started_at            TIMESTAMPTZ,
  provider_outcome_json              JSONB,
  failure_reason                     TEXT CHECK (
    failure_reason IS NULL OR failure_reason ~ '^[a-z0-9_.-]{1,120}$'
  ),
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The CONSENT expiry: the moment main issued the proposal plus the
  -- confirmation window. Confirm never refreshes it.
  expires_at                         TIMESTAMPTZ NOT NULL,
  -- Consent exists for exactly the states that were reached through Confirm.
  CHECK ((execution_state IN ('proposed', 'expired')) = (consented_at IS NULL)),
  -- A reserved nonce and its wire expiry are committed together, before signing.
  CHECK (
    execution_state IN ('proposed', 'expired', 'refused_unsubmitted')
    OR (nonce_value IS NOT NULL AND tx_expiry_ms IS NOT NULL)
  ),
  -- Nothing past `signing` may claim a transaction without the signed identity.
  -- `expired_unsubmitted` is NOT exempt: its claim is "this signature exists
  -- and was never sent", so a row with no hash belongs in
  -- `refused_unsubmitted`, whose claim is that nothing was ever signed.
  CHECK (
    execution_state IN ('proposed', 'expired', 'refused_unsubmitted', 'signing')
    OR signer_tx_hash IS NOT NULL
  ),
  -- A state before signing may not carry signing evidence.
  CHECK (
    execution_state NOT IN ('proposed', 'expired', 'refused_unsubmitted')
    OR (signer_tx_hash IS NULL AND send_attempt_started_at IS NULL)
  ),
  -- `expired_unsubmitted` may not claim "never sent" while a send attempt was
  -- started. This is the honest half of that state and the one recovery relies
  -- on: it is what makes releasing the nonce reservation safe.
  CHECK (
    execution_state <> 'expired_unsubmitted'
    OR send_attempt_started_at IS NULL
  )
);

-- One live leverage change per account and market. A second Apply is refused
-- by the database rather than by a check the caller could forget.
CREATE UNIQUE INDEX IF NOT EXISTS lighter_leverage_one_live_market
  ON lighter_leverage_intents(environment, account_index, market_index)
  WHERE execution_state NOT IN (
    'expired', 'refused_unsubmitted', 'completed', 'rejected', 'expired_unsubmitted'
  );

CREATE INDEX IF NOT EXISTS lighter_leverage_unresolved
  ON lighter_leverage_intents(environment, account_index, updated_at)
  WHERE execution_state IN (
    'signing', 'signed', 'submission_staged', 'submitted', 'ambiguous'
  );

CREATE TABLE IF NOT EXISTS lighter_capital_commitments (
  commitment_id  TEXT PRIMARY KEY,
  environment    TEXT NOT NULL CHECK (environment IN ('core', 'rhc')),
  account_index  BIGINT NOT NULL CHECK (account_index >= 0),
  -- One commitment per intent: a revalidation re-admits the SAME intent id
  -- after excluding its own earlier row, it never stacks a second commitment.
  intent_id      TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN ('create', 'modify', 'leverage')),
  -- USDC-6 integer string. Never a float: this figure is compared against a
  -- budget derived from real collateral.
  required_units TEXT NOT NULL CHECK (required_units ~ '^[0-9]+$'),
  state          TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'retired')),
  admitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at     TIMESTAMPTZ,
  retire_reason  TEXT CHECK (retire_reason IS NULL OR retire_reason ~ '^[a-z0-9_.-]{1,120}$'),
  CHECK (
    (state = 'live' AND retired_at IS NULL AND retire_reason IS NULL)
    OR (state = 'retired' AND retired_at IS NOT NULL AND retire_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS lighter_capital_commitments_live_account
  ON lighter_capital_commitments(environment, account_index)
  WHERE state = 'live';
