import { describe, it, expect, vi, beforeEach } from "vitest";

import { ctx } from "./_solana-jupiter-handlers-context.js";
import { providerHttpError } from "./_provider-http-error.js";

/**
 * W1-B — money conversion for the two `handlers/predict.ts` read paths that
 * are NOT run through `toPredictView` (`solana.predict.market` returns the
 * raw SDK market verbatim; `solana.predict.history` returns the raw SDK
 * history events verbatim). Both still carry agent-visible money fields, so
 * both get the SAME micro-USD → dollar-string + `*Micro` sibling conversion,
 * applied narrowly (money fields only — every other field passes through
 * untouched, since this is a money-correctness fix, not a field-set
 * redesign). `toPredictView`'s own money conversion (events/positions) is
 * covered by `solana-jupiter-handlers-predict.test.ts`.
 */
const {
  getJupiterPredictionMarket,
  getJupiterPredictionHistory,
} = vi.hoisted(() => ({
  getJupiterPredictionMarket: vi.fn(),
  getJupiterPredictionHistory: vi.fn(),
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js", () => ({
  getJupiterPredictionMarket,
  getJupiterPredictionHistory,
  // Re-exported by the handler module but unused by these tests; inert stubs
  // so the mock fully replaces the real (network-bound) module.
  getJupiterPredictionEvents: vi.fn(),
  searchJupiterPredictionEvents: vi.fn(),
  getJupiterPredictionEvent: vi.fn(),
  getJupiterPredictionPositions: vi.fn(),
  getJupiterPredictionPosition: vi.fn(),
  executeJupiterPredictionCreateOrder: vi.fn(),
  executeJupiterPredictionClosePosition: vi.fn(),
  executeJupiterPredictionCloseAllPositions: vi.fn(),
  executeJupiterPredictionClaimPosition: vi.fn(),
}));

import { SOLANA_JUPITER_HANDLERS } from "../../../vex-agent/tools/protocols/solana-jupiter/handlers.js";

describe("solana-jupiter handlers — predict money conversion (W1-B)", () => {
  beforeEach(() => {
    getJupiterPredictionMarket.mockReset();
    getJupiterPredictionHistory.mockReset();
  });

  it("solana.predict.market converts pricing money fields, leaves every other field untouched", async () => {
    getJupiterPredictionMarket.mockResolvedValue({
      marketId: "mkt-1",
      eventId: "evt-1",
      provider: "polymarket",
      title: "Will it happen?",
      status: "open",
      result: null,
      openTime: 1,
      closeTime: 2,
      resolveAt: null,
      marketResultPubkey: "SomePubkey",
      imageUrl: "https://img/x.png",
      outcomes: ["Yes", "No"],
      // buyYesPriceUsd/buyNoPriceUsd/sellYesPriceUsd/sellNoPriceUsd are
      // micro-USD numbers; volume is already whole-dollar (fixture-confirmed
      // unit hazard — see JupiterPredictionUnits.md).
      pricing: { buyYesPriceUsd: 600000, sellYesPriceUsd: 599000, buyNoPriceUsd: 400000, sellNoPriceUsd: 0, volume: 26003599 },
    });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.market"]!({ marketId: "mkt-1" }, ctx());
    expect(result.success).toBe(true);
    const market = result.data as Record<string, unknown>;
    // Untouched fields survive verbatim — this handler is NOT run through the
    // curating toPredictView projector, only money-converted in place.
    expect(market.marketId).toBe("mkt-1");
    expect(market.provider).toBe("polymarket");
    expect(market.title).toBe("Will it happen?");
    expect(market.outcomes).toEqual(["Yes", "No"]);
    expect(market.marketResultPubkey).toBe("SomePubkey");
    // Money (W1-B): converted exact dollar strings + raw *Micro siblings.
    expect(market.pricing).toEqual({
      buyYesPriceUsd: "0.600000", buyYesPriceUsdMicro: "600000",
      buyNoPriceUsd: "0.400000", buyNoPriceUsdMicro: "400000",
      sellYesPriceUsd: "0.599000", sellYesPriceUsdMicro: "599000",
      sellNoPriceUsd: "0.000000", sellNoPriceUsdMicro: "0",
      volumeUsd: "26003599",
    });
  });

  it("solana.predict.history converts *Usd money fields, leaves unconfirmed-unit fields and quantities untouched", async () => {
    const HISTORY_EVENT = {
      id: 1, eventType: "order_filled", signature: "SIG", slot: "100", timestamp: 1,
      orderPubkey: "OP", positionPubkey: "PP", marketId: "MKT", ownerPubkey: "OWNER",
      keeperPubkey: "KEEPER", externalOrderId: "EXT", orderId: "ORD", isBuy: true, isYes: true,
      contracts: "10", filledContracts: "10", contractsSettled: "0",
      // Realistic micro-USD wire values — see file header.
      maxFillPriceUsd: "600000", avgFillPriceUsd: "550000",
      maxBuyPriceUsd: "700000", minSellPriceUsd: "400000",
      depositAmountUsd: "10000000", totalCostUsd: "10000000",
      feeUsd: "100000", grossProceedsUsd: "10100000", netProceedsUsd: "10000000",
      // realizedPnl/realizedPnlBeforeFees: confirmed micro-USD (F2, docs) despite
      // no `Usd` suffix — converted. transferAmountToken: confirmed native
      // TOKEN units (F2, docs), a different unit family — stays raw, relabeled.
      transferAmountToken: "10000000", realizedPnl: "500000", realizedPnlBeforeFees: "-600000",
      payoutAmountUsd: "18000000",
      eventId: "EVT",
      marketMetadata: { marketId: "MKT" },
      eventMetadata: { eventId: "EVT" },
    };
    getJupiterPredictionHistory.mockResolvedValue({
      data: [HISTORY_EVENT],
      pagination: { start: 0, end: 10, total: 1, hasNext: false },
    });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.history"]!(
      { address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
      ctx(),
    );
    expect(result.success).toBe(true);
    const data = result.data as { data: Record<string, unknown>[] };
    const event = data.data[0]!;
    // Money (W1-B): converted dollar string + raw *Micro sibling.
    expect(event.maxFillPriceUsd).toBe("0.600000");
    expect(event.maxFillPriceUsdMicro).toBe("600000");
    expect(event.avgFillPriceUsd).toBe("0.550000");
    expect(event.maxBuyPriceUsd).toBe("0.700000");
    expect(event.minSellPriceUsd).toBe("0.400000");
    expect(event.depositAmountUsd).toBe("10.000000");
    expect(event.totalCostUsd).toBe("10.000000");
    expect(event.feeUsd).toBe("0.100000");
    expect(event.grossProceedsUsd).toBe("10.100000");
    expect(event.netProceedsUsd).toBe("10.000000");
    expect(event.payoutAmountUsd).toBe("18.000000");
    expect(event.payoutAmountUsdMicro).toBe("18000000");
    // Money (F2): realizedPnl/realizedPnlBeforeFees are confirmed micro-USD
    // (developers.jup.ag/docs/prediction/position-data) despite carrying no
    // `Usd` suffix — converted + raw *Micro sibling, sign preserved.
    expect(event.realizedPnl).toBe("0.500000");
    expect(event.realizedPnlMicro).toBe("500000");
    expect(event.realizedPnlBeforeFees).toBe("-0.600000");
    expect(event.realizedPnlBeforeFeesMicro).toBe("-600000");
    // Money (F2): transferAmountToken is confirmed NATIVE TOKEN units (docs),
    // a different unit family from micro-USD — never converted, exposed
    // under an explicitly unit-labeled field name instead of its wire name.
    expect(event.transferAmountTokenRaw).toBe("10000000");
    expect(event).not.toHaveProperty("transferAmountToken");
    // Quantities + ids/metadata untouched.
    expect(event.contracts).toBe("10");
    expect(event.eventId).toBe("EVT");
    expect(event.marketMetadata).toEqual({ marketId: "MKT" });
  });

  // Regional-block mapping (FIX-D — extends P1's wrapPredictionRead to the
  // last 2 of the domain's 18 reads: .market and .position, both flagged as a
  // gap in P1's delta log).
  it("solana.predict.market: appends the region hint to an HTTP 403 without replacing the provider words", async () => {
    getJupiterPredictionMarket.mockRejectedValue(providerHttpError(403, "HTTP 403: Forbidden"));
    await expect(
      SOLANA_JUPITER_HANDLERS["solana.predict.market"]!({ marketId: "mkt-1" }, ctx()),
    ).rejects.toThrow(/United States and South Korea/);
  });
});
