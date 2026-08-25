import { describe, expect, it } from "vitest";

import {
  buildLighterOrderPreview,
  type LighterOrderPreviewInput,
} from "@tools/lighter/order-preview.js";
import type {
  LighterAccountResponse,
  LighterMarketDetail,
  LighterOrderBookOrdersResponse,
} from "@tools/lighter/types.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
import type { LighterOrderReadyForSignerPlan } from "@vex-agent/tools/protocols/lighter/execution-plan.js";
import { revalidateApprovedLighterOrder } from "@vex-agent/tools/protocols/lighter/pre-submit-revalidation.js";

const NOW = 1_786_233_600_000;
const MARKET: LighterMarketDetail = {
  symbol: "ETH",
  market_id: 0,
  market_type: "perp",
  base_asset_id: 1,
  quote_asset_id: 0,
  status: "active",
  taker_fee: "0",
  maker_fee: "0",
  liquidation_fee: "0",
  min_base_amount: "0.001",
  min_quote_amount: "100",
  supported_size_decimals: 4,
  supported_price_decimals: 2,
  supported_quote_decimals: 6,
  order_quote_limit: "1000000000000",
  is_maker_fee_enabled: true,
  is_taker_fee_enabled: true,
  mark_price: "3000.00",
};
const ORDER_BOOK: LighterOrderBookOrdersResponse = {
  code: 200,
  total_asks: 1,
  asks: [{
    order_index: 1,
    order_id: "1",
    owner_account_index: 8,
    initial_base_amount: "1",
    remaining_base_amount: "1",
    price: "3001.00",
    order_expiry: NOW + 600_000,
    transaction_time: NOW,
  }],
  total_bids: 1,
  bids: [{
    order_index: 2,
    order_id: "2",
    owner_account_index: 9,
    initial_base_amount: "1",
    remaining_base_amount: "1",
    price: "2999.00",
    order_expiry: NOW + 600_000,
    transaction_time: NOW,
  }],
};
const ACCOUNT: LighterAccountResponse = {
  code: 200,
  total: 1,
  accounts: [{
    index: 42,
    status: 1,
    collateral: "1000",
    available_balance: "900",
    positions: [{
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
    }],
  }],
};
const BASE_INPUT: LighterOrderPreviewInput = {
  sessionId: "session-1",
  environment: "rhc",
  accountIndex: 42,
  apiKeyIndex: 7,
  marketId: 0,
  side: "buy",
  baseAmount: "1",
  price: "3000",
  orderType: "limit",
  timeInForce: "good-till-time",
  reduceOnly: false,
  orderExpiry: NOW + 10 * 60 * 1_000,
  clientOrderIndexPolicy: "vex_assigned_uint48",
  nowMs: NOW,
};

function first<T>(values: readonly T[]): T {
  const value = values.at(0);
  if (value === undefined) throw new Error("test fixture must not be empty");
  return value;
}

function approvedFixture(overrides: Partial<LighterOrderPreviewInput> = {}) {
  const input = { ...BASE_INPUT, ...overrides };
  const preview = buildLighterOrderPreview(input, {
    market: MARKET,
    orderBook: ORDER_BOOK,
    account: ACCOUNT,
  });
  const row: LighterOrderPreviewRow = {
    previewId: preview.previewId,
    sessionId: input.sessionId,
    matchHash: preview.matchHash,
    environment: input.environment,
    accountIndex: input.accountIndex,
    apiKeyIndex: input.apiKeyIndex ?? null,
    marketIndex: input.marketId,
    side: input.side,
    baseAmountInteger: preview.identity.baseAmountInteger,
    priceInteger: preview.identity.priceInteger,
    orderType: input.orderType,
    timeInForce: input.timeInForce,
    reduceOnly: input.reduceOnly,
    triggerPriceInteger: null,
    orderExpiryMs: input.orderExpiry,
    clientOrderIndexPolicy: input.clientOrderIndexPolicy,
    providerVersion: preview.identity.providerVersion,
    previewJson: { ...preview.preview },
    liveSourceJson: { source: "live_lighter_public_api" },
    createdAt: new Date(NOW).toISOString(),
    expiresAt: preview.expiresAt,
  };
  if (row.apiKeyIndex === null) throw new Error("test preview must bind an API key");
  const plan: LighterOrderReadyForSignerPlan = {
    intentId: "lighter-exec-1",
    sessionId: row.sessionId,
    previewId: row.previewId,
    matchHash: row.matchHash,
    environment: row.environment,
    accountIndex: row.accountIndex,
    apiKeyIndex: row.apiKeyIndex,
    marketIndex: row.marketIndex,
    side: row.side,
    baseAmountInteger: row.baseAmountInteger,
    priceInteger: row.priceInteger,
    orderType: row.orderType,
    timeInForce: row.timeInForce,
    reduceOnly: row.reduceOnly,
    triggerPriceInteger: row.triggerPriceInteger,
    orderExpiryMs: row.orderExpiryMs,
    clientOrderIndexPolicy: row.clientOrderIndexPolicy,
    providerVersion: row.providerVersion,
    credentialReference: {
      kind: "encrypted_vault_reference",
      environment: row.environment,
      accountIndex: row.accountIndex,
      apiKeyIndex: row.apiKeyIndex,
      vaultCredentialId: "lighter/rhc/account-42/api-key-7",
    },
    nonceScope: {
      environment: row.environment,
      accountIndex: row.accountIndex,
      apiKeyIndex: row.apiKeyIndex,
    },
  };
  return { row, plan };
}

describe("Lighter post-approval pre-submit revalidation", () => {
  it("returns bounded public evidence for unchanged live state", () => {
    const { row, plan } = approvedFixture();

    const evidence = revalidateApprovedLighterOrder({
      plan,
      approvedPreview: row,
      context: { market: MARKET, orderBook: ORDER_BOOK, account: ACCOUNT },
      nowMs: NOW + 60_000,
    });

    expect(evidence).toMatchObject({
      kind: "lighter_order_pre_submit_revalidation",
      previewId: plan.previewId,
      matchHash: plan.matchHash,
      marketStatus: "active",
      priceComparison: "resting",
    });
    expect(JSON.stringify(evidence)).not.toMatch(/auth|token|private|secret|signature|payload/i);
  });

  it("refuses a persisted preview that differs from the approved execution intent", () => {
    const { row, plan } = approvedFixture();

    expect(() => revalidateApprovedLighterOrder({
      plan,
      approvedPreview: { ...row, marketIndex: 1 },
      context: { market: MARKET, orderBook: ORDER_BOOK, account: ACCOUNT },
      nowMs: NOW + 60_000,
    })).toThrow("no longer matches the approved execution intent");
  });

  it("refuses changed precision or market minimums", () => {
    const { row, plan } = approvedFixture();

    expect(() => revalidateApprovedLighterOrder({
      plan,
      approvedPreview: row,
      context: {
        market: { ...MARKET, supported_price_decimals: 3, supported_quote_decimals: 7 },
        orderBook: ORDER_BOOK,
        account: ACCOUNT,
      },
      nowMs: NOW + 60_000,
    })).toThrow("market precision changed");

    expect(() => revalidateApprovedLighterOrder({
      plan,
      approvedPreview: row,
      context: {
        market: { ...MARKET, min_base_amount: "2" },
        orderBook: ORDER_BOOK,
        account: ACCOUNT,
      },
      nowMs: NOW + 60_000,
    })).toThrow("no longer satisfies the approved preview");
  });

  it("refuses missing account state and reduce-only position drift", () => {
    const normal = approvedFixture();
    expect(() => revalidateApprovedLighterOrder({
      plan: normal.plan,
      approvedPreview: normal.row,
      context: { market: MARKET, orderBook: ORDER_BOOK, account: { code: 200, accounts: [] } },
      nowMs: NOW + 60_000,
    })).toThrow("no longer satisfies the approved preview");

    const reducing = approvedFixture({ side: "sell", reduceOnly: true, price: "3001" });
    expect(() => revalidateApprovedLighterOrder({
      plan: reducing.plan,
      approvedPreview: reducing.row,
      context: {
        market: MARKET,
        orderBook: ORDER_BOOK,
        account: {
          ...ACCOUNT,
          accounts: [{ ...first(ACCOUNT.accounts), positions: [] }],
        },
      },
      nowMs: NOW + 60_000,
    })).toThrow("no longer satisfies the approved preview");
  });

  it("refuses a market IOC after the opposite best price exceeds its approved bound", () => {
    const { row, plan } = approvedFixture({
      orderType: "market",
      timeInForce: "immediate-or-cancel",
      price: "3002",
    });

    expect(() => revalidateApprovedLighterOrder({
      plan,
      approvedPreview: row,
      context: {
        market: MARKET,
        orderBook: {
          ...ORDER_BOOK,
          asks: [{ ...first(ORDER_BOOK.asks), price: "3002.01" }],
        },
        account: ACCOUNT,
      },
      nowMs: NOW + 60_000,
    })).toThrow("moved beyond the approved market-order worst price");
  });

  it("refuses a post-only limit that would now cross the live book", () => {
    const { row, plan } = approvedFixture({ timeInForce: "post-only" });

    expect(() => revalidateApprovedLighterOrder({
      plan,
      approvedPreview: row,
      context: {
        market: MARKET,
        orderBook: {
          ...ORDER_BOOK,
          asks: [{ ...first(ORDER_BOOK.asks), price: "2999.99" }],
        },
        account: ACCOUNT,
      },
      nowMs: NOW + 60_000,
    })).toThrow("would now cross the live book");
  });
});
