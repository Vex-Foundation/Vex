import { describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
const execute = vi.fn();
const withTransaction = vi.fn(async (run) => run({ query }));

vi.mock("@vex-agent/db/client.js", () => ({ query, queryOne, execute, withTransaction }));

const { HYPERLIQUID_CANDLE_RING_SIZE, upsertHyperliquidCandles } = await import("@vex-agent/db/repos/hyperliquid-candles.js");

describe("Hyperliquid candle repository", () => {
  it("enforces the 5,000-row ring bound after an upsert batch", async () => {
    const rows = Array.from({ length: HYPERLIQUID_CANDLE_RING_SIZE + 1 }, (_, openTimeMs) => ({
      coin: "BTC", interval: "1h" as const, openTimeMs,
      open: "100", high: "110", low: "90", close: "105", volume: "10",
    }));

    await upsertHyperliquidCandles(rows);

    const prune = query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("DELETE FROM hyperliquid_candles"));
    expect(prune?.[1]).toEqual(["BTC", "1h", 5_000]);
  });
});
