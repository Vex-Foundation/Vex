import { describe, expect, it, vi } from "vitest";

import {
  configureLighterCreateOrderExecutionDeps,
  executeApprovedLighterCreateOrder,
  getConfiguredLighterCreateOrderExecutionDeps,
  type ExecuteApprovedLighterCreateOrderDeps,
} from "@vex-agent/tools/protocols/lighter/order-create-execution.js";
import type { LighterOrderReadyForSignerPlan } from "@vex-agent/tools/protocols/lighter/execution-plan.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
import { buildLighterUnsignedCreateOrderRequest } from "@tools/lighter/signer-order.js";
import { buildLighterOrderPreview } from "@tools/lighter/order-preview.js";
import type { LighterAccountResponse, LighterMarketDetail } from "@tools/lighter/types.js";
import { ErrorCodes, VexError } from "../../../errors.js";

const PRIVATE_KEY = `0x${"1".repeat(80)}`;
const TX_INFO = "{\"signed\":\"payload\"}";
const TX_HASH = "0xabc123";
const PROVIDER_SUBMIT_MESSAGE =
  '{"status":"accepted","detail":"queued by Lighter"}';
const PUBLIC_KEY = "b".repeat(80);
const AUTH_TOKEN = `1893456600:42:7:${"a".repeat(128)}`;
const NOW = 1_893_456_000_000;
const ORDER_EXPIRY = NOW + 10 * 60 * 1_000;
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
const ACCOUNT: LighterAccountResponse = {
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
  price: "3002",
  orderType: "market",
  timeInForce: "immediate-or-cancel",
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
  orderType: "market" as const,
  timeInForce: "immediate-or-cancel" as const,
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
  priceInteger: "300200",
  orderType: "market",
  timeInForce: "immediate-or-cancel",
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

function createGate(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const UNSIGNED_ORDER = buildLighterUnsignedCreateOrderRequest(PLAN);

const FORGED_UNSIGNED_ORDER_CASES: readonly {
  readonly label: string;
  readonly field: keyof typeof UNSIGNED_ORDER;
  readonly forge: (order: typeof UNSIGNED_ORDER) => typeof UNSIGNED_ORDER;
}[] = [
  {
    label: "environment scope",
    field: "environment",
    forge: (order) => ({ ...order, environment: "core" }),
  },
  {
    label: "account scope",
    field: "accountIndex",
    forge: (order) => ({ ...order, accountIndex: order.accountIndex + 1 }),
  },
  {
    label: "API-key scope",
    field: "apiKeyIndex",
    forge: (order) => ({ ...order, apiKeyIndex: order.apiKeyIndex + 1 }),
  },
  {
    label: "market scope",
    field: "marketIndex",
    forge: (order) => ({ ...order, marketIndex: order.marketIndex + 1 }),
  },
  {
    label: "amount",
    field: "baseAmountInteger",
    forge: (order) => ({ ...order, baseAmountInteger: "20000" }),
  },
  {
    label: "price",
    field: "priceInteger",
    forge: (order) => ({ ...order, priceInteger: "300300" }),
  },
  {
    label: "side",
    field: "isAsk",
    forge: (order) => ({ ...order, isAsk: !order.isAsk }),
  },
  {
    label: "order type",
    field: "orderTypeCode",
    forge: (order) => ({ ...order, orderTypeCode: 0 }),
  },
  {
    label: "time in force",
    field: "timeInForceCode",
    forge: (order) => ({ ...order, timeInForceCode: 1 }),
  },
  {
    label: "reduce-only flag",
    field: "reduceOnly",
    forge: (order) => ({ ...order, reduceOnly: !order.reduceOnly }),
  },
  {
    label: "trigger",
    field: "triggerPriceInteger",
    forge: (order) => ({ ...order, triggerPriceInteger: "290000" }),
  },
  {
    label: "wire expiry",
    field: "orderExpiryMs",
    forge: (order) => ({ ...order, orderExpiryMs: ORDER_EXPIRY }),
  },
  {
    label: "approval hash",
    field: "matchHash",
    forge: (order) => ({ ...order, matchHash: "f".repeat(64) }),
  },
  {
    label: "client order id",
    field: "clientOrderIndex",
    forge: (order) => ({ ...order, clientOrderIndex: "999" }),
  },
];

function accountOrder(overrides: Record<string, unknown> = {}) {
  return {
    order_index: 123,
    client_order_index: Number(UNSIGNED_ORDER.clientOrderIndex),
    order_id: "123",
    client_order_id: UNSIGNED_ORDER.clientOrderIndex,
    market_index: PLAN.marketIndex,
    owner_account_index: PLAN.accountIndex,
    initial_base_amount: APPROVED_PREVIEW.preview.baseAmount.display,
    remaining_base_amount: APPROVED_PREVIEW.preview.baseAmount.display,
    filled_base_amount: "0",
    filled_quote_amount: "0",
    price: APPROVED_PREVIEW.preview.price.display,
    status: "open",
    ...overrides,
  };
}

function deps(overrides: Partial<ExecuteApprovedLighterCreateOrderDeps> = {}): ExecuteApprovedLighterCreateOrderDeps {
  return {
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
        message: PROVIDER_SUBMIT_MESSAGE,
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
      findByIntentIdAnySession: vi.fn(async () => null),
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

function restingLimitFixture(): {
  readonly plan: LighterOrderReadyForSignerPlan;
  readonly previewRow: LighterOrderPreviewRow;
} {
  const preview = buildLighterOrderPreview({
    sessionId: PLAN.sessionId,
    environment: PLAN.environment,
    accountIndex: PLAN.accountIndex,
    apiKeyIndex: PLAN.apiKeyIndex,
    marketId: PLAN.marketIndex,
    side: "buy",
    baseAmount: "1",
    price: "2998",
    orderType: "limit",
    timeInForce: "good-till-time",
    reduceOnly: false,
    orderExpiry: ORDER_EXPIRY,
    clientOrderIndexPolicy: PLAN.clientOrderIndexPolicy,
    nowMs: NOW,
  }, { market: MARKET, orderBook: ORDER_BOOK, account: ACCOUNT });
  return {
    plan: {
      ...PLAN,
      previewId: preview.previewId,
      matchHash: preview.matchHash,
      priceInteger: preview.identity.priceInteger,
      orderType: "limit",
      timeInForce: "good-till-time",
    },
    previewRow: {
      ...APPROVED_PREVIEW_ROW,
      previewId: preview.previewId,
      matchHash: preview.matchHash,
      priceInteger: preview.identity.priceInteger,
      orderType: "limit",
      timeInForce: "good-till-time",
      previewJson: { ...preview.preview },
      expiresAt: preview.expiresAt,
    },
  };
}

describe("Lighter approved create execution pipeline", () => {
  it("rejects an injected collector or fee before any provider, vault, or nonce access", async () => {
    const d = deps();
    await expect(executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: { ...UNSIGNED_ORDER, integratorFees: { integratorAccountIndex: 99, integratorMakerFee: 1000, integratorTakerFee: 1000 } }, deps: d })).rejects.toThrow("field integratorFees");
    expect(d.previews.findFreshById).not.toHaveBeenCalled();
    expect(d.client.getAccount).not.toHaveBeenCalled();
    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.reserveNonce).not.toHaveBeenCalled();
  });

  it("configures and clears the privileged dependency registry", () => {
    const d = deps();
    const teardown = configureLighterCreateOrderExecutionDeps(d);

    expect(getConfiguredLighterCreateOrderExecutionDeps()).toBe(d);

    teardown();
    expect(getConfiguredLighterCreateOrderExecutionDeps()).toBeNull();
  });

  it.each(FORGED_UNSIGNED_ORDER_CASES)(
    "rejects forged caller-supplied $label before provider, secret, or nonce access",
    async ({ field, forge }) => {
      const d = deps();

      await expect(executeApprovedLighterCreateOrder({
        plan: PLAN,
        unsignedOrder: forge(UNSIGNED_ORDER),
        deps: d,
      })).rejects.toThrow(`field ${field} does not match the canonical order`);

      expect(d.previews.findFreshById).not.toHaveBeenCalled();
      expect(d.client.getMarketDetails).not.toHaveBeenCalled();
      expect(d.client.getOrderBookOrders).not.toHaveBeenCalled();
      expect(d.client.getAccount).not.toHaveBeenCalled();
      expect(d.client.getApiKeys).not.toHaveBeenCalled();
      expect(d.client.getNextNonce).not.toHaveBeenCalled();
      expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
      expect(d.nonceState.recordExecutionObserved).not.toHaveBeenCalled();
      expect(d.reserveNonce).not.toHaveBeenCalled();
      expect(d.signer.createAccountAuth).not.toHaveBeenCalled();
      expect(d.signer.signCreateOrder).not.toHaveBeenCalled();
      expect(d.client.sendTx).not.toHaveBeenCalled();
    },
  );

  it("derives and signs the canonical wire order when production omits a caller order", async () => {
    const d = deps();

    await executeApprovedLighterCreateOrder({
      plan: PLAN,
      deps: d,
    });

    expect(d.signer.signCreateOrder).toHaveBeenCalledWith(expect.objectContaining({
      order: UNSIGNED_ORDER,
    }));
  });

  it("rechecks a non-nil expiry after provider/auth work and refuses before nonce reservation", async () => {
    const fixture = restingLimitFixture();
    const now = vi.fn()
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(NOW + 5 * 60 * 1_000 + 1);
    const d = deps({
      previews: { findFreshById: vi.fn(async () => fixture.previewRow) },
      now,
    });

    await expect(executeApprovedLighterCreateOrder({
      plan: fixture.plan,
      deps: d,
    })).rejects.toThrow("fell below the provider's five-minute minimum");

    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.signer.signCreateOrder).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("never submits when a non-nil expiry crosses the minimum during signing", async () => {
    const fixture = restingLimitFixture();
    const now = vi.fn()
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(NOW + 5 * 60 * 1_000 + 1);
    const d = deps({
      previews: { findFreshById: vi.fn(async () => fixture.previewRow) },
      now,
    });

    await expect(executeApprovedLighterCreateOrder({
      plan: fixture.plan,
      deps: d,
    })).rejects.toThrow("fell below the provider's five-minute expiry minimum before submission");

    expect(d.reserveNonce).toHaveBeenCalledOnce();
    expect(d.signer.signCreateOrder).toHaveBeenCalledOnce();
    expect(d.intents.markSigned).toHaveBeenCalledOnce();
    expect(d.intents.markSubmitted).not.toHaveBeenCalled();
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

  it("blocks unsupported order tuples at the privileged boundary", async () => {
    const d = deps();

    await expect(executeApprovedLighterCreateOrder({
      plan: {
        ...PLAN,
        orderType: "market",
        timeInForce: "post-only",
      },
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("Unsupported Lighter order type and time-in-force combination");

    expect(d.previews.findFreshById).not.toHaveBeenCalled();
    expect(d.client.getApiKeys).not.toHaveBeenCalled();
    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("refuses RHC provider-reserved index 157 before revalidation, vault, or nonce work", async () => {
    const reservedPlan: LighterOrderReadyForSignerPlan = {
      ...PLAN,
      apiKeyIndex: 157,
      credentialReference: {
        ...PLAN.credentialReference,
        apiKeyIndex: 157,
        vaultCredentialId: "lighter/rhc/account-42/api-key-157",
      },
      nonceScope: {
        ...PLAN.nonceScope,
        apiKeyIndex: 157,
      },
    };
    const d = deps();

    await expect(executeApprovedLighterCreateOrder({
      plan: reservedPlan,
      unsignedOrder: buildLighterUnsignedCreateOrderRequest(reservedPlan),
      deps: d,
    })).rejects.toThrow("reserved by the Lighter RHC provider");

    expect(d.previews.findFreshById).not.toHaveBeenCalled();
    expect(d.client.getApiKeys).not.toHaveBeenCalled();
    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.nonceState.recordExecutionObserved).not.toHaveBeenCalled();
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.signer.signCreateOrder).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("blocks a live price beyond the approved market-order worst price before vault access", async () => {
    const d = deps({
      client: {
        ...deps().client,
        getOrderBookOrders: vi.fn(async () => ({
          ...ORDER_BOOK,
          asks: [{ ...first(ORDER_BOOK.asks), price: "3002.01" }],
        })),
      },
    });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("moved beyond the approved market-order worst price");

    expect(d.client.getApiKeys).not.toHaveBeenCalled();
    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.intents.markPreSubmitRevalidated).not.toHaveBeenCalled();
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("revalidates a spot market from the provider spot-detail array", async () => {
    const spotMarket: LighterMarketDetail = {
      ...MARKET,
      symbol: "ETH/USDC",
      market_id: 2048,
      market_type: "spot",
      base_asset_id: 1,
      quote_asset_id: 3,
    };
    const spotAccount: LighterAccountResponse = {
      ...ACCOUNT,
      accounts: [{
        ...ACCOUNT.accounts[0],
        assets: [{
          symbol: "USDC",
          asset_id: 3,
          balance: "5000.000000",
          locked_balance: "0.000000",
          margin_balance: "5000.000000",
          margin_mode: "enabled",
          multiplier: "1.000000000000000000",
        }],
      }],
    };
    const spotPreview = buildLighterOrderPreview({
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      accountIndex: PLAN.accountIndex,
      apiKeyIndex: PLAN.apiKeyIndex,
      marketId: 2048,
      side: PLAN.side,
      baseAmount: "1",
      price: "3002",
      orderType: PLAN.orderType,
      timeInForce: PLAN.timeInForce,
      reduceOnly: false,
      orderExpiry: PLAN.orderExpiryMs,
      clientOrderIndexPolicy: PLAN.clientOrderIndexPolicy,
      nowMs: NOW,
    }, { market: spotMarket, orderBook: ORDER_BOOK, account: spotAccount });
    const spotPlan = {
      ...PLAN,
      previewId: spotPreview.previewId,
      matchHash: spotPreview.matchHash,
      marketIndex: 2048,
      baseAmountInteger: spotPreview.identity.baseAmountInteger,
      priceInteger: spotPreview.identity.priceInteger,
    };
    const spotPreviewRow = {
      ...APPROVED_PREVIEW_ROW,
      previewId: spotPlan.previewId,
      matchHash: spotPlan.matchHash,
      marketIndex: spotPlan.marketIndex,
      baseAmountInteger: spotPlan.baseAmountInteger,
      priceInteger: spotPlan.priceInteger,
      previewJson: { ...spotPreview.preview },
    };
    const base = deps();
    const d = deps({
      client: {
        ...base.client,
        getMarketDetails: vi.fn(async () => ({
          code: 200,
          order_book_details: [],
          spot_order_book_details: [spotMarket],
        })),
        getAccount: vi.fn(async () => spotAccount),
      },
      previews: { findFreshById: vi.fn(async () => spotPreviewRow) },
      intents: {
        ...base.intents,
        markPreSubmitRevalidated: vi.fn(async () => ({
          ...APPROVED_INTENT_ROW,
          previewId: spotPlan.previewId,
          matchHash: spotPlan.matchHash,
          marketIndex: spotPlan.marketIndex,
          baseAmountInteger: spotPlan.baseAmountInteger,
          priceInteger: spotPlan.priceInteger,
        })),
      },
    });

    const result = await executeApprovedLighterCreateOrder({
      plan: spotPlan,
      unsignedOrder: buildLighterUnsignedCreateOrderRequest(spotPlan),
      deps: d,
    });

    expect(d.client.getMarketDetails).toHaveBeenCalledWith("rhc", {
      marketId: spotPlan.marketIndex,
      filter: "all",
    }, { fresh: true });
    expect(d.client.getOrderBookOrders).toHaveBeenCalledWith("rhc", {
      marketId: spotPlan.marketIndex,
      limit: 250,
    }, { fresh: true });
    expect(d.client.getAccount).toHaveBeenCalledWith("rhc", {
      by: "index",
      value: spotPlan.accountIndex,
    }, { fresh: true });
    expect(d.client.getApiKeys).toHaveBeenCalledWith("rhc", {
      accountIndex: spotPlan.accountIndex,
      apiKeyIndex: spotPlan.apiKeyIndex,
    }, { fresh: true });
    expect(d.client.getNextNonce).toHaveBeenCalledWith("rhc", {
      accountIndex: spotPlan.accountIndex,
      apiKeyIndex: spotPlan.apiKeyIndex,
    }, { fresh: true });
    expect(d.intents.markPreSubmitRevalidated).toHaveBeenCalled();
    expect(d.client.sendTx).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("sequencer_pending");
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

  it("blocks before vault access when live key identity or next nonce is unavailable", async () => {
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

  it("finishes provider credential reads before loading the trading key", async () => {
    const revalidationGate = createGate();
    const credentialGate = createGate();
    const base = deps();
    const markPreSubmitRevalidated = vi.fn(async () => {
      await revalidationGate.promise;
      return APPROVED_INTENT_ROW;
    });
    const getApiKeys = vi.fn(async () => {
      await credentialGate.promise;
      return {
        code: 200,
        api_keys: [{
          account_index: PLAN.accountIndex,
          api_key_index: PLAN.apiKeyIndex,
          nonce: 0,
          public_key: PUBLIC_KEY,
          transaction_time: 1_784_732_516_903_382,
        }],
      };
    });
    const readTradingApiPrivateKey = vi.fn(async () => PRIVATE_KEY);
    const d = deps({
      secretReader: { readTradingApiPrivateKey },
      client: {
        ...base.client,
        getApiKeys,
      },
      intents: {
        ...base.intents,
        markPreSubmitRevalidated,
      },
    });

    const execution = executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    });

    await vi.waitFor(() => expect(markPreSubmitRevalidated).toHaveBeenCalledTimes(1));
    expect(getApiKeys).not.toHaveBeenCalled();
    expect(readTradingApiPrivateKey).not.toHaveBeenCalled();

    revalidationGate.release();
    await vi.waitFor(() => expect(getApiKeys).toHaveBeenCalledTimes(1));
    expect(readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.signer.createAccountAuth).not.toHaveBeenCalled();

    credentialGate.release();
    await vi.waitFor(() => expect(readTradingApiPrivateKey).toHaveBeenCalledTimes(1));
    const result = await execution;

    expect(d.signer.createAccountAuth).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("sequencer_pending");
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
          orders: [accountOrder({ status: "filled", filled_base_amount: "1", remaining_base_amount: "0" })],
        })),
      },
    });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("same Vex client order id");

    expect(d.nonceState.recordExecutionObserved).toHaveBeenCalledTimes(1);
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.signer.signCreateOrder).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("overlaps duplicate-evidence readiness with nonce observation and gates reservation on both", async () => {
    const repairReadGate = createGate();
    const observedNonceGate = createGate();
    const base = deps();
    let activeOrdersCallCount = 0;
    const getAccountActiveOrders = vi.fn(async () => {
      activeOrdersCallCount += 1;
      if (activeOrdersCallCount === 1) await repairReadGate.promise;
      return { code: 200, orders: [] };
    });
    const recordExecutionObserved = vi.fn<
      ExecuteApprovedLighterCreateOrderDeps["nonceState"]["recordExecutionObserved"]
    >(async () => {
      await observedNonceGate.promise;
      return { status: "observed" } as never;
    });
    const d = deps({
      client: {
        ...base.client,
        getAccountActiveOrders,
      },
      nonceState: { recordExecutionObserved },
    });

    const execution = executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    });

    await vi.waitFor(() => {
      expect(getAccountActiveOrders).toHaveBeenCalledTimes(1);
      expect(recordExecutionObserved).toHaveBeenCalledTimes(1);
    });
    expect(d.signer.createAccountAuth).toHaveBeenCalledTimes(1);
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.signer.signCreateOrder).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();

    repairReadGate.release();
    await Promise.resolve();
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.signer.signCreateOrder).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();

    observedNonceGate.release();
    const result = await execution;

    expect(d.reserveNonce).toHaveBeenCalledTimes(1);
    expect(d.signer.signCreateOrder).toHaveBeenCalledTimes(1);
    expect(d.client.sendTx).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("sequencer_pending");
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

    expect(d.client.getAccountActiveOrders).not.toHaveBeenCalled();
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
        priceComparison: "crossing_or_taker",
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
      submitMessage: PROVIDER_SUBMIT_MESSAGE,
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
    expect(JSON.stringify(result)).not.toContain(PROVIDER_SUBMIT_MESSAGE);
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

  it.each([
    {
      label: "resting good-till-time limit",
      side: "buy" as const,
      price: "2998",
      orderType: "limit" as const,
      timeInForce: "good-till-time" as const,
      reduceOnly: false,
      triggerPrice: undefined,
      expectedOrderTypeCode: 0,
      expectedPriceComparison: "resting" as const,
    },
    {
      label: "reduce-only stop-loss-limit immediate-or-cancel",
      side: "sell" as const,
      price: "2800",
      orderType: "stop-loss-limit" as const,
      timeInForce: "immediate-or-cancel" as const,
      reduceOnly: true,
      triggerPrice: "2900",
      expectedOrderTypeCode: 3,
      expectedTimeInForceCode: 0,
      expectedPriceComparison: "unknown" as const,
    },
    {
      label: "reduce-only stop-loss-limit good-till-time",
      side: "sell" as const,
      price: "2800",
      orderType: "stop-loss-limit" as const,
      timeInForce: "good-till-time" as const,
      reduceOnly: true,
      triggerPrice: "2900",
      expectedOrderTypeCode: 3,
      expectedTimeInForceCode: 1,
      expectedPriceComparison: "unknown" as const,
    },
    {
      label: "reduce-only stop-loss-limit post-only",
      side: "sell" as const,
      price: "2800",
      orderType: "stop-loss-limit" as const,
      timeInForce: "post-only" as const,
      reduceOnly: true,
      triggerPrice: "2900",
      expectedOrderTypeCode: 3,
      expectedTimeInForceCode: 2,
      expectedPriceComparison: "unknown" as const,
    },
    {
      label: "reduce-only take-profit-limit immediate-or-cancel",
      side: "sell" as const,
      price: "3050",
      orderType: "take-profit-limit" as const,
      timeInForce: "immediate-or-cancel" as const,
      reduceOnly: true,
      triggerPrice: "3100",
      expectedOrderTypeCode: 5,
      expectedTimeInForceCode: 0,
      expectedPriceComparison: "unknown" as const,
    },
    {
      label: "reduce-only take-profit-limit good-till-time",
      side: "sell" as const,
      price: "3050",
      orderType: "take-profit-limit" as const,
      timeInForce: "good-till-time" as const,
      reduceOnly: true,
      triggerPrice: "3100",
      expectedOrderTypeCode: 5,
      expectedTimeInForceCode: 1,
      expectedPriceComparison: "unknown" as const,
    },
    {
      label: "reduce-only take-profit-limit post-only",
      side: "sell" as const,
      price: "3050",
      orderType: "take-profit-limit" as const,
      timeInForce: "post-only" as const,
      reduceOnly: true,
      triggerPrice: "3100",
      expectedOrderTypeCode: 5,
      expectedTimeInForceCode: 2,
      expectedPriceComparison: "unknown" as const,
    },
  ])("executes an exact approved $label through provider evidence", async (orderPolicy) => {
    const liveAccount: LighterAccountResponse = orderPolicy.reduceOnly
      ? {
          ...ACCOUNT,
          accounts: [{
            ...first(ACCOUNT.accounts),
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
        }
      : ACCOUNT;
    const approvedPreview = buildLighterOrderPreview({
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      accountIndex: PLAN.accountIndex,
      apiKeyIndex: PLAN.apiKeyIndex,
      marketId: PLAN.marketIndex,
      side: orderPolicy.side,
      baseAmount: "1",
      price: orderPolicy.price,
      orderType: orderPolicy.orderType,
      timeInForce: orderPolicy.timeInForce,
      reduceOnly: orderPolicy.reduceOnly,
      ...(orderPolicy.triggerPrice === undefined
        ? {}
        : { triggerPrice: orderPolicy.triggerPrice }),
      orderExpiry: PLAN.orderExpiryMs,
      clientOrderIndexPolicy: PLAN.clientOrderIndexPolicy,
      nowMs: NOW,
    }, { market: MARKET, orderBook: ORDER_BOOK, account: liveAccount });
    const approvedPlan: LighterOrderReadyForSignerPlan = {
      ...PLAN,
      previewId: approvedPreview.previewId,
      matchHash: approvedPreview.matchHash,
      side: orderPolicy.side,
      baseAmountInteger: approvedPreview.identity.baseAmountInteger,
      priceInteger: approvedPreview.identity.priceInteger,
      orderType: orderPolicy.orderType,
      timeInForce: orderPolicy.timeInForce,
      reduceOnly: orderPolicy.reduceOnly,
      triggerPriceInteger: approvedPreview.preview.triggerPrice.integer,
    };
    const approvedRow = {
      ...APPROVED_PREVIEW_ROW,
      previewId: approvedPlan.previewId,
      matchHash: approvedPlan.matchHash,
      side: approvedPlan.side,
      baseAmountInteger: approvedPlan.baseAmountInteger,
      priceInteger: approvedPlan.priceInteger,
      orderType: approvedPlan.orderType,
      timeInForce: approvedPlan.timeInForce,
      reduceOnly: approvedPlan.reduceOnly,
      triggerPriceInteger: approvedPlan.triggerPriceInteger,
      previewJson: { ...approvedPreview.preview },
    };
    const unsigned = buildLighterUnsignedCreateOrderRequest(approvedPlan);
    const providerOrder = {
      ...accountOrder(),
      client_order_index: Number(unsigned.clientOrderIndex),
      client_order_id: unsigned.clientOrderIndex,
      initial_base_amount: approvedPreview.preview.baseAmount.display,
      remaining_base_amount: approvedPreview.preview.baseAmount.display,
      price: approvedPreview.preview.price.display,
      side: approvedPlan.side,
      type: approvedPlan.orderType,
      time_in_force: approvedPlan.timeInForce,
      reduce_only: approvedPlan.reduceOnly,
      trigger_price: approvedPreview.preview.triggerPrice.display ?? "0",
    };
    const base = deps();
    const d = deps({
      client: {
        ...base.client,
        getAccount: vi.fn(async () => liveAccount),
        getAccountActiveOrders: vi
          .fn()
          .mockResolvedValueOnce({ code: 200, orders: [] })
          .mockResolvedValueOnce({ code: 200, orders: [providerOrder] }),
      },
      previews: { findFreshById: vi.fn(async () => approvedRow) },
      reserveNonce: vi.fn(async () => ({
        kind: "lighter_order_nonce_reservation" as const,
        intentId: approvedPlan.intentId,
        sessionId: approvedPlan.sessionId,
        reservationId: `lighter-order:${approvedPlan.intentId}`,
        nonceValue: "0",
        environment: approvedPlan.environment,
        accountIndex: approvedPlan.accountIndex,
        apiKeyIndex: approvedPlan.apiKeyIndex,
      })),
      intents: {
        ...base.intents,
        markPreSubmitRevalidated: vi.fn(async () => ({
          ...APPROVED_INTENT_ROW,
          previewId: approvedPlan.previewId,
          matchHash: approvedPlan.matchHash,
          side: approvedPlan.side,
          baseAmountInteger: approvedPlan.baseAmountInteger,
          priceInteger: approvedPlan.priceInteger,
          orderType: approvedPlan.orderType,
          timeInForce: approvedPlan.timeInForce,
          reduceOnly: approvedPlan.reduceOnly,
          triggerPriceInteger: approvedPlan.triggerPriceInteger,
        })),
      },
    });

    const result = await executeApprovedLighterCreateOrder({
      plan: approvedPlan,
      unsignedOrder: unsigned,
      deps: d,
    });

    expect(d.intents.markPreSubmitRevalidated).toHaveBeenCalledWith({
      intentId: approvedPlan.intentId,
      sessionId: approvedPlan.sessionId,
      environment: approvedPlan.environment,
      evidence: expect.objectContaining({
        kind: "lighter_order_pre_submit_revalidation",
        previewId: approvedPlan.previewId,
        matchHash: approvedPlan.matchHash,
        priceComparison: orderPolicy.expectedPriceComparison,
        positionVerified: orderPolicy.reduceOnly,
      }),
    });
    expect(d.signer.signCreateOrder).toHaveBeenCalledWith(expect.objectContaining({
      order: expect.objectContaining({
        matchHash: approvedPlan.matchHash,
        orderTypeCode: orderPolicy.expectedOrderTypeCode,
        timeInForceCode: orderPolicy.expectedTimeInForceCode ?? 1,
        reduceOnly: orderPolicy.reduceOnly,
        triggerPriceInteger: approvedPlan.triggerPriceInteger ?? "0",
        priceInteger: approvedPlan.priceInteger,
      }),
    }));
    expect(d.intents.markSigned).toHaveBeenCalledTimes(1);
    expect(d.client.sendTx).toHaveBeenCalledWith("rhc", {
      txType: 14,
      txInfo: TX_INFO,
    });
    expect(d.intents.markProviderOutcome).toHaveBeenCalledWith(expect.objectContaining({
      intentId: approvedPlan.intentId,
      state: "open",
      source: "active_order",
      providerOrderId: "123",
      providerOutcomeJson: expect.objectContaining({
        clientOrderIndex: unsigned.clientOrderIndex,
        side: approvedPlan.side,
        orderType: approvedPlan.orderType,
        timeInForce: approvedPlan.timeInForce,
        reduceOnly: approvedPlan.reduceOnly,
        triggerPrice: approvedPreview.preview.triggerPrice.display ?? "0",
      }),
    }));
    expect(result).toMatchObject({
      status: "provider_confirmed",
      executionState: "open",
      evidenceSource: "active_order",
      clientOrderIndex: unsigned.clientOrderIndex,
    });
    expect(JSON.stringify(result)).not.toContain(TX_INFO);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
    expect(JSON.stringify(result)).not.toContain(AUTH_TOKEN);
  });

  it("revalidates and submits the exact approved reduce-only stop-loss through the same guarded pipeline", async () => {
    const protectiveAccount: LighterAccountResponse = {
      ...ACCOUNT,
      accounts: [{
        ...first(ACCOUNT.accounts),
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
    const protectivePreview = buildLighterOrderPreview({
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      accountIndex: PLAN.accountIndex,
      apiKeyIndex: PLAN.apiKeyIndex,
      marketId: PLAN.marketIndex,
      side: "sell",
      baseAmount: "1",
      price: "2800",
      orderType: "stop-loss",
      timeInForce: "immediate-or-cancel",
      reduceOnly: true,
      triggerPrice: "2900",
      orderExpiry: PLAN.orderExpiryMs,
      clientOrderIndexPolicy: PLAN.clientOrderIndexPolicy,
      nowMs: NOW,
    }, { market: MARKET, orderBook: ORDER_BOOK, account: protectiveAccount });
    const protectivePlan: LighterOrderReadyForSignerPlan = {
      ...PLAN,
      previewId: protectivePreview.previewId,
      matchHash: protectivePreview.matchHash,
      side: "sell",
      baseAmountInteger: protectivePreview.identity.baseAmountInteger,
      priceInteger: protectivePreview.identity.priceInteger,
      orderType: "stop-loss",
      reduceOnly: true,
      triggerPriceInteger: protectivePreview.identity.triggerPriceInteger,
    };
    const protectiveRow = {
      ...APPROVED_PREVIEW_ROW,
      previewId: protectivePlan.previewId,
      matchHash: protectivePlan.matchHash,
      side: protectivePlan.side,
      baseAmountInteger: protectivePlan.baseAmountInteger,
      priceInteger: protectivePlan.priceInteger,
      orderType: protectivePlan.orderType,
      reduceOnly: protectivePlan.reduceOnly,
      triggerPriceInteger: protectivePlan.triggerPriceInteger,
      previewJson: { ...protectivePreview.preview },
    };
    const unsigned = buildLighterUnsignedCreateOrderRequest(protectivePlan);
    const base = deps();
    const d = deps({
      client: {
        ...base.client,
        getAccount: vi.fn(async () => protectiveAccount),
      },
      previews: { findFreshById: vi.fn(async () => protectiveRow) },
      reserveNonce: vi.fn(async () => ({
        kind: "lighter_order_nonce_reservation" as const,
        intentId: protectivePlan.intentId,
        sessionId: protectivePlan.sessionId,
        reservationId: `lighter-order:${protectivePlan.intentId}`,
        nonceValue: "0",
        environment: protectivePlan.environment,
        accountIndex: protectivePlan.accountIndex,
        apiKeyIndex: protectivePlan.apiKeyIndex,
      })),
      intents: {
        ...base.intents,
        markPreSubmitRevalidated: vi.fn(async () => ({
          ...APPROVED_INTENT_ROW,
          previewId: protectivePlan.previewId,
          matchHash: protectivePlan.matchHash,
          side: protectivePlan.side,
          baseAmountInteger: protectivePlan.baseAmountInteger,
          priceInteger: protectivePlan.priceInteger,
          orderType: protectivePlan.orderType,
          reduceOnly: protectivePlan.reduceOnly,
          triggerPriceInteger: protectivePlan.triggerPriceInteger,
        })),
      },
    });

    const result = await executeApprovedLighterCreateOrder({
      plan: protectivePlan,
      unsignedOrder: unsigned,
      deps: d,
    });

    expect(d.intents.markPreSubmitRevalidated).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({
        priceComparison: "unknown",
        positionVerified: true,
        positionSide: "long",
      }),
    }));
    expect(d.signer.signCreateOrder).toHaveBeenCalledWith(expect.objectContaining({
      order: expect.objectContaining({
        orderTypeCode: 2,
        timeInForceCode: 0,
        reduceOnly: true,
        triggerPriceInteger: "290000",
        priceInteger: "280000",
      }),
    }));
    expect(d.client.sendTx).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "sequencer_pending" });
  });

  it("returns the actual full fill when the provider reports zero base_size after execution", async () => {
    const d = deps();
    vi.mocked(d.client.getAccountInactiveOrders)
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValue({ code: 200, orders: [accountOrder({
        status: "filled", base_size: 0, filled_base_amount: "1", remaining_base_amount: "0",
        filled_quote_amount: "3000.25", is_ask: false,
      })] });
    const result = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });
    expect(result).toMatchObject({ status: "provider_confirmed", executionState: "filled",
      providerEvidence: { filledBaseAmount: "1", remainingBaseAmount: "0", filledQuoteAmount: "3000.25", averageExecutionPrice: "3000.25" },
    });
    expect(d.client.sendTx).toHaveBeenCalledTimes(1);
    expect(d.intents.markAmbiguous).not.toHaveBeenCalled();
  });

  it("does not turn a fill already confirmed by the stream into a persistence error", async () => {
    const d = deps();
    vi.mocked(d.client.getAccountInactiveOrders)
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValue({ code: 200, orders: [accountOrder({
        status: "filled", base_size: 0, filled_base_amount: "1", remaining_base_amount: "0", filled_quote_amount: "3000",
      })] });
    vi.mocked(d.intents.markProviderOutcome).mockResolvedValue(null);
    vi.mocked(d.intents.findByIntentIdAnySession).mockResolvedValue({
      ...APPROVED_INTENT_ROW, executionState: "filled", clientOrderIndex: UNSIGNED_ORDER.clientOrderIndex,
      providerOrderId: "123", providerOrderStatus: "filled", providerOutcomeSource: "inactive_order",
      providerOutcomeJson: { filledBaseAmount: "1", remainingBaseAmount: "0", filledQuoteAmount: "3000", averageExecutionPrice: "3000" },
    });
    const result = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });
    expect(result).toMatchObject({ status: "provider_confirmed", executionState: "filled", providerEvidence: { filledBaseAmount: "1" } });
    expect(d.intents.markAmbiguous).not.toHaveBeenCalled();
    expect(d.client.sendTx).toHaveBeenCalledTimes(1);
  });

  it("reports a contradictory filled quantity specifically without submitting again", async () => {
    const d = deps();
    vi.mocked(d.client.getAccountInactiveOrders)
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValue({ code: 200, orders: [accountOrder({ status: "filled", filled_base_amount: "0.5", remaining_base_amount: "0" })] });
    const result = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });
    expect(result).toMatchObject({ status: "ambiguous", reason: expect.stringContaining("filled_amounts") });
    expect(d.client.sendTx).toHaveBeenCalledTimes(1);
    expect(d.intents.markProviderOutcome).not.toHaveBeenCalled();
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

  it("reports reconciliation-only ambiguity when acceptance persistence fails after submission", async () => {
    const predictedExecutionTimeMs = 1_787_694_621_445;
    const base = deps();
    const d = deps({
      client: {
        ...base.client,
        sendTx: vi.fn(async () => ({
          code: 200,
          message: PROVIDER_SUBMIT_MESSAGE,
          tx_hash: TX_HASH,
          predicted_execution_time_ms: predictedExecutionTimeMs,
          volume_quota_remaining: 99,
        })),
      },
      intents: {
        ...base.intents,
        markApiAccepted: vi.fn(async () => {
          throw new Error(`value "${predictedExecutionTimeMs}" is out of range for type integer`);
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
      executionState: "ambiguous",
      reason: "api_acceptance_persist_failed",
      signerTxHash: TX_HASH,
    });
    expect(result.message).toContain("before any retry");
    expect(d.client.sendTx).toHaveBeenCalledTimes(1);
    expect(d.intents.markAmbiguous).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      reason: "api_acceptance_persist_failed",
    });
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

  it("surfaces the sendTx VexError code and HTTP status in the ambiguous reason", async () => {
    const submitError = new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `RHC rejected signed transaction submission (HTTP 400). ${TX_INFO}`,
    );
    submitError.httpStatus = 400;
    const d = deps({
      client: {
        ...deps().client,
        sendTx: vi.fn(async () => {
          throw submitError;
        }),
      },
    });

    const result = await executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    });

    const expectedReason =
      "sendtx_failed_after_submit_attempt:code=LIGHTER_INVALID_REQUEST,http=400";
    expect(result).toMatchObject({
      status: "ambiguous",
      reason: expectedReason,
      signerTxHash: TX_HASH,
    });
    expect(d.intents.markAmbiguous).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      reason: expectedReason,
    });
    // The diagnostic reason must carry the status but never the error message body.
    expect(JSON.stringify(result)).not.toContain(TX_INFO);
    expect(JSON.stringify(result)).not.toContain("rejected signed transaction");
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
