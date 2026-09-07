-- 090_lighter_integration_settings.sql — public-scope user activation only.
--
-- This table stores no credential or authorization. Enabling a row does not
-- approve deposits, key registration,
-- orders, transfers, or withdrawals.

CREATE TABLE IF NOT EXISTS lighter_integration_settings (
  environment    TEXT NOT NULL CHECK (environment IN ('core', 'rhc')),
  wallet_address TEXT NOT NULL CHECK (
    wallet_address = LOWER(wallet_address)
    AND wallet_address ~ '^0x[0-9a-f]{40}$'
  ),
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at      TIMESTAMPTZ,
  disabled_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (environment, wallet_address),
  CHECK (NOT enabled OR enabled_at IS NOT NULL)
);
