import { describe, it, expect, vi, beforeEach } from "vitest";

import { ctx } from "./_solana-jupiter-handlers-context.js";
import { providerHttpError } from "./_provider-http-error.js";

/**
 * W1-D — pre-trade visibility & order tools: orderbook, tradingStatus,
 * orders (list/single/status), and the global trade feed. New tools, so
 * this is a NEW test file (not an addition to solana-jupiter-handlers-
 * predict.test.ts) covering: required-param validation, the orderbook
 * documented-`null` case, money conversion on Order/Trade rows (W1-B
 * convention), the shared reject-not-clamp `limit`/`offset` window
 * (`resolvePredictionWindow`, exported from `predict-params.ts` — F2), and
 * the client-side windowing `solana.predict.trades` must impose itself (the
 * upstream API has zero params for this endpoint); `.trades` additionally
 * REQUIRES `limit` (F2 — no default-N truncation on this unscoped feed).
 */
const {
  getJupiterPredictionOrderbook,
  getJupiterPredictionTradingStatus,
  getJupiterPredictionOrders,
  getJupiterPredictionOrder,
  getJupiterPredictionOrderStatus,
  getJupiterPredictionTrades,
} = vi.hoisted(() => ({
  getJupiterPredictionOrderbook: vi.fn(),
  getJupiterPredictionTradingStatus: vi.fn(),
  getJupiterPredictionOrders: vi.fn(),
  getJupiterPredictionOrder: vi.fn(),
  getJupiterPredictionOrderStatus: vi.fn(),
  getJupiterPredictionTrades: vi.fn(),
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js", () => ({
  getJupiterPredictionOrderbook,
  getJupiterPredictionTradingStatus,
  getJupiterPredictionOrders,
  getJupiterPredictionOrder,
  getJupiterPredictionOrderStatus,
  getJupiterPredictionTrades,
  // Re-exported by the aggregator's other handler modules but unused by
  // these tests; inert stubs so the mock fully replaces the real
  // (network-bound) module.
  getJupiterPredictionEvents: vi.fn(),
  searchJupiterPredictionEvents: vi.fn(),
  getJupiterPredictionEvent: vi.fn(),
  getJupiterPredictionMarket: vi.fn(),
  getJupiterPredictionPositions: vi.fn(),
  getJupiterPredictionPosition: vi.fn(),
  getJupiterPredictionHistory: vi.fn(),
  executeJupiterPredictionCreateOrder: vi.fn(),
  executeJupiterPredictionClosePosition: vi.fn(),
  executeJupiterPredictionCloseAllPositions: vi.fn(),
  executeJupiterPredictionClaimPosition: vi.fn(),
}));

import { SOLANA_JUPITER_HANDLERS } from "../../../vex-agent/tools/protocols/solana-jupiter/handlers.js";

const ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

// Realistic micro-USD wire values (1,000,000 native units = $1.00) — see
// developers.jup.ag/docs/prediction's "Numeric-format hazard" note.
const FULL_ORDER = {
  pubkey: "order-1",
  owner: "owner-1",
  ownerPubkey: "owner-1",
  market: "mkt-acct",
  marketId: "mkt-1",
  marketIdHash: "hash-should-be-dropped",
  eventId: "evt-1",
  position: "pos-1",
  status: "filled",
  isYes: true,
  isBuy: true,
  createdAt: 1,
  updatedAt: 2,
  contracts: "10",
  maxFillPriceUsd: "700000",
  maxBuyPriceUsd: "650000",
  minSellPriceUsd: null,
  filledAt: 3,
  filledContracts: "10",
  avgFillPriceUsd: "600000",
  settled: false,
  orderId: "ord-1",
  sizeUsd: "6000000",
  eventMetadata: {
    eventId: "evt-1", title: "Event title", subtitle: "Event sub",
    slug: "slug-drop", series: "series-drop", closeTime: "2026-01-01", imageUrl: "https://img/drop.png",
  },
  marketMetadata: {
    marketId: "mkt-1", eventId: "evt-1", title: "Market title", subtitle: "Market sub", status: "open", result: null,
  },
  externalOrderId: "ext-1",
  bump: 255,
};

const EXPECTED_PROJECTED_ORDER = {
  pubkey: "order-1",
  owner: "owner-1",
  ownerPubkey: "owner-1",
  market: "mkt-acct",
  marketId: "mkt-1",
  eventId: "evt-1",
  position: "pos-1",
  status: "filled",
  isYes: true,
  isBuy: true,
  createdAt: 1,
  updatedAt: 2,
  contracts: "10",
  filledAt: 3,
  filledContracts: "10",
  settled: false,
  orderId: "ord-1",
  externalOrderId: "ext-1",
  eventMetadata: { eventId: "evt-1", title: "Event title", subtitle: "Event sub" },
  marketMetadata: { marketId: "mkt-1", eventId: "evt-1", title: "Market title", subtitle: "Market sub", status: "open", result: null },
  // Money (W1-B convention): exact dollar string + raw *Micro sibling.
  maxFillPriceUsd: "0.700000", maxFillPriceUsdMicro: "700000",
  maxBuyPriceUsd: "0.650000", maxBuyPriceUsdMicro: "650000",
  minSellPriceUsd: null, minSellPriceUsdMicro: null,
  avgFillPriceUsd: "0.600000", avgFillPriceUsdMicro: "600000",
  sizeUsd: "6.000000", sizeUsdMicro: "6000000",
};

describe("solana-jupiter handlers — predict pre-trade visibility & orders (W1-D)", () => {
  beforeEach(() => {
    getJupiterPredictionOrderbook.mockReset();
    getJupiterPredictionTradingStatus.mockReset();
    getJupiterPredictionOrders.mockReset();
    getJupiterPredictionOrder.mockReset();
    getJupiterPredictionOrderStatus.mockReset();
    getJupiterPredictionTrades.mockReset();
  });

  // ── orderbook ────────────────────────────────────────────────────

  it("orderbook fails without marketId", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.orderbook"]({}, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain("marketId");
    expect(getJupiterPredictionOrderbook).not.toHaveBeenCalled();
  });

  it("orderbook passes yes/no/yes_dollars/no_dollars through verbatim (no unit conversion)", async () => {
    getJupiterPredictionOrderbook.mockResolvedValue({
      yes: [[10, 5]], no: [[20, 3]],
      yes_dollars: [["0.0010", 5]], no_dollars: [["0.0020", 3]],
    });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.orderbook"]({ marketId: "mkt-1" }, ctx());
    expect(result.success).toBe(true);
    expect(getJupiterPredictionOrderbook).toHaveBeenCalledWith("mkt-1");
    expect(result.data).toEqual({
      yes: [[10, 5]], no: [[20, 3]],
      yes_dollars: [["0.0010", 5]], no_dollars: [["0.0020", 3]],
    });
  });

  it("orderbook returns a clear failure (not a silent empty object) when upstream data-fetch fails (documented null body)", async () => {
    getJupiterPredictionOrderbook.mockResolvedValue(null);
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.orderbook"]({ marketId: "mkt-1" }, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain("mkt-1");
    expect(result.output.toLowerCase()).toContain("unavailable");
  });

  // ── tradingStatus ────────────────────────────────────────────────

  it("tradingStatus passes the flag through verbatim", async () => {
    getJupiterPredictionTradingStatus.mockResolvedValue({ trading_active: true });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.tradingStatus"]({}, ctx());
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ trading_active: true });
  });

  // ── orders (list) ────────────────────────────────────────────────

  it("orders: resolves the owner wallet, applies the default 20-window, and projects each row", async () => {
    getJupiterPredictionOrders.mockResolvedValue({
      data: [structuredClone(FULL_ORDER)],
      pagination: { start: 0, end: 20, total: 1, hasNext: false },
    });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.orders"]({ walletAddress: ADDRESS }, ctx());
    expect(result.success).toBe(true);
    expect(getJupiterPredictionOrders).toHaveBeenCalledWith(
      expect.objectContaining({ ownerPubkey: ADDRESS, start: 0, end: 20 }),
    );
    const data = result.data as { data: Record<string, unknown>[]; pagination: unknown };
    expect(data.pagination).toEqual({ start: 0, end: 20, total: 1, hasNext: false });
    expect(data.data[0]).toEqual(EXPECTED_PROJECTED_ORDER);
    expect(data.data[0]).not.toHaveProperty("bump");
    expect(data.data[0]).not.toHaveProperty("marketIdHash");
  });

  it("orders: rejects a limit outside 1-100 instead of clamping, without calling the SDK", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.orders"](
      { walletAddress: ADDRESS, limit: 500 },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("limit");
    expect(getJupiterPredictionOrders).not.toHaveBeenCalled();
  });

  it("orders: rejects a negative offset instead of clamping, without calling the SDK", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.orders"](
      { walletAddress: ADDRESS, offset: -1 },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("offset");
    expect(getJupiterPredictionOrders).not.toHaveBeenCalled();
  });

  // ── Regional-block mapping (P1 — extends W1-C's wrapPredictionRead to
  // every W1-D read; `.orders` stands in for the group, same convention
  // W1-C used to prove the shared wrapper on one representative handler) ──

  it("orders: appends the region hint to an HTTP 403 without replacing the provider words", async () => {
    getJupiterPredictionOrders.mockRejectedValue(providerHttpError(403, "HTTP 403: Forbidden"));
    await expect(
      SOLANA_JUPITER_HANDLERS["solana.predict.orders"]({ walletAddress: ADDRESS }, ctx()),
    ).rejects.toThrow(/United States and South Korea/);
  });

  it("orders: a non-403 error is NOT rewritten", async () => {
    getJupiterPredictionOrders.mockRejectedValue(providerHttpError(500, "HTTP 500: Internal Server Error"));
    await expect(
      SOLANA_JUPITER_HANDLERS["solana.predict.orders"]({ walletAddress: ADDRESS }, ctx()),
    ).rejects.toThrow("HTTP 500");
  });

  // ── order (single) ───────────────────────────────────────────────

  it("order fails without orderPubkey", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.order"]({}, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain("orderPubkey");
    expect(getJupiterPredictionOrder).not.toHaveBeenCalled();
  });

  it("order: projects the single order the same way the list does", async () => {
    getJupiterPredictionOrder.mockResolvedValue(structuredClone(FULL_ORDER));
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.order"]({ orderPubkey: "order-1" }, ctx());
    expect(result.success).toBe(true);
    expect(getJupiterPredictionOrder).toHaveBeenCalledWith("order-1");
    expect(result.data).toEqual(EXPECTED_PROJECTED_ORDER);
  });

  // ── orderStatus ──────────────────────────────────────────────────

  it("orderStatus fails without orderPubkey", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.orderStatus"]({}, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain("orderPubkey");
    expect(getJupiterPredictionOrderStatus).not.toHaveBeenCalled();
  });

  it("orderStatus: passes the durable status + history through verbatim (no money fields to convert)", async () => {
    const STATUS = {
      orderPubkey: "order-1", status: "filled", latestEventType: "order_filled",
      latestSignature: "sig-1", externalOrderId: "ext-1", orderId: "ord-1",
      history: [{ eventType: "order_filled", status: "filled", rawStatus: "FILLED", timestamp: 1, signature: "sig-1", externalOrderId: "ext-1", orderId: "ord-1" }],
    };
    getJupiterPredictionOrderStatus.mockResolvedValue(STATUS);
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.orderStatus"]({ orderPubkey: "order-1" }, ctx());
    expect(result.success).toBe(true);
    expect(getJupiterPredictionOrderStatus).toHaveBeenCalledWith("order-1");
    expect(result.data).toEqual(STATUS);
  });

  // ── trades (global feed, client-side window) ────────────────────

  const TRADES = [
    { id: 1, ownerPubkey: "o1", marketId: "mkt-1", message: "m1", timestamp: 1, action: "buy", side: "yes", eventTitle: "E1", marketTitle: "M1", amountUsd: "5000000", priceUsd: "600000", eventImageUrl: "https://img/1.png", eventId: "evt-1" },
    { id: 2, ownerPubkey: "o2", marketId: "mkt-2", message: "m2", timestamp: 2, action: "sell", side: "no", eventTitle: "E2", marketTitle: "M2", amountUsd: "3000000", priceUsd: "400000", eventImageUrl: "https://img/2.png", eventId: "evt-2" },
    { id: 3, ownerPubkey: "o3", marketId: "mkt-3", message: "m3", timestamp: 3, action: "buy", side: "yes", eventTitle: "E3", marketTitle: "M3", amountUsd: "1000000", priceUsd: "900000", eventImageUrl: "https://img/3.png", eventId: "evt-3" },
  ];

  it("trades: converts amountUsd/priceUsd and windows the always-full upstream feed client-side", async () => {
    getJupiterPredictionTrades.mockResolvedValue({ data: TRADES.map(t => ({ ...t })) });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.trades"]({ limit: 2 }, ctx());
    expect(result.success).toBe(true);
    // The upstream endpoint has zero params — always fetches everything.
    expect(getJupiterPredictionTrades).toHaveBeenCalledWith();
    const data = result.data as { data: Record<string, unknown>[]; pagination: unknown };
    expect(data.data).toHaveLength(2);
    expect(data.data[0]).toEqual({ ...TRADES[0], amountUsd: "5.000000", amountUsdMicro: "5000000", priceUsd: "0.600000", priceUsdMicro: "600000" });
    expect(data.data[1]).toEqual({ ...TRADES[1], amountUsd: "3.000000", amountUsdMicro: "3000000", priceUsd: "0.400000", priceUsdMicro: "400000" });
    // Honestly computed from the full fetched array, not fabricated.
    expect(data.pagination).toEqual({ start: 0, end: 2, total: 3, hasNext: true });
  });

  it("trades: reports hasNext:false when the requested window covers the full feed", async () => {
    getJupiterPredictionTrades.mockResolvedValue({ data: TRADES.map(t => ({ ...t })) });
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.trades"]({ limit: 20 }, ctx());
    expect(result.success).toBe(true);
    const data = result.data as { data: Record<string, unknown>[]; pagination: unknown };
    expect(data.data).toHaveLength(3);
    expect(data.pagination).toEqual({ start: 0, end: 20, total: 3, hasNext: false });
  });

  // F2: `/trades` has no upstream owner/market scope — a silent default-20
  // window would be exactly the "default-N truncation" the owner rule
  // forbids for an unbounded feed. `limit` is REQUIRED here (unlike
  // `.orders`/`.events`/`.positions`/`.history`, which stay naturally scoped
  // and keep their default-20 window).
  it("trades: rejects a missing limit instead of silently defaulting to 20, without calling the SDK", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.trades"]({}, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain("limit");
    expect(getJupiterPredictionTrades).not.toHaveBeenCalled();
  });

  it("trades: rejects an out-of-range limit before ever calling the SDK (no silent clamp, no wasted fetch)", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.predict.trades"]({ limit: 0 }, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toContain("limit");
    expect(getJupiterPredictionTrades).not.toHaveBeenCalled();
  });
});
