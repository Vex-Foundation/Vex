import { describe, expect, it, vi } from "vitest";

import { buildLighterOcoPreview, buildLighterUnsignedOcoRequest } from "@tools/lighter/oco-order.js";
import type { LighterOrderPreview } from "@tools/lighter/order-preview.js";
import type { LighterAccountResponse, LighterMarketDetail } from "@tools/lighter/types.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
import type { LighterOcoExecutionPlan } from "@vex-agent/tools/protocols/lighter/oco-execution-plan.js";
import {
  executeApprovedLighterOco,
  type LighterOcoExecutionDeps,
} from "@vex-agent/tools/protocols/lighter/oco-order-execution.js";

const NOW = 1_893_456_000_000;
const EXPIRY = NOW + 30 * 60_000;
const PUBLIC_KEY = "b".repeat(80);
const TX_HASH = "0xoco";
const MARKET: LighterMarketDetail = {
  symbol: "ETH", market_id: 0, market_type: "perp", base_asset_id: 1, quote_asset_id: 0,
  status: "active", taker_fee: "0", maker_fee: "0", liquidation_fee: "0",
  min_base_amount: "0.001", min_quote_amount: "10", supported_size_decimals: 4,
  supported_price_decimals: 2, supported_quote_decimals: 6, order_quote_limit: "1000000000",
  is_maker_fee_enabled: true, is_taker_fee_enabled: true, mark_price: "3000",
};
const BOOK = {
  code: 200, total_asks: 1, total_bids: 1,
  asks: [{ order_index: 1, order_id: "1", owner_account_index: 8, initial_base_amount: "1", remaining_base_amount: "1", price: "3001", order_expiry: EXPIRY, transaction_time: NOW }],
  bids: [{ order_index: 2, order_id: "2", owner_account_index: 9, initial_base_amount: "1", remaining_base_amount: "1", price: "2999", order_expiry: EXPIRY, transaction_time: NOW }],
};
const ACCOUNT: LighterAccountResponse = {
  code: 200, total: 1, accounts: [{
    index: 42, status: 1, collateral: "1000", available_balance: "900",
    positions: [{ market_id: 0, symbol: "ETH", sign: 1, position: "1", avg_entry_price: "3000" }],
  }],
};
const PREVIEW = buildLighterOcoPreview({
  sessionId: "session-1", environment: "rhc", accountIndex: 42, apiKeyIndex: 7,
  marketId: 0, side: "sell", baseAmount: "1",
  stopLoss: { triggerPrice: "2900", price: "2850" },
  takeProfit: { triggerPrice: "3300", price: "3250" },
  orderExpiry: EXPIRY, nowMs: NOW,
}, { market: MARKET, orderBook: BOOK, account: ACCOUNT });
const PLAN: LighterOcoExecutionPlan = {
  intentId: "lighter-oco-1", sessionId: "session-1",
  stopLossPreviewId: PREVIEW.stopLoss.previewId,
  takeProfitPreviewId: PREVIEW.takeProfit.previewId,
  matchHash: PREVIEW.matchHash, environment: "rhc", accountIndex: 42, apiKeyIndex: 7,
  marketIndex: 0, side: "sell", baseAmountInteger: PREVIEW.identity.baseAmountInteger,
  orderExpiryMs: EXPIRY,
  stopLoss: { matchHash: PREVIEW.stopLoss.matchHash, priceInteger: PREVIEW.stopLoss.identity.priceInteger, triggerPriceInteger: PREVIEW.stopLoss.identity.triggerPriceInteger },
  takeProfit: { matchHash: PREVIEW.takeProfit.matchHash, priceInteger: PREVIEW.takeProfit.identity.priceInteger, triggerPriceInteger: PREVIEW.takeProfit.identity.triggerPriceInteger },
  clientOrderIndexPolicy: PREVIEW.stopLoss.identity.clientOrderIndexPolicy,
  providerVersion: PREVIEW.identity.providerVersion,
  credentialReference: { kind: "encrypted_vault_reference", environment: "rhc", accountIndex: 42, apiKeyIndex: 7, vaultCredentialId: "lighter/rhc/account-42/api-key-7" },
  nonceScope: { environment: "rhc", accountIndex: 42, apiKeyIndex: 7 },
};
const GROUP = buildLighterUnsignedOcoRequest(PLAN);

function row(preview: LighterOrderPreview): LighterOrderPreviewRow {
  return {
    previewId: preview.previewId, sessionId: "session-1", matchHash: preview.matchHash,
    environment: "rhc", accountIndex: 42, apiKeyIndex: 7, marketIndex: 0, side: "sell",
    baseAmountInteger: preview.identity.baseAmountInteger, priceInteger: preview.identity.priceInteger,
    orderType: preview.identity.orderType, timeInForce: preview.identity.timeInForce, reduceOnly: true,
    triggerPriceInteger: preview.identity.triggerPriceInteger, orderExpiryMs: EXPIRY,
    clientOrderIndexPolicy: preview.identity.clientOrderIndexPolicy,
    providerVersion: preview.identity.providerVersion, previewJson: { ...preview.preview },
    liveSourceJson: { source: "live_lighter_public_api" }, createdAt: new Date(NOW).toISOString(),
    expiresAt: preview.expiresAt,
  };
}

function active(index: 0 | 1) {
  return {
    order_index: index + 1, client_order_index: Number(GROUP.orders[index].clientOrderIndex),
    order_id: String(index + 1), client_order_id: GROUP.orders[index].clientOrderIndex,
    market_index: 0, owner_account_index: 42, initial_base_amount: PLAN.baseAmountInteger,
    remaining_base_amount: PLAN.baseAmountInteger, filled_base_amount: "0", filled_quote_amount: "0",
    price: GROUP.orders[index].price, status: "open",
  };
}

describe("approved Lighter native OCO execution", () => {
  it("revalidates both legs, submits exactly once, and proves both children before active", async () => {
    const sendTx = vi.fn(async () => ({ code: 200, tx_hash: TX_HASH, predicted_execution_time_ms: 1 }));
    const getActive = vi.fn()
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValueOnce({ code: 200, orders: [active(0), active(1)] });
    const dependencies: LighterOcoExecutionDeps = {
      secretReader: { readTradingApiPrivateKey: vi.fn(async () => `0x${"1".repeat(80)}`) },
      authSigner: { source: "official_lighter_signer", createAccountAuth: vi.fn(async (input) => ({
        kind: "lighter_account_auth_signer_result", environment: input.environment,
        accountIndex: input.accountIndex, apiKeyIndex: input.apiKeyIndex,
        deadlineUnixSeconds: input.deadlineUnixSeconds,
        authToken: `${input.deadlineUnixSeconds}:42:7:${"a".repeat(128)}`,
        publicKey: PUBLIC_KEY,
      })), signCreateOrder: vi.fn() },
      groupedSigner: { source: "official_lighter_signer", signCreateGroupedOrders: vi.fn(async (input) => ({
        kind: "lighter_create_grouped_orders_signer_result", environment: input.environment,
        accountIndex: input.accountIndex, apiKeyIndex: input.apiKeyIndex, nonce: input.nonce,
        clientOrderIndexes: [input.group.orders[0].clientOrderIndex, input.group.orders[1].clientOrderIndex],
        matchHash: input.group.matchHash, txType: 28, txInfo: "{\"signed\":true}", txHash: TX_HASH,
      })) },
      client: {
        getMarketDetails: vi.fn(async () => ({ code: 200, order_book_details: [MARKET], spot_order_book_details: [] })),
        getOrderBookOrders: vi.fn(async () => BOOK), getAccount: vi.fn(async () => ACCOUNT),
        getApiKeys: vi.fn(async () => ({ code: 200, api_keys: [{ account_index: 42, api_key_index: 7, nonce: 0, public_key: PUBLIC_KEY, transaction_time: 1 }] })),
        getNextNonce: vi.fn(async () => ({ code: 200, nonce: 0 })), sendTx,
        getAccountActiveOrders: getActive,
        getAccountInactiveOrders: vi.fn(async () => ({ code: 200, orders: [] })),
        getAccountTrades: vi.fn(async () => ({ code: 200, trades: [] })),
      },
      intents: {
        markPreSubmitRevalidated: vi.fn(async () => ({}) as never),
        attachNonceReservationWith: vi.fn(async () => ({}) as never),
        markSigned: vi.fn(async () => ({}) as never), markSubmitted: vi.fn(async () => ({}) as never),
        markApiAccepted: vi.fn(async () => ({}) as never), markSequencerPending: vi.fn(async () => ({}) as never),
        markProviderOutcome: vi.fn(async () => ({}) as never), markAmbiguous: vi.fn(async () => ({}) as never),
      },
      previews: { findFreshById: vi.fn(async (_session, _environment, id) => id === PREVIEW.stopLoss.previewId ? row(PREVIEW.stopLoss) : row(PREVIEW.takeProfit)) },
      nonceState: {
        recordExecutionObserved: vi.fn(async () => ({}) as never),
        reserveObservedWith: vi.fn(async () => ({ reservationId: `lighter-oco:${PLAN.intentId}`, reservedNonce: "0" }) as never),
      },
      transaction: vi.fn(async (fn) => fn({} as never)), now: () => NOW, wait: vi.fn(async () => undefined),
    };
    const result = await executeApprovedLighterOco({ plan: PLAN, group: GROUP, deps: dependencies });
    expect(result.status).toBe("active");
    expect(sendTx).toHaveBeenCalledTimes(1);
    expect(sendTx).toHaveBeenCalledWith("rhc", expect.objectContaining({ txType: 28 }));
  });
});
