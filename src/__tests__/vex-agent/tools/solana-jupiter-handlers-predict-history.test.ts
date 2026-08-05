import { describe, it, expect, vi, beforeEach } from "vitest";

import { ctx } from "./_solana-jupiter-handlers-context.js";

/**
 * History domain split out of solana-jupiter-handlers-predict.test.ts (F1,
 * over the 500-line cap) — pagination window + positionPubkey/id filter
 * behavior for solana.predict.history. Money-conversion assertions for this
 * same handler's realizedPnl/transferAmountToken fields live in the sibling
 * solana-jupiter-handlers-predict-money.test.ts (W1-B).
 */
const { getJupiterPredictionHistory } = vi.hoisted(() => ({
  getJupiterPredictionHistory: vi.fn(),
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js", () => ({
  getJupiterPredictionHistory,
  // Re-exported by the handler module but unused by these tests; provide inert
  // stubs so the mock fully replaces the real (network-bound) module.
  getJupiterPredictionEvents: vi.fn(),
  searchJupiterPredictionEvents: vi.fn(),
  getJupiterPredictionEvent: vi.fn(),
  getJupiterPredictionPositions: vi.fn(),
  getJupiterPredictionPosition: vi.fn(),
  getJupiterPredictionMarket: vi.fn(),
  executeJupiterPredictionCreateOrder: vi.fn(),
  executeJupiterPredictionClosePosition: vi.fn(),
  executeJupiterPredictionCloseAllPositions: vi.fn(),
  executeJupiterPredictionClaimPosition: vi.fn(),
}));

import { SOLANA_JUPITER_HANDLERS } from "../../../vex-agent/tools/protocols/solana-jupiter/handlers.js";

describe("solana-jupiter handlers — predict history", () => {
  beforeEach(() => {
    getJupiterPredictionHistory.mockReset();
  });

  it("history: defaults to start=0,end=20 (default limit raised 10→20) and rejects an out-of-range window", async () => {
    getJupiterPredictionHistory.mockResolvedValue({ data: [], pagination: { start: 0, end: 20, total: 0, hasNext: false } });
    await SOLANA_JUPITER_HANDLERS["solana.predict.history"]!(
      { walletAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
      ctx(),
    );
    expect(getJupiterPredictionHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerPubkey: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        start: 0,
        end: 20,
      }),
    );

    const negative = await SOLANA_JUPITER_HANDLERS["solana.predict.history"]!(
      { walletAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", offset: -1 },
      ctx(),
    );
    expect(negative.success).toBe(false);
    expect(negative.output).toContain("offset");

    const tooLarge = await SOLANA_JUPITER_HANDLERS["solana.predict.history"]!(
      { walletAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", limit: 500 },
      ctx(),
    );
    expect(tooLarge.success).toBe(false);
    expect(tooLarge.output).toContain("limit");
  });

  it("history: passes positionPubkey/id filters through to the SDK", async () => {
    getJupiterPredictionHistory.mockResolvedValue({ data: [], pagination: { start: 0, end: 20, total: 0, hasNext: false } });
    await SOLANA_JUPITER_HANDLERS["solana.predict.history"]!(
      {
        walletAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        positionPubkey: "Position1111111111111111111111111111111",
        id: 42,
      },
      ctx(),
    );
    expect(getJupiterPredictionHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerPubkey: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        positionPubkey: "Position1111111111111111111111111111111",
        id: 42,
      }),
    );
  });

  it("history: omitted positionPubkey/id are undefined, not empty strings", async () => {
    getJupiterPredictionHistory.mockResolvedValue({ data: [], pagination: { start: 0, end: 20, total: 0, hasNext: false } });
    await SOLANA_JUPITER_HANDLERS["solana.predict.history"]!(
      { walletAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
      ctx(),
    );
    const call = getJupiterPredictionHistory.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.positionPubkey).toBeUndefined();
    expect(call.id).toBeUndefined();
  });
});
