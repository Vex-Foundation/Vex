/**
 * Prediction settlement sync — Jupiter closure survives without Polymarket
 * wiring present (W0 gap-fill / module-boundary pin).
 *
 * `prediction-settlement-sync.test.ts` already pins the Jupiter closure
 * semantics thoroughly (position_lost / position_won unclaimed / claimed /
 * no-match-skip / capture-throw error), but it mocks BOTH
 * `@tools/polymarket/data/client.js` and `@tools/polymarket/relayer/client.js`
 * unconditionally at module scope alongside the Jupiter mocks — so it cannot
 * prove the Jupiter path is independent of Polymarket wiring.
 *
 * Plan §4.6 deletes the entire Polymarket integration; §4.3/§8.3 preserve
 * `reconcilePredictionSettlements`'s Jupiter half via a SURGICAL edit to
 * `prediction-settlement-sync.ts` (the Polymarket branch is removed, the
 * Jupiter branch is untouched). This file mocks ONLY the Jupiter service —
 * no Polymarket module is mocked or imported at all — and proves Jupiter
 * closure still resolves correctly with zero open Polymarket positions in
 * play, i.e. the exact post-teardown shape of this module's namespace
 * dispatch (the `namespace === "polymarket"` branch is simply never taken).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockRecordSyntheticCapture = vi.fn().mockResolvedValue(1);
const mockGetHistory = vi.fn();
const mockGetPositions = vi.fn();

vi.mock("@vex-agent/db/client.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: vi.fn().mockResolvedValue(null),
  execute: vi.fn().mockResolvedValue(1),
  getPool: vi.fn(),
}));

vi.mock("../../../vex-agent/sync/synthetic-capture.js", () => ({
  recordSyntheticCapture: (...args: unknown[]) => mockRecordSyntheticCapture(...args),
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js", () => ({
  getJupiterPredictionHistory: (...args: unknown[]) => mockGetHistory(...args),
  getJupiterPredictionPositions: (...args: unknown[]) => mockGetPositions(...args),
}));

// Deliberately NO vi.mock for @tools/polymarket/data/client.js or
// @tools/polymarket/relayer/client.js — those modules are never touched
// because no fixture below carries namespace: "polymarket".

const { reconcilePredictionSettlements } = await import("../../../vex-agent/sync/prediction-settlement-sync.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reconcilePredictionSettlements — Jupiter closure, zero Polymarket wiring", () => {
  const jupiterPosition = {
    id: 1, namespace: "solana", instrument_key: "solana:predict:POLY-123:yes",
    position_key: "PK1", wallet_address: "GoVYsnz...", contracts: "3",
    notional_usd: "1680000", data: {},
  };

  it("closes a lost Jupiter position with no Polymarket module loaded", async () => {
    mockQuery.mockResolvedValue([jupiterPosition]);
    mockGetHistory.mockResolvedValue({
      data: [{
        positionPubkey: "PK1", eventType: "position_lost",
        contractsSettled: "3", realizedPnl: "-1640000",
        payoutAmountUsd: "0", grossProceedsUsd: "0",
        totalCostUsd: "1680000", timestamp: 1712000000,
      }],
    });
    mockGetPositions.mockResolvedValue({ data: [] });

    const result = await reconcilePredictionSettlements();
    expect(result.closed).toBe(1);
    expect(result.errors).toBe(0);
    const capture = mockRecordSyntheticCapture.mock.calls[0]![0].tradeCapture;
    expect(capture.status).toBe("closed");
    expect(capture.meta.eventType).toBe("position_lost");
  });

  it("claims a won+claimed Jupiter position with outputValueUsd, no Polymarket module loaded", async () => {
    mockQuery.mockResolvedValue([jupiterPosition]);
    mockGetHistory.mockResolvedValue({
      data: [{
        positionPubkey: "PK1", eventType: "position_won",
        contractsSettled: "3", realizedPnl: "1320000",
        payoutAmountUsd: "3000000", grossProceedsUsd: "3000000",
        totalCostUsd: "1680000", timestamp: 1712000000,
      }],
    });
    mockGetPositions.mockResolvedValue({ data: [{ pubkey: "PK1", claimed: true }] });

    const result = await reconcilePredictionSettlements();
    expect(result.closed).toBe(1);
    const capture = mockRecordSyntheticCapture.mock.calls[0]![0].tradeCapture;
    expect(capture.status).toBe("claimed");
    expect(capture.outputValueUsd).toBe("3000000");
  });

  it("groups are namespace-partitioned: a non-solana/non-polymarket namespace is skipped without any API call", async () => {
    mockQuery.mockResolvedValue([{ ...jupiterPosition, namespace: "hyperliquid" }]);
    const result = await reconcilePredictionSettlements();
    expect(result.skipped).toBe(1);
    expect(mockGetHistory).not.toHaveBeenCalled();
    expect(mockRecordSyntheticCapture).not.toHaveBeenCalled();
  });
});
