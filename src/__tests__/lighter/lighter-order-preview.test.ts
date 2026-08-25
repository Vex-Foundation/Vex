import { describe, expect, it } from "vitest";

import { ErrorCodes } from "../../errors.js";
import {
  buildLighterOrderPreview,
  computeLighterOrderPreviewHash,
  type LighterOrderPreviewInput,
} from "@tools/lighter/order-preview.js";
import { validateLighterAccount } from "@tools/lighter/validation.js";
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
          initial_margin_fraction: "5.00",
          open_order_count: 0,
          pending_order_count: 0,
          position_tied_order_count: 0,
          sign: 1,
          position: "1.5",
          avg_entry_price: "3000",
          position_value: "4500",
          unrealized_pnl: "0",
          realized_pnl: "0",
          liquidation_price: "2000",
          margin_mode: 0,
          allocated_margin: "0",
        },
      ],
    },
  ],
};

const SPOT_MARKET: LighterMarketDetail = {
  ...MARKET,
  symbol: "ETH/USDC",
  market_id: 2048,
  market_type: "spot",
  base_asset_id: 1,
  quote_asset_id: 3,
  taker_fee: "0.0000",
};

function spotAccount(
  baseBalance = "2.00000000",
  baseLocked = "0.50000000",
  quoteBalance = "5000.000000",
  quoteLocked = "100.000000",
): LighterAccountResponse {
  return {
    code: 200,
    total: 1,
    accounts: [{
      index: 42,
      status: 1,
      assets: [
        {
          symbol: "ETH",
          asset_id: 1,
          balance: baseBalance,
          locked_balance: baseLocked,
          margin_balance: "0.00000000",
          margin_mode: "disabled",
          multiplier: "1.000000000000000000",
        },
        {
          symbol: "USDC",
          asset_id: 3,
          balance: quoteBalance,
          locked_balance: quoteLocked,
          margin_balance: "0.000000",
          margin_mode: "enabled",
          multiplier: "1.000000000000000000",
        },
      ],
    }],
  };
}

function first<T>(values: readonly T[]): T {
  const value = values.at(0);
  if (value === undefined) throw new Error("test fixture must not be empty");
  return value;
}

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

function spotPreview(
  side: "buy" | "sell",
  account = spotAccount(),
  market: LighterMarketDetail = SPOT_MARKET,
) {
  return buildLighterOrderPreview(
    { ...INPUT, marketId: 2048, side },
    { market, orderBook: ORDER_BOOK, account },
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
    expect(result.preview.minimumChecks.minBaseAmountDisplay).toBe("0.001");
    expect(result.preview.minimumChecks.minQuoteAmountInteger).toBe("100000000");
    expect(result.preview.minimumChecks.minQuoteAmountDisplay).toBe("100");
    expect(result.preview.minimumChecks.baseAmountPasses).toBe(true);
    expect(result.preview.minimumChecks.quoteAmountPasses).toBe(true);
    expect(result.preview.marketData.priceComparison).toBe("resting");
  });

  it("compares best prices exactly when decimal string scales differ", () => {
    const result = buildLighterOrderPreview(
      { ...INPUT, side: "sell", baseAmount: "10", price: "10.01" },
      {
        market: MARKET,
        account: ACCOUNT,
        orderBook: {
          ...ORDER_BOOK,
          bids: [{ ...first(ORDER_BOOK.bids), price: "9.9" }],
        },
      },
    );

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

  it("refuses integer amounts that exceed Lighter signer wire bounds", () => {
    expect(() => preview({ price: "50000000.00" })).toThrowError(
      expect.objectContaining({
        code: ErrorCodes.LIGHTER_INVALID_REQUEST,
        message: expect.stringContaining("uint32"),
      }),
    );
    expect(() => preview({ baseAmount: "1000000000000000" })).toThrowError(
      expect.objectContaining({
        code: ErrorCodes.LIGHTER_INVALID_REQUEST,
        message: expect.stringContaining("int64"),
      }),
    );
  });

  it("refuses market ids beyond lighter-go's product-specific market range", () => {
    expect(() => preview({ marketId: 40_000 })).toThrowError(
      expect.objectContaining({
        code: ErrorCodes.LIGHTER_INVALID_REQUEST,
        message: expect.stringContaining("4094"),
      }),
    );
    expect(() => buildLighterOrderPreview(
      { ...INPUT, marketId: 255 },
      { market: { ...MARKET, market_id: 255 }, orderBook: ORDER_BOOK, account: ACCOUNT },
    )).toThrowError(expect.objectContaining({ message: expect.stringContaining("0 through 254") }));
    expect(() => buildLighterOrderPreview(
      { ...INPUT, marketId: 2047 },
      { market: { ...SPOT_MARKET, market_id: 2047 }, orderBook: ORDER_BOOK, account: spotAccount() },
    )).toThrowError(expect.objectContaining({ message: expect.stringContaining("2048 through 4094") }));
  });

  it("fails closed when quote decimals do not match Lighter documented size+price scale", () => {
    expect(() => buildLighterOrderPreview(INPUT, {
      market: { ...MARKET, supported_quote_decimals: 5 },
      orderBook: ORDER_BOOK,
      account: ACCOUNT,
    })).toThrowError(expect.objectContaining({ code: ErrorCodes.LIGHTER_INVALID_REQUEST }));
  });

  it("parses typed account asset inventory from the live account shape", () => {
    const parsed = validateLighterAccount(spotAccount());

    expect(parsed.accounts[0]?.assets?.[0]).toEqual(expect.objectContaining({
      symbol: "ETH",
      asset_id: 1,
      balance: "2.00000000",
      locked_balance: "0.50000000",
    }));
    expect(() => validateLighterAccount({
      ...spotAccount(),
      accounts: [{ index: 42, assets: [{ asset_id: 1, balance: "2" }] }],
    })).toThrowError(expect.objectContaining({ code: ErrorCodes.LIGHTER_INVALID_RESPONSE }));
  });

  it("proves unlocked base inventory before previewing a spot sell", () => {
    const result = spotPreview("sell");

    expect(result.preview.spotInventoryContext).toEqual({
      verified: true,
      assetId: 1,
      symbol: "ETH",
      balance: "2",
      lockedBalance: "0.5",
      unlockedBalance: "1.5",
      requiredAmount: "1.25",
      requiredKind: "base_amount",
      takerFee: "none",
      takerFeePercent: null,
      takerFeeAmount: "0",
    });
  });

  it("refuses a spot sell when locked base leaves insufficient free inventory", () => {
    expect(() => spotPreview("sell", spotAccount("2", "1"))).toThrowError(
      expect.objectContaining({
        code: ErrorCodes.LIGHTER_INVALID_REQUEST,
        message: expect.stringContaining("unlocked base asset balance"),
      }),
    );
  });

  it("proves unlocked quote inventory against the spot buy worst-price notional", () => {
    const result = spotPreview("buy");

    expect(result.preview.spotInventoryContext).toEqual(expect.objectContaining({
      verified: true,
      assetId: 3,
      symbol: "USDC",
      unlockedBalance: "4900",
      requiredAmount: "3749.9875",
      requiredKind: "worst_price_quote_notional",
      takerFee: "zero_from_live_market",
      takerFeePercent: "0",
      takerFeeAmount: "0",
    }));
  });

  it("refuses a spot buy when locked quote leaves insufficient free inventory", () => {
    expect(() => spotPreview("buy", spotAccount("2", "0", "3800", "100"))).toThrowError(
      expect.objectContaining({
        code: ErrorCodes.LIGHTER_INVALID_REQUEST,
        message: expect.stringContaining("unlocked quote asset balance"),
      }),
    );
  });

  it("includes the live percentage fee in a spot buy inventory proof", () => {
    const result = spotPreview("buy", spotAccount(), { ...SPOT_MARKET, taker_fee: "0.0280" });

    expect(result.preview.spotInventoryContext).toEqual(expect.objectContaining({
      requiredAmount: "3751.037497",
      requiredKind: "worst_price_quote_notional_with_taker_fee",
      takerFee: "included_live_market_percentage",
      takerFeePercent: "0.028",
      takerFeeAmount: "1.049997",
    }));
  });

  it("refuses spot reduce-only and missing inventory", () => {
    expect(() => buildLighterOrderPreview(
      { ...INPUT, marketId: 2048, reduceOnly: true },
      { market: SPOT_MARKET, orderBook: ORDER_BOOK, account: spotAccount() },
    )).toThrowError(expect.objectContaining({ message: expect.stringContaining("reduceOnly must be false") }));

    expect(() => spotPreview("sell", { code: 200, accounts: [{ index: 42, assets: [] }] }))
      .toThrowError(expect.objectContaining({ message: expect.stringContaining("exactly one asset 1") }));
  });
});
