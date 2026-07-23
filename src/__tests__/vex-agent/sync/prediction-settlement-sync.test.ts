/**
 * Prediction settlement sync tests — Jupiter reconciliation.
 *
 * Tests: settlement detection, synthetic capture semantics, idempotency, error handling.
 * Polymarket half removed with the total Polymarket teardown (plan §4.6/§4.3) —
 * `prediction-settlement-jupiter-boundary.test.ts` additionally pins that the
 * Jupiter path resolves correctly with zero Polymarket wiring present.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────

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

const { reconcilePredictionSettlements } = await import("../../../vex-agent/sync/prediction-settlement-sync.js");

// ── Tests ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reconcilePredictionSettlements — no positions", () => {
  it("returns early with zero counts when no open positions", async () => {
    mockQuery.mockResolvedValue([]);
    const result = await reconcilePredictionSettlements();
    expect(result).toEqual({ checked: 0, closed: 0, skipped: 0, errors: 0 });
    expect(mockGetHistory).not.toHaveBeenCalled();
  });
});

describe("reconcilePredictionSettlements — Jupiter", () => {
  const jupiterPosition = {
    id: 1, namespace: "solana", instrument_key: "solana:predict:POLY-123:yes",
    position_key: "PK1", wallet_address: "GoVYsnz...", contracts: "3",
    notional_usd: "1680000", data: {},
  };

  it("closes position on position_lost", async () => {
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
    expect(mockRecordSyntheticCapture).toHaveBeenCalledTimes(1);

    const capture = mockRecordSyntheticCapture.mock.calls[0][0].tradeCapture;
    expect(capture.status).toBe("closed");
    expect(capture.outputValueUsd).toBeUndefined();
    expect(capture.meta.eventType).toBe("position_lost");
    expect(capture.meta.realizedPnl).toBe("-1640000");
  });

  it("closes position_won + !claimed without outputValueUsd", async () => {
    mockQuery.mockResolvedValue([jupiterPosition]);
    mockGetHistory.mockResolvedValue({
      data: [{
        positionPubkey: "PK1", eventType: "position_won",
        contractsSettled: "3", realizedPnl: "1320000",
        payoutAmountUsd: "3000000", grossProceedsUsd: "3000000",
        totalCostUsd: "1680000", timestamp: 1712000000,
      }],
    });
    mockGetPositions.mockResolvedValue({
      data: [{ pubkey: "PK1", claimed: false }],
    });

    const result = await reconcilePredictionSettlements();
    expect(result.closed).toBe(1);

    const capture = mockRecordSyntheticCapture.mock.calls[0][0].tradeCapture;
    expect(capture.status).toBe("closed");
    expect(capture.outputValueUsd).toBeUndefined();
    expect(capture.meta.payoutAmountUsd).toBe("3000000");
  });

  it("claims position_won + claimed=true with outputValueUsd", async () => {
    mockQuery.mockResolvedValue([jupiterPosition]);
    mockGetHistory.mockResolvedValue({
      data: [{
        positionPubkey: "PK1", eventType: "position_won",
        contractsSettled: "3", realizedPnl: "1320000",
        payoutAmountUsd: "3000000", grossProceedsUsd: "3000000",
        totalCostUsd: "1680000", timestamp: 1712000000,
      }],
    });
    mockGetPositions.mockResolvedValue({
      data: [{ pubkey: "PK1", claimed: true }],
    });

    const result = await reconcilePredictionSettlements();
    expect(result.closed).toBe(1);

    const capture = mockRecordSyntheticCapture.mock.calls[0][0].tradeCapture;
    expect(capture.status).toBe("claimed");
    expect(capture.outputValueUsd).toBe("3000000");
    expect(capture.valuationSource).toBe("prediction_exact");
  });

  it("skips position with no matching settlement event", async () => {
    mockQuery.mockResolvedValue([jupiterPosition]);
    mockGetHistory.mockResolvedValue({ data: [] });
    mockGetPositions.mockResolvedValue({ data: [] });

    const result = await reconcilePredictionSettlements();
    expect(result.skipped).toBe(1);
    expect(result.closed).toBe(0);
    expect(mockRecordSyntheticCapture).not.toHaveBeenCalled();
  });
});

describe("settlement sync — pipeline failure path", () => {
  const jupiterPosition = {
    id: 1, namespace: "solana", instrument_key: "solana:predict:POLY-123:yes",
    position_key: "PK_FAIL", wallet_address: "GoVYsnz...", contracts: "3",
    notional_usd: "1680000", data: {},
  };

  it("counts errors (not closed) when recordSyntheticCapture throws", async () => {
    mockQuery.mockResolvedValue([jupiterPosition]);
    mockGetHistory.mockResolvedValue({
      data: [{
        positionPubkey: "PK_FAIL", eventType: "position_lost",
        contractsSettled: "3", realizedPnl: "-1640000",
        payoutAmountUsd: "0", grossProceedsUsd: "0",
        totalCostUsd: "1680000", timestamp: 1712000000,
      }],
    });
    mockGetPositions.mockResolvedValue({ data: [] });

    // Simulate pipeline failure
    mockRecordSyntheticCapture.mockRejectedValueOnce(new Error("populateCaptureItems failed"));

    const result = await reconcilePredictionSettlements();
    expect(result.closed).toBe(0);
    expect(result.errors).toBe(1);
  });
});
