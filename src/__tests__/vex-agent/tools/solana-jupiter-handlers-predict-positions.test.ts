import { describe, it, expect, vi, beforeEach } from "vitest";

import { ctx } from "./_solana-jupiter-handlers-context.js";
import { providerHttpError } from "./_provider-http-error.js";

/**
 * Positions domain (list + single) split out of solana-jupiter-handlers-
 * predict.test.ts (F1, over the 500-line cap) — projection/pagination/
 * filter behavior for solana.predict.positions and solana.predict.position.
 * Money conversion follows the W1-B convention (exact-decimal USD string +
 * raw `*Micro` sibling).
 */
const {
  getJupiterPredictionPositions,
  getJupiterPredictionPosition,
} = vi.hoisted(() => ({
  getJupiterPredictionPositions: vi.fn(),
  getJupiterPredictionPosition: vi.fn(),
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js", () => ({
  getJupiterPredictionPositions,
  getJupiterPredictionPosition,
  // Re-exported by the handler module but unused by these tests; provide inert
  // stubs so the mock fully replaces the real (network-bound) module.
  getJupiterPredictionEvents: vi.fn(),
  searchJupiterPredictionEvents: vi.fn(),
  getJupiterPredictionEvent: vi.fn(),
  getJupiterPredictionHistory: vi.fn(),
  getJupiterPredictionMarket: vi.fn(),
  executeJupiterPredictionCreateOrder: vi.fn(),
  executeJupiterPredictionClosePosition: vi.fn(),
  executeJupiterPredictionCloseAllPositions: vi.fn(),
  executeJupiterPredictionClaimPosition: vi.fn(),
}));

const FULL_POSITION = {
  pubkey: "pos-1",
  owner: "owner-1",
  ownerPubkey: "owner-1",
  market: "mkt-acct",
  marketId: "mkt-1",
  marketIdHash: "hash",
  isYes: true,
  contracts: "10",
  // F2: exact-accounting siblings — the docs say the legacy `contracts`
  // field alone "must not be used for accounting".
  contractsMicro: "10000000",
  contractsDecimal: "10",
  totalCostUsd: "6000000",
  // Realistic micro-USD strings: sizeUsd 6000000 = $6.00, valueUsd 7000000 =
  // $7.00, avgPriceUsd 600000 = $0.60, markPriceUsd 700000 = $0.70,
  // pnlUsd 1000000 = $1.00, payoutUsd 10000000 = $10.00.
  sizeUsd: "6000000",
  valueUsd: "7000000",
  avgPriceUsd: "600000",
  markPriceUsd: "700000",
  sellPriceUsd: "700000",
  pnlUsd: "1000000",
  pnlUsdPercent: 16,
  pnlUsdAfterFees: "900000",
  pnlUsdAfterFeesPercent: 15,
  openOrders: 0,
  feesPaidUsd: "100000",
  realizedPnlUsd: 0,
  claimed: false,
  claimedUsd: "0",
  openedAt: 1,
  updatedAt: 2,
  claimableAt: null,
  payoutUsd: "10000000",
  bump: 1,
  eventId: "evt-1",
  eventMetadata: { eventId: "evt-1", title: "Event title", subtitle: "Event sub", slug: "slug-drop", series: "series-drop", closeTime: "2026-01-01", imageUrl: "https://img/drop.png" },
  marketMetadata: { marketId: "mkt-1", eventId: "evt-1", title: "Market title", subtitle: "Market sub", status: "open", result: null },
  settlementDate: null,
  claimable: false,
};

import { SOLANA_JUPITER_HANDLERS } from "../../../vex-agent/tools/protocols/solana-jupiter/handlers.js";

describe("solana-jupiter handlers — predict positions", () => {
  beforeEach(() => {
    getJupiterPredictionPositions.mockReset();
    getJupiterPredictionPosition.mockReset();
  });

  it("positions: rejects a negative offset instead of clamping", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.positions"]!(
      { address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", offset: -2 },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("offset");
    expect(getJupiterPredictionPositions).not.toHaveBeenCalled();
  });

  it("positions: rejects a limit outside 1-100 instead of clamping", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.positions"]!(
      { address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", limit: -10 },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("limit");
    expect(getJupiterPredictionPositions).not.toHaveBeenCalled();
  });

  it("positions: passes marketPubkey/marketId/isYes filters through to the SDK", async () => {
    getJupiterPredictionPositions.mockResolvedValue({ data: [], pagination: { start: 0, end: 20, total: 0, hasNext: false } });
    await SOLANA_JUPITER_HANDLERS["solana.predict.positions"]!(
      {
        address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        marketPubkey: "MarketAcct111111111111111111111111111111",
        marketId: "mkt-1",
        isYes: true,
      },
      ctx(),
    );
    expect(getJupiterPredictionPositions).toHaveBeenCalledWith(
      expect.objectContaining({
        marketPubkey: "MarketAcct111111111111111111111111111111",
        marketId: "mkt-1",
        isYes: true,
      }),
    );
  });

  it("positions: omitted marketPubkey/marketId/isYes are undefined, not empty strings", async () => {
    getJupiterPredictionPositions.mockResolvedValue({ data: [], pagination: { start: 0, end: 20, total: 0, hasNext: false } });
    await SOLANA_JUPITER_HANDLERS["solana.predict.positions"]!(
      { address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
      ctx(),
    );
    const call = getJupiterPredictionPositions.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.marketPubkey).toBeUndefined();
    expect(call.marketId).toBeUndefined();
    expect(call.isYes).toBeUndefined();
  });

  it("positions: projects each position, paginates, requires no resolution with explicit address", async () => {
    getJupiterPredictionPositions.mockResolvedValue({
      data: [structuredClone(FULL_POSITION)],
      pagination: { start: 0, end: 10, total: 1, hasNext: false },
    });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.positions"]!(
      { address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", limit: 5, offset: 2 },
      ctx(),
    );
    expect(result.success).toBe(true);
    expect(getJupiterPredictionPositions).toHaveBeenCalledWith(
      expect.objectContaining({ ownerPubkey: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", start: 2, end: 7 }),
    );
    const data = result.data as { data: Record<string, unknown>[] };
    const pos = data.data[0]!;
    expect(pos).toEqual({
      pubkey: "pos-1",
      owner: "owner-1",
      contracts: "10",
      // F2: preserved when the wire response includes them (see fixture).
      contractsMicro: "10000000",
      contractsDecimal: "10",
      claimed: false,
      eventId: "evt-1",
      // Money (W1-B): each *Usd field is a micro-USD string on the wire —
      // converted to an exact dollar string + raw *Micro sibling.
      sizeUsd: "6.000000", sizeUsdMicro: "6000000",
      valueUsd: "7.000000", valueUsdMicro: "7000000",
      avgPriceUsd: "0.600000", avgPriceUsdMicro: "600000",
      markPriceUsd: "0.700000", markPriceUsdMicro: "700000",
      pnlUsd: "1.000000", pnlUsdMicro: "1000000",
      payoutUsd: "10.000000", payoutUsdMicro: "10000000",
      eventMetadata: { eventId: "evt-1", title: "Event title", subtitle: "Event sub" },
      marketMetadata: { marketId: "mkt-1", eventId: "evt-1", title: "Market title", subtitle: "Market sub", status: "open", result: null },
    });
    // Dropped position noise.
    expect(pos).not.toHaveProperty("ownerPubkey");
    expect(pos).not.toHaveProperty("totalCostUsd");
    expect(pos).not.toHaveProperty("realizedPnlUsd");
    expect((pos.eventMetadata as Record<string, unknown>)).not.toHaveProperty("imageUrl");
  });

  // F2 boundary test: an older/partial wire response without
  // contractsMicro/contractsDecimal must not fabricate them.
  it("positions: omits contractsMicro/contractsDecimal (not null-fabricated) when the wire response lacks them", async () => {
    const { contractsMicro, contractsDecimal, ...positionWithoutContractSiblings } = structuredClone(FULL_POSITION);
    getJupiterPredictionPositions.mockResolvedValue({
      data: [positionWithoutContractSiblings],
      pagination: { start: 0, end: 20, total: 1, hasNext: false },
    });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.positions"]!(
      { address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
      ctx(),
    );
    expect(result.success).toBe(true);
    const data = result.data as { data: Record<string, unknown>[] };
    const pos = data.data[0]!;
    expect(pos.contracts).toBe("10");
    expect(pos).not.toHaveProperty("contractsMicro");
    expect(pos).not.toHaveProperty("contractsDecimal");
  });

  it("position: projects the single position", async () => {
    getJupiterPredictionPosition.mockResolvedValue(structuredClone(FULL_POSITION));
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.position"]!({ positionPubkey: "pos-1" }, ctx());
    expect(result.success).toBe(true);
    const pos = result.data as Record<string, unknown>;
    expect(pos.pubkey).toBe("pos-1");
    expect(pos).not.toHaveProperty("marketResultPubkey");
    expect(pos).not.toHaveProperty("ownerPubkey");
  });

  // Regional-block mapping (FIX-D — extends P1's wrapPredictionRead to the
  // last 2 of the domain's 18 reads: .market and .position, both flagged as a
  // gap in P1's delta log).
  it("position: maps an HTTP 403 (geo-block) into a clear regional message", async () => {
    getJupiterPredictionPosition.mockRejectedValue(providerHttpError(403, "HTTP 403: Forbidden"));
    await expect(
      SOLANA_JUPITER_HANDLERS["solana.predict.position"]!({ positionPubkey: "pos-1" }, ctx()),
    ).rejects.toThrow(/not available from your current region/);
  });
});
