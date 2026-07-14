import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const migration = readFileSync(path.join(root, "src/vex-agent/db/migrations/040_hyperliquid_candles.sql"), "utf8");

describe("040 Hyperliquid candle migration", () => {
  it("creates an OHLCV composite primary key and durable watch registry", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS hyperliquid_candles/i);
    expect(migration).toMatch(/PRIMARY KEY \(coin, interval, open_time_ms\)/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS hyperliquid_candle_watches/i);
    expect(migration).toMatch(/enabled\s+BOOLEAN NOT NULL DEFAULT TRUE/i);
  });
});
