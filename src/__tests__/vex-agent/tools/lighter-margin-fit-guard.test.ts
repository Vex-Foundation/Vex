/**
 * The prepare and execute guard that refuses an order Lighter's own margin
 * check would cancel with no fill, whether or not a capital share is set.
 * Figures are account 31824's 06:48 ETH buy on 2026-09-24.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCodes, VexError } from "../../../errors.js";
import type { LighterClient } from "@tools/lighter/client.js";
import type {
  LighterAccount,
  LighterAccountPosition,
  LighterMarketDetail,
} from "@tools/lighter/types.js";
import type {
  LighterMarginFitClient,
  LighterMarginFitPreview,
} from "@vex-agent/tools/protocols/lighter/margin-fit-guard.js";

const mockResolveAuth = vi.fn();

vi.mock("@vex-agent/tools/protocols/lighter/read-account-auth.js", () => ({
  resolveLighterReadOnlyAccountAuth: (...args: unknown[]) => mockResolveAuth(...args),
}));

const { assertLighterOrderFitsAccountMargin } = await import(
  "@vex-agent/tools/protocols/lighter/margin-fit-guard.js"
);

const ETH_MARKET: LighterMarketDetail = {
  symbol: "ETH",
  market_id: 0,
  market_type: "perp",
  base_asset_id: 1,
  quote_asset_id: 3,
  status: "active",
  taker_fee: "0.0000",
  maker_fee: "0.0000",
  liquidation_fee: "1.0000",
  min_base_amount: "0.0050",
  min_quote_amount: "10.000000",
  supported_size_decimals: 4,
  supported_price_decimals: 2,
  supported_quote_decimals: 6,
  order_quote_limit: "1000000000000",
  is_maker_fee_enabled: true,
  is_taker_fee_enabled: true,
  default_initial_margin_fraction: 5000,
  mark_price: "2690.88",
};

function ethPosition(sign: number, position: string): LighterAccountPosition {
  return {
    market_id: 0,
    symbol: "ETH",
    initial_margin_fraction: "4.77",
    open_order_count: 0,
    pending_order_count: 0,
    position_tied_order_count: 0,
    sign,
    position,
    avg_entry_price: "0.00",
    position_value: "0.000000",
    unrealized_pnl: "0.000000",
    realized_pnl: "0.000000",
    liquidation_price: "0",
    margin_mode: 0,
    allocated_margin: "0.000000",
  };
}

function account(overrides: Partial<LighterAccount> = {}): LighterAccount {
  return {
    index: 31824,
    available_balance: "8.792317",
    collateral: "8.792317",
    positions: [ethPosition(1, "0.0000")],
    ...overrides,
  };
}

function preview(overrides: Partial<LighterMarginFitPreview> = {}): LighterMarginFitPreview {
  return {
    marketIndex: 0,
    side: "buy",
    baseAmountInteger: "667",
    priceInteger: "270461",
    orderType: "market",
    reduceOnly: false,
    integratorFees: { integratorMakerFee: 1000, integratorTakerFee: 1000, integratorAccountIndex: 22869 },
    previewJson: {
      price: { display: "2704.61" },
      quoteNotional: { display: "180.397487" },
      marketData: { referencePrice: "2690.87" },
    },
    ...overrides,
  };
}

function bookOrder(price: string, remaining: string) {
  return {
    order_index: 1,
    order_id: "1",
    owner_account_index: 7,
    initial_base_amount: remaining,
    remaining_base_amount: remaining,
    price,
    order_expiry: 0,
    transaction_time: 0,
  };
}

function client(options: { readonly tier?: number | null; readonly marketFails?: boolean } = {}) {
  const reads = {
    getMarketDetails: vi.fn<LighterClient["getMarketDetails"]>(async () => {
      if (options.marketFails === true) throw new Error("provider down");
      return { code: 200, order_book_details: [ETH_MARKET], spot_order_book_details: [] };
    }),
    getAccountLimits: vi.fn<LighterClient["getAccountLimits"]>(async () => {
      if (options.tier === null) throw new Error("limits unavailable");
      return {
        code: 200,
        user_tier: "premium",
        user_tier_name: "Premium",
        current_maker_fee_tick: 120,
        current_taker_fee_tick: options.tier ?? 350,
      };
    }),
    getOrderBookOrders: vi.fn<LighterClient["getOrderBookOrders"]>(async () => ({
      code: 200,
      total_asks: 1,
      asks: [bookOrder("2691.15", "12.5682")],
      total_bids: 1,
      bids: [bookOrder("2690.61", "3.0000")],
    })),
  };
  const typed: LighterMarginFitClient = reads;
  return { reads, typed };
}

async function refusal(run: Promise<void>): Promise<VexError> {
  const error = await run.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(VexError);
  if (!(error instanceof VexError)) throw new Error("expected a VexError refusal");
  return error;
}

describe("assertLighterOrderFitsAccountMargin", () => {
  beforeEach(() => {
    mockResolveAuth.mockReset();
    mockResolveAuth.mockResolvedValue({ token: "read-only", accountIndex: 31824 });
  });

  it("refuses the order Lighter cancelled, before anything is signed, and names the size that fits", async () => {
    const error = await refusal(assertLighterOrderFitsAccountMargin({
      environment: "rhc",
      accountIndex: 31824,
      account: account(),
      preview: preview(),
      client: client().typed,
    }));

    expect(error.code).toBe(ErrorCodes.INSUFFICIENT_BALANCE);
    expect(error.message).toContain("needs about 8.821611 USDG");
    expect(error.message).toContain("has 8.792317 USDG available");
    expect(error.message).toContain("Nothing was signed");
    expect(error.message).toContain("Reduce the size to 0.0664 ETH or less");
  });

  it("admits the same order at the size it names", async () => {
    await expect(assertLighterOrderFitsAccountMargin({
      environment: "rhc",
      accountIndex: 31824,
      account: account(),
      preview: preview({ baseAmountInteger: "664" }),
      client: client().typed,
    })).resolves.toBeUndefined();
  });

  it("makes no extra reads for an order far inside the available balance", async () => {
    const { reads, typed } = client();
    await assertLighterOrderFitsAccountMargin({
      environment: "rhc",
      accountIndex: 31824,
      account: account(),
      preview: preview({
        baseAmountInteger: "77",
        previewJson: {
          price: { display: "2704.61" },
          quoteNotional: { display: "20.825497" },
          marketData: { referencePrice: "2690.87" },
        },
      }),
      client: typed,
    });

    expect(reads.getMarketDetails).not.toHaveBeenCalled();
    expect(reads.getAccountLimits).not.toHaveBeenCalled();
  });

  it("prices an unreadable fee tier at the ceiling instead of the market's zero fee", async () => {
    // 0.0664 fits at the real 0.035% tier but not at the 0.05% ceiling.
    const error = await refusal(assertLighterOrderFitsAccountMargin({
      environment: "rhc",
      accountIndex: 31824,
      account: account(),
      preview: preview({ baseAmountInteger: "664" }),
      client: client({ tier: null }).typed,
    }));

    expect(error.code).toBe(ErrorCodes.INSUFFICIENT_BALANCE);
  });

  it("counts only the part of the order that adds exposure past an opposite position", async () => {
    await expect(assertLighterOrderFitsAccountMargin({
      environment: "rhc",
      accountIndex: 31824,
      account: account({ positions: [ethPosition(-1, "0.0600")] }),
      preview: preview(),
      client: client().typed,
    })).resolves.toBeUndefined();
  });

  it("leaves reduce-only orders to Lighter", async () => {
    const { reads, typed } = client();
    await assertLighterOrderFitsAccountMargin({
      environment: "rhc",
      accountIndex: 31824,
      account: account({ available_balance: "0" }),
      preview: preview({ reduceOnly: true }),
      client: typed,
    });

    expect(reads.getMarketDetails).not.toHaveBeenCalled();
  });

  it("lets the order through when the market cannot be read, since Lighter is the final check", async () => {
    await expect(assertLighterOrderFitsAccountMargin({
      environment: "rhc",
      accountIndex: 31824,
      account: account(),
      preview: preview(),
      client: client({ marketFails: true }).typed,
    })).resolves.toBeUndefined();
  });
});
