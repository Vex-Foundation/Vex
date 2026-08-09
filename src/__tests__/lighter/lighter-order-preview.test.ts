import { describe, expect, it } from "vitest";

import { ErrorCodes } from "../../errors.js";
import {
  buildLighterOrderPreview,
  computeLighterOrderPreviewHash,
  type LighterOrderPreviewInput,
} from "@tools/lighter/order-preview.js";
import type {
  LighterAccountResponse,
  LighterMarketDetail,
  LighterOrderBookOrdersResponse,
} from "@tools/lighter/types.js";

const NOW = 1786233600000;

const MARKET: LighterMarketDetail = {
  symbol: "ETH",
  market_id: 0,
  market_type: "perp",
  base_asset_id: 1,
  quote_asset_id: 0,
  status: "active",
  taker_fee: "0.0280",
  maker_fee: "0.0040",
  liquidation_fee: "0",
  min_base_amount: "0.001",
  min_quote_amount: "100",
  supported_size_decimals: 4,
  supported_price_decimals: 2,
  supported_quote_decimals: 6,
  order_quote_limit: "1000000000000",
  is_maker_fee_enabled: true,
  is_taker_fee_enabled: true,
  last_trade_price: 3000,
  mark_price: "3000.10",
  index_price: "3000.00",
};

const ORDER_BOOK: LighterOrderBookOrdersResponse = {
  code: 200,
  total_asks: 1,
  asks: [
    {
      order_index: 1,
      order_id: "1",
      owner_account_index: 7,
      initial_base_amount: "1.0",
      remaining_base_amount: "1.0",
      price: "3000.50",
      order_expiry: NOW + 600000,
      transaction_time: NOW,
    },
  ],
  total_bids: 1,
  bids: [
    {
      order_index: 2,
      order_id: "2",
      owner_account_index: 8,
      initial_base_amount: "1.0",
      remaining_base_amount: "1.0",
      price: "2999.50",
      order_expiry: NOW + 600000,
      transaction_time: NOW,
    },
  ],
};

const ACCOUNT: LighterAccountResponse = {
  code: 200,
  total: 1,
  accounts: [
    {
      index: 42,
      status: 1,
      collateral: "1000",
      available_balance: "900",
      positions: [
        {
          market_id: 0,
          symbol: "ETH",
          sign: 1,
          position: "1.5",
        },
      ],
    },
  ],
};

const INPUT: LighterOrderPreviewInput = {
  sessionId: "session-1",
  environment: "core",
  accountIndex: 42,
  apiKeyIndex: null,
  marketId: 0,
  side: "buy",
  baseAmount: "1.25",
  price: "2999.99",
  orderType: "limit",
  timeInForce: "good-till-time",
  reduceOnly: false,
  orderExpiry: NOW + 10 * 60 * 1000,
  clientOrderIndexPolicy: "vex_assigned_uint48",
  nowMs: NOW,
};

function preview(overrides: Partial<LighterOrderPreviewInput> = {}) {
  return buildLighterOrderPreview(
    { ...INPUT, ...overrides },
    { market: MARKET, orderBook: ORDER_BOOK, account: ACCOUNT },
  );
}

describe("Lighter order preview", () => {
  it("normalizes display amounts into exact Lighter integer fields", () => {
    const result = preview();

    expect(result.preview.baseAmount).toEqual({
      display: "1.25",
      integer: "12500",
      decimals: 4,
    });
    expect(result.preview.price).toEqual({
      display: "2999.99",
      integer: "299999",
      decimals: 2,
      role: "limit_price",
    });
    expect(result.preview.quoteNotional).toEqual({
      display: "3749.9875",
      integer: "3749987500",
      decimals: 6,
    });
    expect(result.preview.minimumChecks.minBaseAmountInteger).toBe("10");
    expect(result.preview.minimumChecks.minQuoteAmountInteger).toBe("100000000");
    expect(result.preview.minimumChecks.baseAmountPasses).toBe(true);
    expect(result.preview.minimumChecks.quoteAmountPasses).toBe(true);
    expect(result.preview.marketData.priceComparison).toBe("resting");
  });

  it("binds session, environment, account, market, side, amount, price, and settings in the match hash", () => {
    const base = preview().identity;
    const baseHash = computeLighterOrderPreviewHash(base);

    const variants = [
      { ...base, sessionId: "session-2" },
      { ...base, environment: "rhc" as const },
      { ...base, accountIndex: "43" },
      { ...base, marketIndex: "1" },
      { ...base, side: "sell" as const },
      { ...base, baseAmountInteger: "12501" },
      { ...base, priceInteger: "300000" },
      { ...base, timeInForce: "post-only" as const },
      { ...base, expiryMs: String(NOW + 20 * 60 * 1000) },
    ];

    for (const variant of variants) {
      expect(computeLighterOrderPreviewHash(variant)).not.toBe(baseHash);
    }
  });

  it("refuses amounts below the live market minimum", () => {
    expect(() => preview({ baseAmount: "0.0009" })).toThrowError(
      expect.objectContaining({ code: ErrorCodes.LIGHTER_INVALID_REQUEST }),
    );
  });

  it("refuses over-precise amount and price input instead of rounding", () => {
    expect(() => preview({ baseAmount: "1.00001" })).toThrowError(
      expect.objectContaining({ code: ErrorCodes.LIGHTER_INVALID_REQUEST }),
    );
    expect(() => preview({ price: "3000.001" })).toThrowError(
      expect.objectContaining({ code: ErrorCodes.LIGHTER_INVALID_REQUEST }),
    );
  });

  it("requires market order previews to carry an IOC worst acceptable price", () => {
    const result = preview({
      orderType: "market",
      timeInForce: "immediate-or-cancel",
      price: "3001.00",
    });

    expect(result.preview.price.role).toBe("worst_acceptable_price");
    expect(result.preview.marketData.priceComparison).toBe("crossing_or_taker");
  });

  it("refuses reduce-only orders that do not reduce the live position", () => {
    expect(() => preview({ reduceOnly: true, side: "buy" })).toThrowError(
      expect.objectContaining({ code: ErrorCodes.LIGHTER_INVALID_REQUEST }),
    );

    const reducing = preview({ reduceOnly: true, side: "sell", price: "3001.00" });
    expect(reducing.preview.positionContext).toEqual({
      verified: true,
      marketPosition: "1.5",
      positionSide: "long",
    });
  });

  it("fails closed when quote decimals do not match Lighter documented size+price scale", () => {
    expect(() => buildLighterOrderPreview(INPUT, {
      market: { ...MARKET, supported_quote_decimals: 5 },
      orderBook: ORDER_BOOK,
      account: ACCOUNT,
    })).toThrowError(expect.objectContaining({ code: ErrorCodes.LIGHTER_INVALID_REQUEST }));
  });
});
