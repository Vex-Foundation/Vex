-- WATCHLIST AND PRICE ALERTS: the tokens the user follows and the price
-- alerts that notify them once (F01).
--
-- WHY THIS EXISTS. Desktop already reads token prices on a timer, but only to
-- wake a parked agent session (`token_price` wake watch): that watch needs a
-- session, needs inference and shares a 12-token budget with every agent. A
-- user alert has no session, must fire while the vault is locked and with no
-- model at all, so it lives in its own two tables and its own poller.
--
-- NOTHING HERE TRADES. A row is a bookmark or a notify-once condition. No
-- column names a wallet, an amount to spend or an order.
--
-- One install, one user: no user_id column.
--
-- watchlist_items      one row per followed token.
--   asset_kind         'token' only in this version.
--   chain              the canonical DexScreener slug `resolveWatchChain`
--                      returns (an EVM slug or 'solana').
--   address            lowercase on EVM, base58 as written on Solana
--                      (`normalizeAddressForFamily`).
--   asset_key          '<chain>:<address>', unique.
--   label              what the page shows; the pool's symbol or the user's
--                      own words, 1 to 80 characters.
--
-- price_alerts         one row per alert, active or done.
--   condition          'above' / 'below': the price reaches a level;
--                      'rises_pct' / 'falls_pct': the price moves a
--                      percentage from the price when the alert was set.
--   value              what the user said: a USD price or a percent.
--   reference_price    the price when the alert was set (what a move
--                      measures from).
--   trigger_price      the absolute level the poller compares against,
--                      computed once at creation with exact decimals.
--   direction          which side of trigger_price fires ('above' fires at
--                      or over it, 'below' at or under it). Touching counts.
--   origin             'chat' (an agent tool, in session_id) or 'app' (the
--                      Watchlist page).
--   status             'active' until it fires ('triggered') or the user
--                      cancels it ('cancelled').
--   triggered_*        the time and the price it fired at.
--   acknowledged_at    when the user closed the fired notice; a fired alert
--                      with this NULL is replayed to the app on next start.
--
-- The partial UNIQUE index on (asset_key, condition, value) among ACTIVE
-- alerts makes a replayed set return the alert that already exists instead of
-- a second one.
--
-- IDEMPOTENT: CREATE ... IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS watchlist_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_kind  TEXT NOT NULL CHECK (asset_kind IN ('token')),
  chain       TEXT NOT NULL CHECK (char_length(chain) BETWEEN 1 AND 64),
  address     TEXT NOT NULL CHECK (char_length(address) BETWEEN 1 AND 128),
  asset_key   TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_alerts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_kind       TEXT NOT NULL CHECK (asset_kind IN ('token')),
  chain            TEXT NOT NULL CHECK (char_length(chain) BETWEEN 1 AND 64),
  address          TEXT NOT NULL CHECK (char_length(address) BETWEEN 1 AND 128),
  asset_key        TEXT NOT NULL,
  label            TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  condition        TEXT NOT NULL CHECK (condition IN ('above', 'below', 'rises_pct', 'falls_pct')),
  value            NUMERIC NOT NULL CHECK (value > 0),
  reference_price  NUMERIC NOT NULL CHECK (reference_price > 0),
  trigger_price    NUMERIC NOT NULL CHECK (trigger_price > 0),
  direction        TEXT NOT NULL CHECK (direction IN ('above', 'below')),
  note             TEXT CHECK (note IS NULL OR char_length(note) <= 140),
  origin           TEXT NOT NULL CHECK (origin IN ('chat', 'app')),
  session_id       TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'triggered', 'cancelled')),
  triggered_at     TIMESTAMPTZ,
  triggered_price  NUMERIC CHECK (triggered_price IS NULL OR triggered_price > 0),
  acknowledged_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT price_alerts_triggered_fields_chk CHECK (
    status <> 'triggered' OR (triggered_at IS NOT NULL AND triggered_price IS NOT NULL)
  )
);

-- The poller's read: active alerts only.
CREATE INDEX IF NOT EXISTS price_alerts_active_asset_idx
  ON price_alerts (asset_key) WHERE status = 'active';

-- A replayed set finds the alert that already waits.
CREATE UNIQUE INDEX IF NOT EXISTS price_alerts_active_unique_idx
  ON price_alerts (asset_key, condition, value) WHERE status = 'active';

-- The Fired list, newest first.
CREATE INDEX IF NOT EXISTS price_alerts_status_triggered_idx
  ON price_alerts (status, triggered_at DESC);
