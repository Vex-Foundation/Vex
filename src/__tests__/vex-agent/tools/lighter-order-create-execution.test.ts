import { describe, expect, it, vi } from "vitest";

import {
  configureLighterCreateOrderExecutionDeps,
  executeApprovedLighterCreateOrder,
  getConfiguredLighterCreateOrderExecutionDeps,
  type ExecuteApprovedLighterCreateOrderDeps,
} from "@vex-agent/tools/protocols/lighter/order-create-execution.js";
import type { LighterOrderReadyForSignerPlan } from "@vex-agent/tools/protocols/lighter/execution-plan.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import { buildLighterUnsignedCreateOrderRequest } from "@tools/lighter/signer-order.js";
import { buildLighterOrderPreview } from "@tools/lighter/order-preview.js";

const PRIVATE_KEY = `0x${"1".repeat(80)}`;
const TX_INFO = "{\"signed\":\"payload\"}";
const TX_HASH = "0xabc123";
const PUBLIC_KEY = "b".repeat(80);
const AUTH_TOKEN = `1893456600:42:7:${"a".repeat(128)}`;
const NOW = 1_893_456_000_000;
const ORDER_EXPIRY = NOW + 10 * 60 * 1_000;
const MARKET = {
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
const ORDER_BOOK = {
  code: 200,
  total_asks: 1,
  asks: [{
    order_index: 1,
    order_id: "1",
    owner_account_index: 8,
    initial_base_amount: "1",
    remaining_base_amount: "1",
    price: "3001.00",
    order_expiry: ORDER_EXPIRY,
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
    order_expiry: ORDER_EXPIRY,
    transaction_time: NOW,
  }],
};
const ACCOUNT = {
  code: 200,
  total: 1,
  accounts: [{
    index: 42,
    status: 1,
    collateral: "1000",
    available_balance: "900",
    positions: [],
  }],
};
const APPROVED_PREVIEW = buildLighterOrderPreview({
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
  orderExpiry: ORDER_EXPIRY,
  clientOrderIndexPolicy: "vex_assigned_uint48",
  nowMs: NOW,
}, { market: MARKET, orderBook: ORDER_BOOK, account: ACCOUNT });
const APPROVED_PREVIEW_ROW = {
  previewId: APPROVED_PREVIEW.previewId,
  sessionId: "session-1",
  matchHash: APPROVED_PREVIEW.matchHash,
  environment: "rhc" as const,
  accountIndex: 42,
  apiKeyIndex: 7,
  marketIndex: 0,
  side: "buy" as const,
  baseAmountInteger: APPROVED_PREVIEW.identity.baseAmountInteger,
  priceInteger: APPROVED_PREVIEW.identity.priceInteger,
  orderType: "limit" as const,
  timeInForce: "good-till-time" as const,
  reduceOnly: false,
  triggerPriceInteger: null,
  orderExpiryMs: ORDER_EXPIRY,
  clientOrderIndexPolicy: "vex_assigned_uint48",
  providerVersion: APPROVED_PREVIEW.identity.providerVersion,
  previewJson: { ...APPROVED_PREVIEW.preview },
  liveSourceJson: { source: "live_lighter_public_api" },
  createdAt: new Date(NOW).toISOString(),
  expiresAt: APPROVED_PREVIEW.expiresAt,
};

const PLAN: LighterOrderReadyForSignerPlan = {
  intentId: "lighter-exec-1",
  sessionId: "session-1",
  previewId: APPROVED_PREVIEW.previewId,
  matchHash: APPROVED_PREVIEW.matchHash,
  environment: "rhc",
  accountIndex: 42,
  apiKeyIndex: 7,
  marketIndex: 0,
  side: "buy",
  baseAmountInteger: "10000",
  priceInteger: "300000",
  orderType: "limit",
  timeInForce: "good-till-time",
  reduceOnly: false,
  triggerPriceInteger: null,
  orderExpiryMs: ORDER_EXPIRY,
  clientOrderIndexPolicy: "vex_assigned_uint48",
  providerVersion: APPROVED_PREVIEW.identity.providerVersion,
  credentialReference: {
    kind: "encrypted_vault_reference",
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    vaultCredentialId: "lighter/rhc/account-42/api-key-7",
  },
  nonceScope: {
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
  },
};
const APPROVED_INTENT_ROW: LighterOrderExecutionIntentRow = {
  intentId: PLAN.intentId,
  sessionId: PLAN.sessionId,
  previewId: PLAN.previewId,
  protocolExecutionId: null,
  approvalId: "approval-1",
  matchHash: PLAN.matchHash,
  environment: PLAN.environment,
  accountIndex: PLAN.accountIndex,
  apiKeyIndex: PLAN.apiKeyIndex,
  marketIndex: PLAN.marketIndex,
  side: PLAN.side,
  baseAmountInteger: PLAN.baseAmountInteger,
  priceInteger: PLAN.priceInteger,
  orderType: PLAN.orderType,
  timeInForce: PLAN.timeInForce,
  reduceOnly: PLAN.reduceOnly,
  triggerPriceInteger: PLAN.triggerPriceInteger,
  orderExpiryMs: PLAN.orderExpiryMs,
  clientOrderIndexPolicy: PLAN.clientOrderIndexPolicy,
  providerVersion: PLAN.providerVersion,
  credentialRefJson: PLAN.credentialReference,
  approvalStatus: "approved",
  executionState: "approval_pending",
  decisionReason: "user approved exact Lighter order create intent",
  decidedAt: new Date(NOW).toISOString(),
  nonceReservationId: null,
  nonceValue: null,
  clientOrderIndex: null,
  signerTxHash: null,
  submittedTxHash: null,
  submitCode: null,
  submitMessage: null,
  predictedExecutionTimeMs: null,
  volumeQuotaRemaining: null,
  ambiguousReason: null,
  signedAt: null,
  submittedAt: null,
  apiAcceptedAt: null,
  ambiguousAt: null,
  providerOrderId: null,
  providerOrderStatus: null,
  providerOutcomeSource: null,
  providerOutcomeJson: null,
  providerOutcomeCheckedAt: null,
  preSubmitRevalidationJson: null,
  preSubmitRevalidatedAt: null,
  createdAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  expiresAt: APPROVED_PREVIEW.expiresAt,
};

function first<T>(values: readonly T[]): T {
  const value = values.at(0);
  if (value === undefined) throw new Error("test fixture must not be empty");
  return value;
}

const UNSIGNED_ORDER = buildLighterUnsignedCreateOrderRequest(PLAN);

function accountOrder(overrides: Record<string, unknown> = {}) {
  return {
    order_index: 123,
    client_order_index: Number(UNSIGNED_ORDER.clientOrderIndex),
    order_id: "123",
    client_order_id: UNSIGNED_ORDER.clientOrderIndex,
    market_index: PLAN.marketIndex,
    owner_account_index: PLAN.accountIndex,
    initial_base_amount: PLAN.baseAmountInteger,
    remaining_base_amount: PLAN.baseAmountInteger,
    filled_base_amount: "0",
    filled_quote_amount: "0",
    price: PLAN.priceInteger,
    status: "open",
    ...overrides,
  };
}

function deps(overrides: Partial<ExecuteApprovedLighterCreateOrderDeps> = {}): ExecuteApprovedLighterCreateOrderDeps {
  return {
    liveTradingEnabled: vi.fn(() => true),
    secretReader: {
      readTradingApiPrivateKey: vi.fn(async () => PRIVATE_KEY),
    },
    reserveNonce: vi.fn<ExecuteApprovedLighterCreateOrderDeps["reserveNonce"]>(async () => ({
      kind: "lighter_order_nonce_reservation",
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      reservationId: `lighter-order:${PLAN.intentId}`,
      nonceValue: "0",
      environment: PLAN.environment,
      accountIndex: PLAN.accountIndex,
      apiKeyIndex: PLAN.apiKeyIndex,
    })),
    signer: {
      source: "official_lighter_signer",
      createAccountAuth: vi.fn<ExecuteApprovedLighterCreateOrderDeps["signer"]["createAccountAuth"]>(async (input) => ({
        kind: "lighter_account_auth_signer_result",
        environment: input.environment,
        accountIndex: input.accountIndex,
        apiKeyIndex: input.apiKeyIndex,
        deadlineUnixSeconds: input.deadlineUnixSeconds,
        authToken: AUTH_TOKEN,
        publicKey: PUBLIC_KEY,
      })),
      signCreateOrder: vi.fn<ExecuteApprovedLighterCreateOrderDeps["signer"]["signCreateOrder"]>(async (input) => ({
        kind: "lighter_create_order_signer_result",
        environment: input.environment,
        accountIndex: input.accountIndex,
        apiKeyIndex: input.apiKeyIndex,
        nonce: input.nonce,
        clientOrderIndex: input.order.clientOrderIndex,
        matchHash: input.order.matchHash,
        txType: 14,
        txInfo: TX_INFO,
        txHash: TX_HASH,
      })),
    },
    client: {
      getMarketDetails: vi.fn(async () => ({
        code: 200,
        order_book_details: [MARKET],
        spot_order_book_details: [],
      })),
      getOrderBookOrders: vi.fn(async () => ORDER_BOOK),
      getAccount: vi.fn(async () => ACCOUNT),
      getApiKeys: vi.fn(async () => ({
        code: 200,
        api_keys: [{
          account_index: PLAN.accountIndex,
          api_key_index: PLAN.apiKeyIndex,
          nonce: 0,
          public_key: PUBLIC_KEY,
          transaction_time: 1_784_732_516_903_382,
        }],
      })),
      getNextNonce: vi.fn(async () => ({ code: 200, nonce: 0 })),
      sendTx: vi.fn(async () => ({
        code: 200,
        message: "ok",
        tx_hash: TX_HASH,
        predicted_execution_time_ms: 250,
        volume_quota_remaining: 99,
      })),
      getAccountActiveOrders: vi.fn(async () => ({
        code: 200,
        orders: [],
      })),
      getAccountInactiveOrders: vi.fn(async () => ({
        code: 200,
        orders: [],
      })),
      getAccountTrades: vi.fn(async () => ({
        code: 200,
        trades: [],
      })),
    },
    nonceState: {
      recordExecutionObserved: vi.fn(async () => ({ status: "observed" }) as never),
    },
    previews: {
      findFreshById: vi.fn(async () => APPROVED_PREVIEW_ROW),
    },
    now: vi.fn(() => NOW),
    wait: vi.fn(async () => undefined),
    intents: {
      markPreSubmitRevalidated: vi.fn(async () => APPROVED_INTENT_ROW),
      markSigned: vi.fn(async () => ({ ok: true }) as never),
      markSubmitted: vi.fn(async () => ({ ok: true }) as never),
      markApiAccepted: vi.fn(async () => ({
        executionState: "api_accepted",
        volumeQuotaRemaining: "99",
      }) as never),
      markSequencerPending: vi.fn(async () => ({
        executionState: "sequencer_pending",
      }) as never),
      markProviderOutcome: vi.fn(async (input) => ({
        executionState: input.state,
        providerOutcomeSource: input.source,
      }) as never),
      markAmbiguous: vi.fn(async () => ({ executionState: "ambiguous" }) as never),
    },
    ...overrides,
  };
}

describe("Lighter approved create execution pipeline", () => {
  it("configures and clears the privileged dependency registry", () => {
    const d = deps();
    const teardown = configureLighterCreateOrderExecutionDeps(d);

    expect(getConfiguredLighterCreateOrderExecutionDeps()).toBe(d);

    teardown();
    expect(getConfiguredLighterCreateOrderExecutionDeps()).toBeNull();
  });

  it("blocks at the release gate before reading key material or reserving a nonce", async () => {
    const d = deps({ liveTradingEnabled: vi.fn(() => false) });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("live trading is disabled");

    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.signer.signCreateOrder).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("blocks an unavailable approved preview before provider credential or vault access", async () => {
    const d = deps({
      previews: { findFreshById: vi.fn(async () => null) },
    });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("no longer fresh or available");

    expect(d.client.getApiKeys).not.toHaveBeenCalled();
    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("blocks changed live price behavior before provider credential or vault access", async () => {
    const d = deps({
      client: {
        ...deps().client,
        getOrderBookOrders: vi.fn(async () => ({
          ...ORDER_BOOK,
          asks: [{ ...first(ORDER_BOOK.asks), price: "2999.00" }],
        })),
      },
    });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("changed between resting and taker behavior");

    expect(d.client.getApiKeys).not.toHaveBeenCalled();
    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.intents.markPreSubmitRevalidated).not.toHaveBeenCalled();
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("blocks when safe revalidation evidence cannot persist before vault access", async () => {
    const d = deps({
      intents: {
        ...deps().intents,
        markPreSubmitRevalidated: vi.fn(async () => null),
      },
    });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("evidence could not be persisted");

    expect(d.client.getApiKeys).not.toHaveBeenCalled();
    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("blocks before key material when live key identity or next nonce is unavailable", async () => {
    const d = deps({
      client: {
        ...deps().client,
        getNextNonce: vi.fn(async () => {
          throw new Error("next nonce unavailable");
        }),
      },
    });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("next nonce is unavailable");

    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.signer.signCreateOrder).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("blocks before nonce reservation when canonical account reads are unavailable", async () => {
    const d = deps({
      client: {
        ...deps().client,
        getAccountActiveOrders: vi.fn(async () => {
          throw new Error("canonical auth unavailable");
        }),
      },
    });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("provider outcome repair is unavailable");

    expect(d.secretReader.readTradingApiPrivateKey).toHaveBeenCalled();
    expect(d.signer.createAccountAuth).toHaveBeenCalled();
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.signer.signCreateOrder).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("blocks before nonce reservation when the client order id already has inactive evidence", async () => {
    const d = deps({
      client: {
        ...deps().client,
        getAccountInactiveOrders: vi.fn(async () => ({
          code: 200,
          orders: [accountOrder({ status: "filled" })],
        })),
      },
    });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("same Vex client order id");

    expect(d.nonceState.recordExecutionObserved).not.toHaveBeenCalled();
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.signer.signCreateOrder).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("blocks a vault key that does not match the live registered public key", async () => {
    const d = deps({
      signer: {
        ...deps().signer,
        createAccountAuth: vi.fn<ExecuteApprovedLighterCreateOrderDeps["signer"]["createAccountAuth"]>(async (input) => ({
          kind: "lighter_account_auth_signer_result",
          environment: input.environment,
          accountIndex: input.accountIndex,
          apiKeyIndex: input.apiKeyIndex,
          deadlineUnixSeconds: input.deadlineUnixSeconds,
          authToken: AUTH_TOKEN,
          publicKey: "c".repeat(80),
        })),
      },
    });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("does not match the public key");

    expect(d.nonceState.recordExecutionObserved).not.toHaveBeenCalled();
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("signs with the privileged reader, submits once, and stores sequencer-pending repair evidence", async () => {
    const d = deps();

    const result = await executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    });

    expect(d.previews.findFreshById).toHaveBeenCalledWith(
      PLAN.sessionId,
      PLAN.environment,
      PLAN.previewId,
    );
    expect(d.intents.markPreSubmitRevalidated).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      evidence: expect.objectContaining({
        kind: "lighter_order_pre_submit_revalidation",
        previewId: PLAN.previewId,
        matchHash: PLAN.matchHash,
        priceComparison: "resting",
      }),
    });
    expect(d.secretReader.readTradingApiPrivateKey).toHaveBeenCalledWith(PLAN.credentialReference);
    expect(d.reserveNonce).toHaveBeenCalledWith(PLAN);
    expect(d.signer.signCreateOrder).toHaveBeenCalledWith(expect.objectContaining({
      nonce: "0",
      order: expect.objectContaining({
        matchHash: PLAN.matchHash,
      }),
    }));
    expect(d.intents.markSigned).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      nonceReservationId: `lighter-order:${PLAN.intentId}`,
      nonceValue: "0",
      clientOrderIndex: UNSIGNED_ORDER.clientOrderIndex,
      signerTxHash: TX_HASH,
    });
    expect(d.intents.markSubmitted).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      signerTxHash: TX_HASH,
    });
    expect(d.client.sendTx).toHaveBeenCalledWith("rhc", {
      txType: 14,
      txInfo: TX_INFO,
    });
    expect(d.intents.markApiAccepted).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      signerTxHash: TX_HASH,
      submittedTxHash: TX_HASH,
      submitCode: 200,
      submitMessage: "ok",
      predictedExecutionTimeMs: 250,
      volumeQuotaRemaining: 99,
    });
    expect(d.intents.markSequencerPending).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      signerTxHash: TX_HASH,
      submittedTxHash: TX_HASH,
    });
    expect(d.client.getAccountActiveOrders).toHaveBeenCalledTimes(4);
    expect(d.wait).toHaveBeenCalledTimes(2);
    expect(d.client.getAccountInactiveOrders).toHaveBeenCalledWith(
      "rhc",
      {
        accountIndex: PLAN.accountIndex,
        marketId: PLAN.marketIndex,
        marketType: "all",
        limit: 100,
      },
      { token: AUTH_TOKEN, accountIndex: PLAN.accountIndex },
    );
    expect(d.client.getAccountTrades).toHaveBeenCalledWith(
      "rhc",
      {
        accountIndex: PLAN.accountIndex,
        limit: 100,
        sortBy: "timestamp",
      },
      { token: AUTH_TOKEN, accountIndex: PLAN.accountIndex },
    );
    expect(d.intents.markProviderOutcome).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      state: "sequencer_pending",
      source: "not_found",
      providerOrderId: null,
      providerOrderStatus: null,
      providerOutcomeJson: {
        source: "not_found",
        clientOrderIndex: UNSIGNED_ORDER.clientOrderIndex,
        checkedEndpoints: ["accountActiveOrders", "accountInactiveOrders", "trades"],
      },
    });
    expect(result).toMatchObject({
      status: "sequencer_pending",
      executionState: "sequencer_pending",
      signerTxHash: TX_HASH,
      submittedTxHash: TX_HASH,
      clientOrderIndex: UNSIGNED_ORDER.clientOrderIndex,
      evidenceSource: "not_found",
    });
    expect(JSON.stringify(result)).not.toContain(TX_INFO);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
    expect(JSON.stringify(result)).not.toContain(AUTH_TOKEN);
  });

  it("records active provider order evidence when the submitted client order is visible", async () => {
    const d = deps({
      client: {
        ...deps().client,
        getAccountActiveOrders: vi
          .fn()
          .mockResolvedValueOnce({ code: 200, orders: [] })
          .mockResolvedValueOnce({ code: 200, orders: [accountOrder()] }),
      },
    });

    const result = await executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    });

    expect(d.intents.markProviderOutcome).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      state: "open",
      source: "active_order",
      providerOrderId: "123",
      providerOrderStatus: "open",
      providerOutcomeJson: expect.objectContaining({
        source: "active_order",
        clientOrderIndex: UNSIGNED_ORDER.clientOrderIndex,
        orderId: "123",
      }),
    });
    expect(d.client.getAccountInactiveOrders).toHaveBeenCalledTimes(1);
    expect(d.client.getAccountTrades).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "provider_confirmed",
      executionState: "open",
      evidenceSource: "active_order",
      providerOrderId: "123",
    });
    expect(JSON.stringify(result)).not.toContain(TX_INFO);
  });

  it("marks provider evidence persistence failures ambiguous after API acceptance", async () => {
    const d = deps({
      client: {
        ...deps().client,
        getAccountActiveOrders: vi
          .fn()
          .mockResolvedValueOnce({ code: 200, orders: [] })
          .mockResolvedValueOnce({ code: 200, orders: [accountOrder()] }),
      },
      intents: {
        ...deps().intents,
        markProviderOutcome: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
      },
    });

    const result = await executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    });

    expect(result).toMatchObject({
      status: "ambiguous",
      reason: "provider_outcome_persist_failed",
      signerTxHash: TX_HASH,
    });
    expect(d.intents.markAmbiguous).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      reason: "provider_outcome_persist_failed",
    });
    expect(d.client.sendTx).toHaveBeenCalledTimes(1);
  });

  it("marks send-time uncertainty ambiguous without exposing signed payloads", async () => {
    const d = deps({
      client: {
        ...deps().client,
        sendTx: vi.fn(async () => {
          throw new Error(`provider echoed ${TX_INFO}`);
        }),
      },
    });

    const result = await executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    });

    expect(result).toMatchObject({
      status: "ambiguous",
      reason: "sendtx_failed_after_submit_attempt",
      signerTxHash: TX_HASH,
    });
    expect(d.intents.markAmbiguous).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      reason: "sendtx_failed_after_submit_attempt",
    });
    expect(d.intents.markApiAccepted).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(TX_INFO);
  });

  it("marks a signer failure after nonce reservation ambiguous and never submits", async () => {
    const d = deps({
      signer: {
        ...deps().signer,
        signCreateOrder: vi.fn(async () => {
          throw new Error("signer unavailable");
        }),
      },
    });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("signer unavailable");

    expect(d.intents.markAmbiguous).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      reason: "signing_failed_after_nonce_reservation",
    });
    expect(d.intents.markSigned).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("does not submit when signed-state persistence fails after nonce reservation", async () => {
    const d = deps({
      intents: {
        ...deps().intents,
        markSigned: vi.fn(async () => null),
      },
    });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("could not persist signed state");

    expect(d.intents.markAmbiguous).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      reason: "signed_state_persist_failed",
    });
    expect(d.intents.markSubmitted).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("marks a provider hash mismatch ambiguous after submission", async () => {
    const d = deps({
      client: {
        ...deps().client,
        sendTx: vi.fn(async () => ({
          code: 200,
          message: "ok",
          tx_hash: "0xdifferent",
          predicted_execution_time_ms: 250,
        })),
      },
    });

    const result = await executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    });

    expect(result).toMatchObject({
      status: "ambiguous",
      reason: "provider_tx_hash_mismatch",
    });
    expect(d.intents.markAmbiguous).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      reason: "provider_tx_hash_mismatch",
    });
    expect(d.intents.markApiAccepted).not.toHaveBeenCalled();
  });

  it("marks provider outcome read failures ambiguous after API acceptance without echoing provider text", async () => {
    const d = deps({
      client: {
        ...deps().client,
        getAccountActiveOrders: vi
          .fn()
          .mockResolvedValueOnce({ code: 200, orders: [] })
          .mockRejectedValueOnce(new Error(`provider echoed ${TX_INFO}`)),
      },
    });

    const result = await executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    });

    expect(result).toMatchObject({
      status: "ambiguous",
      reason: "provider_outcome_read_failed",
      signerTxHash: TX_HASH,
    });
    expect(d.intents.markAmbiguous).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      reason: "provider_outcome_read_failed",
    });
    expect(JSON.stringify(result)).not.toContain(TX_INFO);
  });
});
