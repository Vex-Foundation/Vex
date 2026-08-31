import { describe, expect, it, vi } from "vitest";

import {
  buildLighterOcoPreview,
  buildLighterUnsignedOcoRequest,
  LIGHTER_OCO_GROUPING_TYPE,
} from "@tools/lighter/oco-order.js";
import {
  buildLighterCreateGroupedOrdersSigningInput,
  signLighterCreateGroupedOrdersWithAdapter,
  type LighterGroupedOrderSignerAdapter,
} from "@tools/lighter/signer-grouped-orders.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";
import type {
  LighterAccountResponse,
  LighterMarketDetail,
  LighterOrderBookOrdersResponse,
} from "@tools/lighter/types.js";

const NOW = 1_786_233_600_000;
const EXPIRY = NOW + 30 * 60_000;
const MARKET: LighterMarketDetail = {
  symbol: "ETH", market_id: 0, market_type: "perp", base_asset_id: 1,
  quote_asset_id: 0, status: "active", taker_fee: "0.0280", maker_fee: "0.0040",
  liquidation_fee: "0", min_base_amount: "0.001", min_quote_amount: "100",
  supported_size_decimals: 4, supported_price_decimals: 2,
  supported_quote_decimals: 6, order_quote_limit: "1000000000000",
  is_maker_fee_enabled: true, is_taker_fee_enabled: true,
  last_trade_price: 3000, mark_price: "3000.10", index_price: "3000.00",
};
const ORDER_BOOK: LighterOrderBookOrdersResponse = {
  code: 200, total_asks: 1, total_bids: 1,
  asks: [{ order_index: 1, order_id: "1", owner_account_index: 7,
    initial_base_amount: "1", remaining_base_amount: "1", price: "3000.50",
    order_expiry: EXPIRY, transaction_time: NOW }],
  bids: [{ order_index: 2, order_id: "2", owner_account_index: 8,
    initial_base_amount: "1", remaining_base_amount: "1", price: "2999.50",
    order_expiry: EXPIRY, transaction_time: NOW }],
};
const ACCOUNT: LighterAccountResponse = {
  code: 200, total: 1, accounts: [{ index: 42, status: 1, collateral: "1000",
    available_balance: "900", positions: [{ market_id: 0, symbol: "ETH",
      initial_margin_fraction: "5", open_order_count: 0, pending_order_count: 0,
      position_tied_order_count: 0, sign: 1, position: "1.5", avg_entry_price: "3000",
      position_value: "4500", unrealized_pnl: "0", realized_pnl: "0",
      liquidation_price: "2000", margin_mode: 0, allocated_margin: "0" }] }],
};

function preview(overrides: Partial<Parameters<typeof buildLighterOcoPreview>[0]> = {}) {
  return buildLighterOcoPreview({
    sessionId: "session-1", environment: "core", accountIndex: 42, apiKeyIndex: 7,
    marketId: 0, side: "sell", baseAmount: "1.25",
    stopLoss: { triggerPrice: "2850", price: "2800" },
    takeProfit: { triggerPrice: "3300", price: "3250" },
    orderExpiry: EXPIRY, nowMs: NOW, ...overrides,
  }, { market: MARKET, orderBook: ORDER_BOOK, account: ACCOUNT });
}

describe("Lighter native OCO protection", () => {
  it("builds one exact group from validated stop-loss and take-profit legs", () => {
    const result = preview();
    expect(result.previewId).toMatch(/^loc_[0-9a-f]{24}$/);
    expect(result.identity.groupingType).toBe("one-cancels-the-other");
    expect(result.stopLoss.preview.orderType).toBe("stop-loss");
    expect(result.takeProfit.preview.orderType).toBe("take-profit");
    expect(result.stopLoss.preview.reduceOnly).toBe(true);
    expect(result.takeProfit.preview.reduceOnly).toBe(true);
    expect(result.preview.baseAmount.integer).toBe("12500");
  });

  it("refuses either crossed trigger instead of creating partial protection", () => {
    expect(() => preview({
      takeProfit: { triggerPrice: "2900", price: "2850" },
    })).toThrow("take-profit for a long position requires triggerPrice above");
  });

  it("maps OCO to native grouping type 2 with distinct child ids", () => {
    const result = preview();
    const unsigned = buildLighterUnsignedOcoRequest({
      matchHash: result.matchHash,
      environment: result.identity.environment,
      accountIndex: Number(result.identity.accountIndex),
      apiKeyIndex: Number(result.identity.apiKeyIndex),
      marketIndex: Number(result.identity.marketIndex),
      side: result.identity.side,
      baseAmountInteger: result.identity.baseAmountInteger,
      orderExpiryMs: Number(result.identity.expiryMs),
      stopLoss: {
        matchHash: result.stopLoss.matchHash,
        priceInteger: result.stopLoss.preview.price.integer,
        triggerPriceInteger: result.stopLoss.preview.triggerPrice.integer!,
      },
      takeProfit: {
        matchHash: result.takeProfit.matchHash,
        priceInteger: result.takeProfit.preview.price.integer,
        triggerPriceInteger: result.takeProfit.preview.triggerPrice.integer!,
      },
    });
    expect(unsigned.groupingTypeCode).toBe(LIGHTER_OCO_GROUPING_TYPE);
    expect(unsigned.orders.map((order) => order.orderTypeCode)).toEqual([2, 4]);
    expect(unsigned.orders[0].clientOrderIndex).not.toBe(unsigned.orders[1].clientOrderIndex);
    expect(unsigned.orders.every((order) => order.reduceOnly)).toBe(true);
  });

  it("accepts only an exact tx type 28 signer result", async () => {
    const result = preview();
    const group = buildLighterUnsignedOcoRequest({
      matchHash: result.matchHash, environment: "core", accountIndex: 42, apiKeyIndex: 7,
      marketIndex: 0, side: "sell", baseAmountInteger: "12500", orderExpiryMs: EXPIRY,
      stopLoss: { matchHash: result.stopLoss.matchHash, priceInteger: "280000", triggerPriceInteger: "285000" },
      takeProfit: { matchHash: result.takeProfit.matchHash, priceInteger: "325000", triggerPriceInteger: "330000" },
    });
    const input = buildLighterCreateGroupedOrdersSigningInput({
      group, secret: materialFromSecret(`0x${"1".repeat(80)}`), nonce: "9",
      restBaseUrl: "https://mainnet.zklighter.elliot.ai",
    });
    const adapter: LighterGroupedOrderSignerAdapter = {
      source: "official_lighter_signer",
      signCreateGroupedOrders: vi.fn<LighterGroupedOrderSignerAdapter["signCreateGroupedOrders"]>(async () => ({
        kind: "lighter_create_grouped_orders_signer_result", environment: "core",
        accountIndex: 42, apiKeyIndex: 7, nonce: "9",
        clientOrderIndexes: [group.orders[0].clientOrderIndex, group.orders[1].clientOrderIndex],
        matchHash: group.matchHash, txType: 28, txInfo: "{}", txHash: "0xabc",
      })),
    };
    await expect(signLighterCreateGroupedOrdersWithAdapter(input, adapter)).resolves.toMatchObject({ txType: 28 });
  });
});
