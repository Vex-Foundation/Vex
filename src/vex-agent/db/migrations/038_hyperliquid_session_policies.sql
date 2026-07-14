-- Hyperliquid user-confirmed, session-scoped risk policies.
--
-- Proposal rows are immutable: a user adjustment creates another proposal
-- rather than overwriting the agent proposal they reviewed. Only lifecycle
-- columns transition. The active partial unique index makes the resolved
-- policy unambiguous for a (session, selected EVM wallet) pair.

CREATE TABLE IF NOT EXISTS hyperliquid_session_policies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  wallet_address  TEXT NOT NULL,
  coin            TEXT NOT NULL,
  proposal_id     UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  policy_json     JSONB NOT NULL,
  policy_version  INTEGER NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  proposed_by     TEXT NOT NULL CHECK (proposed_by IN ('agent', 'user')),
  status          TEXT NOT NULL CHECK (status IN ('proposed', 'active', 'expired', 'revoked')),
  confirmed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hyperliquid_session_policies_session_wallet
  ON hyperliquid_session_policies (session_id, wallet_address, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hyperliquid_session_policies_one_active
  ON hyperliquid_session_policies (session_id, wallet_address)
  WHERE status = 'active';
