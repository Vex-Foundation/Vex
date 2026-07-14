-- Durable, bounded Hyperliquid candle cache for agent-side analysis.
-- Candle values remain canonical decimal text so scans never use binary floats.

CREATE TABLE IF NOT EXISTS hyperliquid_candles (
  coin          TEXT NOT NULL,
  interval      TEXT NOT NULL,
  open_time_ms  BIGINT NOT NULL CHECK (open_time_ms >= 0),
  open          TEXT NOT NULL,
  high          TEXT NOT NULL,
  low           TEXT NOT NULL,
  close         TEXT NOT NULL,
  volume        TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (coin, interval, open_time_ms)
);

CREATE INDEX IF NOT EXISTS idx_hyperliquid_candles_pair_newest
  ON hyperliquid_candles (coin, interval, open_time_ms DESC);

CREATE TABLE IF NOT EXISTS hyperliquid_candle_watches (
  coin        TEXT NOT NULL,
  interval    TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (coin, interval)
);

CREATE INDEX IF NOT EXISTS idx_hyperliquid_candle_watches_enabled
  ON hyperliquid_candle_watches (enabled, updated_at DESC);
