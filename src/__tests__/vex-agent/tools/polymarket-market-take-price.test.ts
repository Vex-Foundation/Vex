/**
 * Polymarket omit-price ("market") take-side resolution.
 *
 * Live CLOB: getPrice("BUY") = best bid, getPrice("SELL") = best ask — the
 * resting side, not the taking side. Market buy must take best ask; market
 * sell must take best bid. These pure helpers + dryRun handlers pin that.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetOrderBook = vi.fn();
const mockPostOrder = vi.fn();
const mockGetFeeRate = vi.fn(() => Promise.resolve({ base_fee: 0 }));
const mockGetPrice = vi.fn();
const mockResolveMarket = vi.fn();

vi.mock("@tools/polymarket/clob/client.js", () => ({
  getPolyClobClient: () => ({
    getOrderBook: (...a: unknown[]) => mockGetOrderBook(...a),
    getPrice: (...a: unknown[]) => mockGetPrice(...a),
    postOrder: (...a: unknown[]) => mockPostOrder(...a),
    getFeeRate: (...a: unknown[]) => mockGetFeeRate(...a),
  }),
}));
vi.mock("@tools/polymarket/gamma/client.js", () => ({
  getPolyGammaClient: () => ({ resolveMarket: (...a: unknown[]) => mockResolveMarket(...a) }),
}));
vi.mock("@tools/polymarket/auth.js", () => ({
  requirePolyClobCredentials: () => ({
    apiKey: "test-api-key",
    apiSecret: "secret",
    passphrase: "pass",
  }),
}));
vi.mock("@tools/polymarket/clob/signing.js", () => ({
  buildClobOrder: () => ({ maker: "0xMAKER", side: "BUY" }),
  signClobOrder: () => Promise.resolve("0xSIGNATURE"),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/internal/wallet/resolve.js")>();
  return {
    ...actual,
    resolveSelectedAddress: () => "0x1111111111111111111111111111111111111111",
    resolveSigningWallet: () => ({
      family: "eip155" as const,
      address: "0x1111111111111111111111111111111111111111",
      privateKey: "0xabc",
    }),
  };
});

const {
  bestAskFromBook,
  bestBidFromBook,
  marketTakePriceFromBook,
} = await import("../../../vex-agent/tools/protocols/polymarket/handlers-clob/orders.js");
const { POLYMARKET_HANDLERS } = await import(
  "../../../vex-agent/tools/protocols/polymarket/handlers.js"
);

const SIGNING_CTX = {
  sessionPermission: "full" as const,
  approved: true,
  walletResolution: { source: "session" as const, evm: null, solana: null },
  walletPolicy: { kind: "none" as const },
};

/** Live-shaped book: worst first, best last (Polymarket REST). */
const LIVE_SHAPED_BOOK = {
  bids: [
    { price: "0.01", size: "10" },
    { price: "0.40", size: "5" },
    { price: "0.52", size: "100" }, // best bid
  ],
  asks: [
    { price: "0.99", size: "10" },
    { price: "0.70", size: "5" },
    { price: "0.54", size: "100" }, // best ask
  ],
};

/** Doc-shaped book: best first (opposite of live). min/max must still win. */
const DOC_SHAPED_BOOK = {
  bids: [
    { price: "0.52", size: "100" },
    { price: "0.40", size: "5" },
    { price: "0.01", size: "10" },
  ],
  asks: [
    { price: "0.54", size: "100" },
    { price: "0.70", size: "5" },
    { price: "0.99", size: "10" },
  ],
};

beforeEach(() => {
  mockGetOrderBook.mockReset().mockResolvedValue({
    market: "0x",
    asset_id: "t",
    timestamp: "1",
    hash: "h",
    ...LIVE_SHAPED_BOOK,
    min_order_size: "1",
    tick_size: "0.01",
    neg_risk: false,
    last_trade_price: "0.53",
  });
  // If getPrice were still used for market path, these inverted values would
  // produce a resting bid/ask — tests must fail if handlers call them.
  mockGetPrice.mockReset().mockImplementation((_token: string, side: string) =>
    Promise.resolve({ price: side === "BUY" || side === "buy" ? 0.52 : 0.54 }),
  );
  mockPostOrder.mockReset();
  mockGetFeeRate.mockReset().mockResolvedValue({ base_fee: 0 });
  mockResolveMarket.mockReset().mockResolvedValue({
    clobTokenIds: '["yesTok","noTok"]',
    negRisk: false,
    question: "Test market?",
  });
});

describe("bestAskFromBook / bestBidFromBook", () => {
  it("picks min ask and max bid on live-shaped (worst-first) books", () => {
    expect(bestAskFromBook(LIVE_SHAPED_BOOK.asks)).toBe(0.54);
    expect(bestBidFromBook(LIVE_SHAPED_BOOK.bids)).toBe(0.52);
  });

  it("picks min ask and max bid on doc-shaped (best-first) books", () => {
    expect(bestAskFromBook(DOC_SHAPED_BOOK.asks)).toBe(0.54);
    expect(bestBidFromBook(DOC_SHAPED_BOOK.bids)).toBe(0.52);
  });

  it("returns null for empty or unusable levels", () => {
    expect(bestAskFromBook([])).toBeNull();
    expect(bestBidFromBook(undefined)).toBeNull();
    expect(bestAskFromBook([{ price: "0", size: "1" }, { price: "n/a", size: "1" }])).toBeNull();
  });

  it("ignores garbage levels when a valid best exists", () => {
    expect(
      bestAskFromBook([
        { price: "bad", size: "1" },
        { price: "0.54", size: "1" },
        { price: "0", size: "1" },
      ]),
    ).toBe(0.54);
  });
});

describe("marketTakePriceFromBook", () => {
  it("BUY takes best ask; SELL takes best bid", () => {
    expect(marketTakePriceFromBook(LIVE_SHAPED_BOOK, "BUY")).toBe(0.54);
    expect(marketTakePriceFromBook(LIVE_SHAPED_BOOK, "SELL")).toBe(0.52);
    expect(marketTakePriceFromBook(DOC_SHAPED_BOOK, "BUY")).toBe(0.54);
    expect(marketTakePriceFromBook(DOC_SHAPED_BOOK, "SELL")).toBe(0.52);
  });
});

describe("polymarket.clob.buy — omit price takes best ask", () => {
  it("dryRun market buy prices at best ask (0.54), not getPrice BUY bid (0.52)", async () => {
    const r = await POLYMARKET_HANDLERS["polymarket.clob.buy"]!(
      { conditionId: "0xCOND", outcome: "YES", amount: 10, dryRun: true },
      SIGNING_CTX,
    );
    expect(r.success).toBe(true);
    const out = JSON.parse(r.output);
    expect(out.price).toBe(0.54);
    expect(out.shares).toBe((10 / 0.54).toFixed(2));
    expect(mockGetOrderBook).toHaveBeenCalledWith("yesTok");
    // Must not consult getPrice for the market take path.
    expect(mockGetPrice).not.toHaveBeenCalled();
  });

  it("explicit price is unchanged and skips the book", async () => {
    const r = await POLYMARKET_HANDLERS["polymarket.clob.buy"]!(
      { conditionId: "0xCOND", outcome: "YES", amount: 10, price: 0.65, dryRun: true },
      SIGNING_CTX,
    );
    expect(r.success).toBe(true);
    const out = JSON.parse(r.output);
    expect(out.price).toBe(0.65);
    expect(mockGetOrderBook).not.toHaveBeenCalled();
  });

  it("fails closed when the book has no asks", async () => {
    mockGetOrderBook.mockResolvedValue({
      market: "0x",
      asset_id: "t",
      timestamp: "1",
      hash: "h",
      bids: LIVE_SHAPED_BOOK.bids,
      asks: [],
      min_order_size: "1",
      tick_size: "0.01",
      neg_risk: false,
      last_trade_price: "0.53",
    });
    const r = await POLYMARKET_HANDLERS["polymarket.clob.buy"]!(
      { conditionId: "0xCOND", outcome: "YES", amount: 10, dryRun: true },
      SIGNING_CTX,
    );
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/Cannot determine price|illiquid|closed/i);
  });
});

describe("polymarket.clob.sell — omit price takes best bid", () => {
  it("dryRun market sell prices at best bid (0.52), not getPrice SELL ask (0.54)", async () => {
    const r = await POLYMARKET_HANDLERS["polymarket.clob.sell"]!(
      { conditionId: "0xCOND", outcome: "YES", amount: 10, dryRun: true },
      SIGNING_CTX,
    );
    expect(r.success).toBe(true);
    const out = JSON.parse(r.output);
    expect(out.price).toBe(0.52);
    expect(out.usdcValue).toBe((10 * 0.52).toFixed(2));
    expect(mockGetOrderBook).toHaveBeenCalledWith("yesTok");
    expect(mockGetPrice).not.toHaveBeenCalled();
  });

  it("fails closed when the book has no bids", async () => {
    mockGetOrderBook.mockResolvedValue({
      market: "0x",
      asset_id: "t",
      timestamp: "1",
      hash: "h",
      bids: [],
      asks: LIVE_SHAPED_BOOK.asks,
      min_order_size: "1",
      tick_size: "0.01",
      neg_risk: false,
      last_trade_price: "0.53",
    });
    const r = await POLYMARKET_HANDLERS["polymarket.clob.sell"]!(
      { conditionId: "0xCOND", outcome: "YES", amount: 10, dryRun: true },
      SIGNING_CTX,
    );
    expect(r.success).toBe(false);
  });
});
