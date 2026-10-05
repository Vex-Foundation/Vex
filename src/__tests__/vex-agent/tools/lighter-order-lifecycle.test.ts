import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as feePolicy from "@tools/lighter/fee-policy.js";

// The capital-share boundary on the modify path. `null` limits is the DEFAULT
// INSTALL: no share is set, so the modification's margin delta has no ceiling to
// fit and the ledger is never reached. Delta admission with a share set is
// proved in `lighter-capital-share-policy.test.ts`.
vi.mock("@vex-agent/db/repos/lighter-trading-limits.js", () => ({
  readLighterTradingLimits: async () => null,
}));
// Both ledger exits are RECORDED rather than stubbed away, because they are
// NOT interchangeable: a commitment that outlives its intent shrinks the user's
// budget forever, while one retired the instant its modification settled
// reopens the stale-snapshot gap. A never-sent modification retires at once; a
// settled one is only STAMPED and keeps counting until the observation lag runs.
const ledger = vi.hoisted(() => ({
  retired: [] as { intentId: string; reason: string }[],
  settled: [] as string[],
}));
vi.mock("@vex-agent/db/repos/lighter-capital-commitments.js", () => ({
  admitLighterCapitalCommitment: async () => ({
    admitted: true,
    commitmentId: "commitment-test",
    liveCommittedUnits: "0",
  }),
  listLiveLighterCapitalCommitments: async () => [],
  retireLighterCapitalCommitment: async (input: { intentId: string; reason: string }) => {
    ledger.retired.push(input);
  },
  markLighterCapitalCommitmentSettled: async (intentId: string) => {
    ledger.settled.push(intentId);
  },
}));

import {
  executeApprovedLighterCancelAll,
  executeApprovedLighterCancelOne,
  executeApprovedLighterClosePosition,
  executeApprovedLighterModifyOrder,
  lifecycleSnapshot,
  prepareLighterCancelAll,
  prepareLighterCancelOne,
  prepareLighterClosePosition,
  prepareLighterModifyOrder,
  type LighterOrderLifecycleExecutionDeps,
} from "@vex-agent/tools/protocols/lighter/order-lifecycle.js";
import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import type { LighterAccountOrder, LighterAccountPosition } from "@tools/lighter/types.js";
import { deriveVexAssignedClientOrderIndex } from "@tools/lighter/signer-order.js";
import type { LighterOrderLifecycleSignerResult } from "@tools/lighter/signer-order-lifecycle.js";

// These lifecycle fixtures represent orders approved while collection is disabled.
// Enabled-policy refusal is exercised separately below and fee terms have their own suite.
beforeEach(() => vi.spyOn(feePolicy, "getLighterFeePolicy").mockReturnValue(null));
afterEach(() => vi.restoreAllMocks());

import {
  createLighterOrderLifecycleSignerBinary,
  type LighterSignerBinaryRunner,
} from "@tools/lighter/signer-binary-adapter.js";
import {
  signerRunnerEmitting,
  signerRunnerExitingWithoutOutput,
  signerRunnerNeverClosing,
  signerRunnerRejectingWithoutEvidence,
} from "../../helpers/lighter-scripted-signer.js";

const NOW = Date.parse("2026-08-19T20:00:00.000Z");
const PRIVATE_KEY = "1".repeat(80);

const openOrder: LighterAccountOrder = {
  order_index: 9_007_199_254_740_991,
  client_order_index: 123,
  order_id: "1152921504606846975",
  client_order_id: "123",
  market_index: 0,
  owner_account_index: 42,
  initial_base_amount: "1",
  remaining_base_amount: "0.5",
  filled_base_amount: "0.5",
  filled_quote_amount: "25",
  price: "50",
  side: "buy",
  type: "limit",
  time_in_force: "good-till-time",
  reduce_only: false,
  status: "open",
};

const longPosition: LighterAccountPosition = {
  market_id: 0,
  symbol: "ETH",
  initial_margin_fraction: "5.00",
  open_order_count: 0,
  pending_order_count: 0,
  position_tied_order_count: 0,
  sign: 1,
  position: "1.0000",
  avg_entry_price: "45.00",
  position_value: "50.000000",
  unrealized_pnl: "5.000000",
  realized_pnl: "0.000000",
  liquidation_price: "30.00",
  margin_mode: 0,
  allocated_margin: "0.000000",
  total_discount: "0.000000",
};

function intent(overrides: Partial<LighterOrderLifecycleIntentRow> = {}): LighterOrderLifecycleIntentRow {
  return {
    intentId: `lighter-lifecycle-${"a".repeat(32)}`,
    sessionId: "session-1",
    protocolExecutionId: null,
    approvalId: "approval-1",
    matchHash: "b".repeat(64),
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    actionType: "cancel_one",
    marketIndex: 0,
    providerOrderId: openOrder.order_id,
    requestedBaseAmountInteger: null,
    requestedPriceInteger: null,
    requestedSide: null,
    reduceOnly: false,
    providerSnapshotJson: { ...lifecycleSnapshot(openOrder) },
    credentialRefJson: {
      kind: "encrypted_vault_reference",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      vaultCredentialId: "lighter/rhc/account-42/api-key-7",
    },
    approvalStatus: "approved",
    executionState: "approved",
    decisionReason: "approved",
    decidedAt: "2026-08-19T19:59:00.000Z",
    preSubmitRevalidationJson: null,
    preSubmitRevalidatedAt: null,
    nonceReservationId: null,
    nonceValue: null,
    signerExpiryMs: null,
    signerTxHash: null,
    submittedTxHash: null,
    submitCode: null,
    submitMessage: null,
    predictedExecutionTimeMs: null,
    volumeQuotaRemaining: null,
    providerOutcomeJson: null,
    providerOutcomeCheckedAt: null,
    ambiguousReason: null,
    createdAt: "2026-08-19T19:58:00.000Z",
    updatedAt: "2026-08-19T19:59:00.000Z",
    expiresAt: "2026-08-19T20:05:00.000Z",
    ...overrides,
  };
}

/**
 * What the helper returns for each lifecycle action. Built per call, so a test
 * that stamps a child state onto one result cannot reach another test's deps.
 */
const LIFECYCLE_SIGNER_TX = {
  cancel_one: { operation: "cancel_order", txType: 15, txInfo: "signed-cancel", txHash: "hash-15" },
  modify: { operation: "modify_order", txType: 17, txInfo: "signed-modify", txHash: "hash-17" },
  cancel_all: { operation: "cancel_all_orders", txType: 16, txInfo: "signed-cancel-all", txHash: "hash-16" },
} as const;

function lifecycleSignerResult(
  action: keyof typeof LIFECYCLE_SIGNER_TX,
): LighterOrderLifecycleSignerResult {
  return {
    kind: "lighter_order_lifecycle_signer_result",
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    nonce: "9",
    expiredAt: String(NOW + 60_000),
    ...LIFECYCLE_SIGNER_TX[action],
  };
}

function deps(overrides: Partial<LighterOrderLifecycleExecutionDeps> = {}): LighterOrderLifecycleExecutionDeps {
  const active = vi.fn()
    .mockResolvedValueOnce({ code: 200, orders: [openOrder] })
    .mockResolvedValue({ code: 200, orders: [] });
  const canceledOrder = { ...openOrder, status: "canceled", remaining_base_amount: "0.5" };
  return {
    signingOwnershipRecheck: false,
    secretReader: { readTradingApiPrivateKey: vi.fn().mockResolvedValue(PRIVATE_KEY) },
    authSigner: {
      source: "official_lighter_signer",
      createAccountAuth: vi.fn().mockResolvedValue({
        kind: "lighter_account_auth_signer_result",
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
        deadlineUnixSeconds: Math.floor(NOW / 1_000) + 600,
        authToken: `${Math.floor(NOW / 1_000) + 600}:42:7:${"a".repeat(128)}`,
        publicKey: "b".repeat(80),
      }),
      signCreateOrder: vi.fn(),
    },
    lifecycleSigner: {
      source: "official_lighter_signer",
      signCancelOrder: vi.fn().mockResolvedValue(lifecycleSignerResult("cancel_one")),
      signModifyOrder: vi.fn().mockResolvedValue(lifecycleSignerResult("modify")),
      signCancelAllOrders: vi.fn().mockResolvedValue(lifecycleSignerResult("cancel_all")),
    },
    client: {
      getAccountActiveOrders: active,
      getAccountInactiveOrders: vi.fn().mockResolvedValue({ code: 200, orders: [canceledOrder] }),
      // The modify path re-admits its margin DELTA against the agent's capital
      // share before signing, which reads the traded account (for the owning
      // wallet) and, only when a share exists, the market's margin fractions.
      getAccount: vi.fn().mockResolvedValue({
        code: 200,
        accounts: [{
          index: 42,
          l1_address: "0x1111111111111111111111111111111111111111",
          collateral: "1000",
          available_balance: "900",
          cross_initial_margin_requirement: "0.000000",
          positions: [],
        }],
      }),
      getMarketDetails: vi.fn().mockResolvedValue({
        code: 200,
        order_book_details: [{
          market_id: 0,
          symbol: "ETH",
          market_type: "perp",
          status: "active",
          taker_fee: "0.0000",
          supported_size_decimals: 4,
          supported_price_decimals: 2,
          supported_quote_decimals: 6,
          default_initial_margin_fraction: 5000,
          min_initial_margin_fraction: 200,
          mark_price: "3000.00",
        }],
        spot_order_book_details: [],
      }),
      getMarkets: vi.fn().mockResolvedValue({
        code: 200,
        order_books: [{ market_id: 0, status: "active", supported_size_decimals: 4, supported_price_decimals: 2 }],
      }),
      getApiKeys: vi.fn().mockResolvedValue({ code: 200, api_keys: [{
        account_index: 42, api_key_index: 7, nonce: 9, public_key: "b".repeat(80), transaction_time: NOW,
      }] }),
      getNextNonce: vi.fn().mockResolvedValue({ code: 200, nonce: 9 }),
      sendTx: vi.fn().mockResolvedValue({
        code: 200, tx_hash: "hash-15", predicted_execution_time_ms: 100, volume_quota_remaining: 99,
      }),
    },
    intents: {
      markSendAttemptStarted: vi.fn(async () => true),
      markExpiredUnsubmitted: vi.fn(async () => true),
      markUnsubmittedRefused: vi.fn(async () => true),
      markPreSubmitRevalidated: vi.fn().mockResolvedValue(intent({ executionState: "pre_submit_revalidated" })),
      attachNonceReservationWith: vi.fn().mockResolvedValue(intent({ executionState: "nonce_reserved" })),
      markSigned: vi.fn().mockResolvedValue(intent({ executionState: "signed" })),
      markSubmissionStaged: vi.fn().mockResolvedValue(intent({ executionState: "submission_staged" })),
      markApiAccepted: vi.fn().mockResolvedValue(intent({ executionState: "api_accepted" })),
      markProviderOutcome: vi.fn().mockResolvedValue(intent({ executionState: "completed" })),
      markAmbiguous: vi.fn().mockResolvedValue(intent({ executionState: "ambiguous" })),
      markClosePositionChangedBeforeSubmissionWith: vi.fn().mockResolvedValue(intent({ executionState: "rejected" })),
      abandonRevalidatedBeforeNonce: vi.fn().mockResolvedValue(intent({ executionState: "rejected" })),
    },
    nonceState: {
      releaseUnsubmittedReservation: vi.fn(async () => null),
      recordExecutionObserved: vi.fn().mockResolvedValue({ status: "observed" }),
      reserveObservedWith: vi.fn().mockResolvedValue({ reservedNonce: "9", reservationId: `lighter-lifecycle:${intent().intentId}` }),
    },
    transaction: vi.fn(async (fn) => fn({})) as typeof import("@vex-agent/db/client.js").withTransaction,
    acquireSessionControlLock: vi.fn().mockResolvedValue(undefined),
    now: () => NOW,
    wait: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as LighterOrderLifecycleExecutionDeps;
}

describe("Lighter cancel-one lifecycle", () => {
  it("prepares only an exact active provider order and hashes its immutable snapshot", async () => {
    const result = await prepareLighterCancelOne({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketIndex: 0,
      providerOrderId: openOrder.order_id,
      auth: { token: "read-token", accountIndex: 42 },
      client: { getAccountActiveOrders: vi.fn().mockResolvedValue({ code: 200, orders: [openOrder] }) },
    });
    expect(result.providerOrderId).toBe("1152921504606846975");
    expect(result.snapshot.orderId).toBe("1152921504606846975");
    expect(result.matchHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stages once and reports cancellation only from exact inactive-order evidence", async () => {
    const dependencies = deps();
    const result = await executeApprovedLighterCancelOne(intent(), dependencies);
    expect(result).toMatchObject({
      status: "canceled",
      providerOrderId: openOrder.order_id,
      executedAmount: "0.5",
      remainingAmount: "0.5",
      averageFillPrice: "50",
    });
    expect(dependencies.client.sendTx).toHaveBeenCalledTimes(1);
    expect(dependencies.intents.markSubmissionStaged).toHaveBeenCalledBefore(
      dependencies.client.sendTx as ReturnType<typeof vi.fn>,
    );
  });

  it("never retries an ambiguous provider submission", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.client.sendTx).mockRejectedValueOnce(new Error("timeout"));
    const result = await executeApprovedLighterCancelOne(intent(), dependencies);
    expect(result).toMatchObject({ status: "ambiguous", reason: "send_tx_transport_ambiguous" });
    expect(dependencies.client.sendTx).toHaveBeenCalledTimes(1);
    expect(dependencies.intents.markAmbiguous).toHaveBeenCalledWith({
      intentId: intent().intentId,
      reason: "send_tx_transport_ambiguous",
    });
  });

  it("blocks changed order facts before nonce reservation", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.client.getAccountActiveOrders).mockReset().mockResolvedValue({
      code: 200,
      orders: [{ ...openOrder, remaining_base_amount: "0.4" }],
    });
    await expect(executeApprovedLighterCancelOne(intent(), dependencies)).rejects.toThrow(
      "changed before cancel submission",
    );
    expect(dependencies.nonceState.reserveObservedWith).not.toHaveBeenCalled();
    expect(dependencies.client.sendTx).not.toHaveBeenCalled();
  });
});

describe("Lighter modify-order lifecycle", () => {
  it("prepares human amounts at live market precision and binds the original order", async () => {
    const result = await prepareLighterModifyOrder({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketIndex: 0,
      providerOrderId: openOrder.order_id,
      requestedBaseAmount: "0.75",
      requestedPrice: "51.25",
      sizeDecimals: 4,
      priceDecimals: 2,
      auth: { token: "read-token", accountIndex: 42 },
      client: { getAccountActiveOrders: vi.fn().mockResolvedValue({ code: 200, orders: [openOrder] }) },
    });
    expect(result).toMatchObject({
      providerOrderId: openOrder.order_id,
      requestedBaseAmount: "0.75",
      requestedBaseAmountInteger: "7500",
      requestedPrice: "51.25",
      requestedPriceInteger: "5125",
    });
    expect(result.matchHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a new total amount below what is already filled", async () => {
    await expect(prepareLighterModifyOrder({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketIndex: 0,
      providerOrderId: openOrder.order_id,
      requestedBaseAmount: "0.4",
      requestedPrice: "51",
      sizeDecimals: 4,
      priceDecimals: 2,
      client: { getAccountActiveOrders: vi.fn().mockResolvedValue({ code: 200, orders: [openOrder] }) },
    })).rejects.toThrow("below the amount already filled");
  });

  it("submits once and completes only from exact updated provider evidence", async () => {
    const modifiedOrder = {
      ...openOrder,
      initial_base_amount: "0.75",
      remaining_base_amount: "0.25",
      price: "51.25",
    };
    const dependencies = deps();
    vi.mocked(dependencies.client.getAccountActiveOrders)
      .mockReset()
      .mockResolvedValueOnce({ code: 200, orders: [openOrder] })
      .mockResolvedValue({ code: 200, orders: [modifiedOrder] });
    vi.mocked(dependencies.client.getAccountInactiveOrders).mockResolvedValue({ code: 200, orders: [] });
    vi.mocked(dependencies.client.sendTx).mockResolvedValue({
      code: 200, tx_hash: "hash-17", predicted_execution_time_ms: 100, volume_quota_remaining: 99,
    });
    const modifyIntent = intent({
      actionType: "modify",
      requestedBaseAmountInteger: "7500",
      requestedPriceInteger: "5125",
      providerSnapshotJson: {
        ...lifecycleSnapshot(openOrder),
        marketSizeDecimals: 4,
        marketPriceDecimals: 2,
      },
    });
    const result = await executeApprovedLighterModifyOrder(modifyIntent, dependencies);
    expect(result).toMatchObject({
      status: "modified",
      providerOrderId: openOrder.order_id,
      effectiveBaseAmount: "0.75",
      effectivePrice: "51.25",
      executedAmount: "0.5",
      remainingAmount: "0.25",
    });
    expect(dependencies.lifecycleSigner.signModifyOrder).toHaveBeenCalledWith(expect.objectContaining({
      providerOrderId: openOrder.order_id,
      baseAmountInteger: "7500",
      priceInteger: "5125",
    }));
    expect(dependencies.client.sendTx).toHaveBeenCalledTimes(1);
    // The provider now shows the modified order, so the delta this
    // modification committed is carried by the account's own numbers - but only
    // for a reader whose account snapshot is NEWER than this moment. The
    // commitment is therefore STAMPED and keeps counting, not retired.
    expect(ledger.settled).toEqual([modifyIntent.intentId]);
    expect(ledger.retired).toEqual([]);
  });

  it("blocks a changed order before reserving a modify nonce", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.client.getAccountActiveOrders).mockReset().mockResolvedValue({
      code: 200,
      orders: [{ ...openOrder, remaining_base_amount: "0.4" }],
    });
    const modifyIntent = intent({
      actionType: "modify",
      requestedBaseAmountInteger: "7500",
      requestedPriceInteger: "5125",
      providerSnapshotJson: {
        ...lifecycleSnapshot(openOrder),
        marketSizeDecimals: 4,
        marketPriceDecimals: 2,
      },
    });
    await expect(executeApprovedLighterModifyOrder(modifyIntent, dependencies)).rejects.toThrow(
      "changed before modify submission",
    );
    expect(dependencies.nonceState.reserveObservedWith).not.toHaveBeenCalled();
    expect(dependencies.client.sendTx).not.toHaveBeenCalled();
  });
});

describe("Lighter cancel-all lifecycle", () => {
  const secondOrder: LighterAccountOrder = {
    ...openOrder,
    order_id: "281474976710657",
    client_order_id: "124",
    client_order_index: 124,
    market_index: 1,
    initial_base_amount: "2",
    remaining_base_amount: "2",
    filled_base_amount: "0",
    filled_quote_amount: "0",
    price: "25",
  };

  it("prepares and hashes the complete exact active-order set", async () => {
    const result = await prepareLighterCancelAll({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      auth: { token: "read-token", accountIndex: 42 },
      client: { getAccountActiveOrders: vi.fn().mockResolvedValue({ code: 200, orders: [secondOrder, openOrder] }) },
    });
    expect(result.orders.map((order) => order.orderId)).toEqual([openOrder.order_id, secondOrder.order_id]);
    expect(result.matchHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("submits immediate account-wide cancel once and proves every approved order terminal", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.client.getAccountActiveOrders)
      .mockReset()
      .mockResolvedValueOnce({ code: 200, orders: [secondOrder, openOrder] })
      .mockResolvedValue({ code: 200, orders: [] });
    vi.mocked(dependencies.client.getAccountInactiveOrders).mockResolvedValue({
      code: 200,
      orders: [
        { ...openOrder, status: "canceled" },
        { ...secondOrder, status: "filled", remaining_base_amount: "0", filled_base_amount: "2", filled_quote_amount: "50" },
      ],
    });
    vi.mocked(dependencies.client.sendTx).mockResolvedValue({
      code: 200, tx_hash: "hash-16", predicted_execution_time_ms: 100, volume_quota_remaining: 99,
    });
    const approvedOrders = [lifecycleSnapshot(openOrder), lifecycleSnapshot(secondOrder)];
    const cancelAllIntent = intent({
      actionType: "cancel_all",
      marketIndex: null,
      providerOrderId: null,
      providerSnapshotJson: { orders: approvedOrders, orderCount: approvedOrders.length },
    });
    const result = await executeApprovedLighterCancelAll(cancelAllIntent, dependencies);
    expect(result).toMatchObject({
      status: "cancel_all_completed",
      canceledOrderCount: 1,
      filledBeforeCancelCount: 1,
    });
    expect(dependencies.lifecycleSigner.signCancelAllOrders).toHaveBeenCalledWith(expect.objectContaining({
      timeInForce: 0,
      cancelAtMs: "0",
    }));
    expect(dependencies.client.sendTx).toHaveBeenCalledTimes(1);
  });

  it("blocks when the account-wide active set changes before nonce reservation", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.client.getAccountActiveOrders).mockReset().mockResolvedValue({
      code: 200,
      orders: [openOrder],
    });
    const cancelAllIntent = intent({
      actionType: "cancel_all",
      marketIndex: null,
      providerOrderId: null,
      providerSnapshotJson: { orders: [lifecycleSnapshot(openOrder), lifecycleSnapshot(secondOrder)], orderCount: 2 },
    });
    await expect(executeApprovedLighterCancelAll(cancelAllIntent, dependencies)).rejects.toThrow(
      "active-order set changed",
    );
    expect(dependencies.nonceState.reserveObservedWith).not.toHaveBeenCalled();
    expect(dependencies.client.sendTx).not.toHaveBeenCalled();
  });
});

describe("Lighter reduce-only position close lifecycle", () => {
  const market = {
    symbol: "ETH",
    market_id: 0,
    market_type: "perp" as const,
    base_asset_id: 1,
    quote_asset_id: 3,
    status: "active" as const,
    taker_fee: "0.00045",
    maker_fee: "0.00010",
    liquidation_fee: "0.005",
    min_base_amount: "0.0001",
    min_quote_amount: "10",
    supported_size_decimals: 4,
    supported_price_decimals: 2,
    supported_quote_decimals: 6,
    order_quote_limit: "1000000",
    is_maker_fee_enabled: true,
    is_taker_fee_enabled: true,
  };
  const bid = {
    order_index: 1,
    order_id: "281474976710657",
    owner_account_index: 99,
    initial_base_amount: "2.0000",
    remaining_base_amount: "2.0000",
    price: "50.00",
    order_expiry: 0,
    transaction_time: NOW,
  };

  it("prepares an exact full-size reduce-only IOC close within explicit slippage", async () => {
    const result = await prepareLighterClosePosition({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketIndex: 0,
      maxSlippageBps: 100,
      client: {
        getAccount: vi.fn().mockResolvedValue({ code: 200, accounts: [{ index: 42, positions: [longPosition] }] }),
        getMarkets: vi.fn().mockResolvedValue({ code: 200, order_books: [market] }),
        getOrderBookOrders: vi.fn().mockResolvedValue({ code: 200, total_asks: 0, asks: [], total_bids: 1, bids: [bid] }),
      },
    });
    expect(result).toMatchObject({
      closingSide: "sell",
      baseAmount: "1",
      baseAmountInteger: "10000",
      worstAcceptablePrice: "49.5",
      priceInteger: "4950",
      maxSlippageBps: 100,
    });
    expect(result.matchHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to prepare when visible depth cannot close the full position", async () => {
    await expect(prepareLighterClosePosition({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketIndex: 0,
      maxSlippageBps: 100,
      client: {
        getAccount: vi.fn().mockResolvedValue({ code: 200, accounts: [{ index: 42, positions: [longPosition] }] }),
        getMarkets: vi.fn().mockResolvedValue({ code: 200, order_books: [market] }),
        getOrderBookOrders: vi.fn().mockResolvedValue({
          code: 200, total_asks: 0, asks: [], total_bids: 1,
          bids: [{ ...bid, remaining_base_amount: "0.5000" }],
        }),
      },
    })).rejects.toThrow("cannot close the full position");
  });

  it.each([
    {
      name: "the position is absent",
      positions: [],
      message: "This position is no longer shown on Lighter or could not be identified safely.",
    },
    {
      name: "the position is flat",
      positions: [{ ...longPosition, position: "0.0000", sign: 0 }],
      message: "This position appears to be closed, or Lighter returned a size Vex cannot verify.",
    },
    {
      name: "the direction is invalid",
      positions: [{ ...longPosition, sign: 0 }],
      message: "Lighter did not confirm whether this position is long or short.",
    },
  ])("explains why $name cannot be closed again", async ({ positions, message }) => {
    await expect(prepareLighterClosePosition({
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      marketIndex: 0,
      maxSlippageBps: 100,
      client: {
        getAccount: vi.fn().mockResolvedValue({ code: 200, accounts: [{ index: 42, positions }] }),
        getMarkets: vi.fn().mockResolvedValue({ code: 200, order_books: [market] }),
        getOrderBookOrders: vi.fn().mockResolvedValue({ code: 200, total_asks: 0, asks: [], total_bids: 1, bids: [bid] }),
      },
    })).rejects.toThrow(`${message} Refresh Positions and check the current Lighter account before trying again. No close order was placed.`);
  });

  it.each([
    { name: "flat immediately", filled: "1.0000", position: "0.0000", lag: false, status: "closed" },
    { name: "flat after a lagging account response", filled: "1.0000", position: "0.0000", lag: true, status: "closed" },
    { name: "position never catches up", filled: "1.0000", position: "1.0000", lag: false, status: "sequencer_pending" },
    { name: "confirmed partial reduction", filled: "0.4000", position: "0.6000", lag: false, status: "partially_closed" },
    { name: "terminal order with no fill", filled: "0.0000", position: "1.0000", lag: false, status: "not_closed" },
  ])("submits once and reports $name accurately", async (scenario) => {
    const dependencies = deps();
    const matchHash = "d".repeat(64);
    const clientOrderId = deriveVexAssignedClientOrderIndex(matchHash);
    const closeOrder: LighterAccountOrder = {
      ...openOrder,
      order_id: "281474976710658",
      client_order_id: clientOrderId,
      client_order_index: Number(clientOrderId),
      initial_base_amount: "1.0000",
      remaining_base_amount: "0.0000",
      filled_base_amount: scenario.filled,
      filled_quote_amount: scenario.filled === "1.0000" ? "49.75" : scenario.filled === "0.4000" ? "19.90" : "0",
      price: "49.50",
      side: "sell",
      type: "market",
      time_in_force: "immediate-or-cancel",
      reduce_only: true,
      status: scenario.filled === "1.0000" ? "filled" : "canceled",
    };
    Object.assign(dependencies.client, {
      getAccount: vi.fn()
        .mockResolvedValueOnce({
          code: 200,
          accounts: [{
            index: 42,
            positions: [{
              ...longPosition,
              position_value: "50.250000",
              unrealized_pnl: "5.250000",
              liquidation_price: "30.01",
            }],
          }],
        })
        .mockResolvedValueOnce({ code: 200, accounts: [{ index: 42, positions: [{ ...longPosition, position: scenario.lag ? "1.0000" : scenario.position }] }] })
        .mockResolvedValue({ code: 200, accounts: [{ index: 42, positions: [{ ...longPosition, position: scenario.position }] }] }),
      getMarkets: vi.fn().mockResolvedValue({ code: 200, order_books: [market] }),
      getOrderBookOrders: vi.fn().mockResolvedValue({ code: 200, total_asks: 0, asks: [], total_bids: 1, bids: [bid] }),
      getAccountTrades: vi.fn().mockResolvedValue({ code: 200, trades: [] }),
    });
    vi.mocked(dependencies.client.getAccountInactiveOrders).mockResolvedValue({ code: 200, orders: [closeOrder] });
    vi.mocked(dependencies.client.sendTx).mockResolvedValue({
      code: 200, tx_hash: "hash-14", predicted_execution_time_ms: 100, volume_quota_remaining: 99,
    });
    vi.mocked(dependencies.authSigner.signCreateOrder).mockImplementation(async (input) => ({
        kind: "lighter_create_order_signer_result",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      nonce: "9",
      clientOrderIndex: input.order.clientOrderIndex,
      matchHash: input.order.matchHash,
      txType: 14,
      txInfo: "signed-close",
      txHash: "hash-14",
    }));
    const closeIntent = intent({
      actionType: "close_position",
      matchHash,
      marketIndex: 0,
      providerOrderId: null,
      requestedBaseAmountInteger: "10000",
      requestedPriceInteger: "4950",
      requestedSide: "sell",
      reduceOnly: true,
      providerSnapshotJson: {
        position: {
          marketIndex: 0, symbol: "ETH", sign: 1, side: "long", position: "1.0000",
          averageEntryPrice: "45.00", positionValue: "50.000000", unrealizedPnl: "5.000000",
          liquidationPrice: "30.00",
        },
        marketSizeDecimals: 4,
        marketPriceDecimals: 2,
        maxSlippageBps: 100,
      },
    });
    const result = await executeApprovedLighterClosePosition(closeIntent, dependencies);
    expect(result).toMatchObject({
      status: scenario.status,
      executedAmount: scenario.filled,
      remainingOrderAmount: "0.0000",
      averageFillPrice: scenario.filled === "0.0000" ? null : "49.75",
    });
    if (scenario.status === "sequencer_pending") {
      expect(result).not.toHaveProperty("resultingPosition");
      expect(dependencies.intents.markProviderOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ state: "completed" }));
    } else {
      expect(result).toMatchObject({
        clientOrderId,
        providerOrderId: "281474976710658",
        resultingPosition: scenario.status === "closed" ? null : expect.objectContaining({ position: scenario.position }),
      });
    }
    for (const call of vi.mocked(dependencies.client.getAccount).mock.calls.slice(1)) {
      expect(call[2]).toEqual({ fresh: true });
    }
    if (scenario.lag) expect(dependencies.wait).toHaveBeenCalled();
    expect(dependencies.authSigner.signCreateOrder).toHaveBeenCalledWith(expect.objectContaining({
      order: expect.objectContaining({
        orderTypeCode: 1,
        timeInForceCode: 0,
        reduceOnly: true,
        isAsk: true,
        baseAmountInteger: "10000",
        priceInteger: "4950",
      }),
    }));
    expect(dependencies.intents.markSigned).toHaveBeenCalledWith(expect.objectContaining({
      signerExpiryMs: null,
    }));
    expect(dependencies.client.sendTx).toHaveBeenCalledTimes(1);
  });

  it("terminalizes a true position-size drift before nonce reservation or signing", async () => {
    const dependencies = deps();
    Object.assign(dependencies.client, {
      getAccount: vi.fn().mockResolvedValue({
        code: 200,
        accounts: [{ index: 42, positions: [{ ...longPosition, position: "0.9000" }] }],
      }),
      getMarkets: vi.fn().mockResolvedValue({ code: 200, order_books: [market] }),
      getOrderBookOrders: vi.fn().mockResolvedValue({
        code: 200, total_asks: 0, asks: [], total_bids: 1, bids: [bid],
      }),
    });
    const closeIntent = intent({
      actionType: "close_position",
      marketIndex: 0,
      providerOrderId: null,
      requestedBaseAmountInteger: "10000",
      requestedPriceInteger: "4950",
      requestedSide: "sell",
      reduceOnly: true,
      providerSnapshotJson: {
        position: {
          marketIndex: 0, symbol: "ETH", sign: 1, side: "long", position: "1.0000",
          averageEntryPrice: "45.00", positionValue: "50.000000", unrealizedPnl: "5.000000",
          liquidationPrice: "30.00",
        },
        marketSizeDecimals: 4,
        marketPriceDecimals: 2,
        maxSlippageBps: 100,
      },
    });

    await expect(executeApprovedLighterClosePosition(closeIntent, dependencies))
      .rejects.toThrow("No lifecycle transaction was signed or submitted");

    expect(dependencies.intents.markClosePositionChangedBeforeSubmissionWith).toHaveBeenCalledWith(
      expect.anything(),
      { intentId: closeIntent.intentId, sessionId: closeIntent.sessionId },
    );
    expect(dependencies.acquireSessionControlLock).toHaveBeenCalledWith(
      expect.anything(),
      closeIntent.sessionId,
    );
    expect(dependencies.intents.markPreSubmitRevalidated).not.toHaveBeenCalled();
    expect(dependencies.nonceState.reserveObservedWith).not.toHaveBeenCalled();
    expect(dependencies.authSigner.signCreateOrder).not.toHaveBeenCalled();
    expect(dependencies.client.sendTx).not.toHaveBeenCalled();
  });

  it("retires the revalidated close and never wedges it when the live nonce is still blocked", async () => {
    const dependencies = deps();
    Object.assign(dependencies.client, {
      getAccount: vi.fn().mockResolvedValue({
        code: 200,
        accounts: [{ index: 42, positions: [{ ...longPosition, position: "1.0000" }] }],
      }),
      getMarkets: vi.fn().mockResolvedValue({ code: 200, order_books: [market] }),
      getOrderBookOrders: vi.fn().mockResolvedValue({
        code: 200, total_asks: 0, asks: [], total_bids: 1, bids: [bid],
      }),
      getAccountTrades: vi.fn().mockResolvedValue({ code: 200, trades: [] }),
    });
    // A prior action's reservation still owns the slot: the observe cannot
    // advance, and one recovery pass at the commit point does not free it.
    vi.mocked(dependencies.nonceState.recordExecutionObserved).mockResolvedValue(null);
    const recoverNonce = vi.fn(async () => ({}));
    Object.assign(dependencies, { recoverNonce });
    const closeIntent = intent({
      actionType: "close_position",
      marketIndex: 0,
      providerOrderId: null,
      requestedBaseAmountInteger: "10000",
      requestedPriceInteger: "4950",
      requestedSide: "sell",
      reduceOnly: true,
      providerSnapshotJson: {
        position: {
          marketIndex: 0, symbol: "ETH", sign: 1, side: "long", position: "1.0000",
          averageEntryPrice: "45.00", positionValue: "50.000000", unrealizedPnl: "5.000000",
          liquidationPrice: "30.00",
        },
        marketSizeDecimals: 4,
        marketPriceDecimals: 2,
        maxSlippageBps: 100,
      },
    });

    await expect(executeApprovedLighterClosePosition(closeIntent, dependencies))
      .rejects.toThrow(/has been retired/);

    // It revalidated, tried recovery once, then bailed on the blocked nonce,
    // retiring itself so the next prepare is not refused with "already exists".
    expect(dependencies.intents.markPreSubmitRevalidated).toHaveBeenCalled();
    expect(recoverNonce).toHaveBeenCalledTimes(1);
    expect(recoverNonce).toHaveBeenCalledWith({ environment: closeIntent.environment, accountIndex: closeIntent.accountIndex });
    expect(dependencies.nonceState.recordExecutionObserved).toHaveBeenCalledTimes(2);
    expect(dependencies.intents.abandonRevalidatedBeforeNonce).toHaveBeenCalledWith({
      intentId: closeIntent.intentId,
      sessionId: closeIntent.sessionId,
    });
    expect(dependencies.nonceState.reserveObservedWith).not.toHaveBeenCalled();
    expect(dependencies.authSigner.signCreateOrder).not.toHaveBeenCalled();
    expect(dependencies.client.sendTx).not.toHaveBeenCalled();
  });

  it("clears a stale earlier reservation at execute and goes on to reserve instead of retiring the close", async () => {
    const dependencies = deps();
    Object.assign(dependencies.client, {
      getAccount: vi.fn().mockResolvedValue({
        code: 200,
        accounts: [{ index: 42, positions: [{ ...longPosition, position: "1.0000" }] }],
      }),
      getMarkets: vi.fn().mockResolvedValue({ code: 200, order_books: [market] }),
      getOrderBookOrders: vi.fn().mockResolvedValue({
        code: 200, total_asks: 0, asks: [], total_bids: 1, bids: [bid],
      }),
      getAccountTrades: vi.fn().mockResolvedValue({ code: 200, trades: [] }),
    });
    // A prior action's stale reservation owns the slot until recovery releases it.
    let released = false;
    Object.assign(dependencies.nonceState, {
      recordExecutionObserved: vi.fn(async () => (released ? { status: "observed" } : null)),
    });
    const recoverNonce = vi.fn(async () => { released = true; return {}; });
    const closeIntent = intent({
      actionType: "close_position",
      marketIndex: 0,
      providerOrderId: null,
      requestedBaseAmountInteger: "10000",
      requestedPriceInteger: "4950",
      requestedSide: "sell",
      reduceOnly: true,
      providerSnapshotJson: {
        position: {
          marketIndex: 0, symbol: "ETH", sign: 1, side: "long", position: "1.0000",
          averageEntryPrice: "45.00", positionValue: "50.000000", unrealizedPnl: "5.000000",
          liquidationPrice: "30.00",
        },
        marketSizeDecimals: 4,
        marketPriceDecimals: 2,
        maxSlippageBps: 100,
      },
    });

    await executeApprovedLighterClosePosition(closeIntent, { ...dependencies, recoverNonce }).catch(() => undefined);

    expect(recoverNonce).toHaveBeenCalledWith({ environment: closeIntent.environment, accountIndex: closeIntent.accountIndex });
    expect(dependencies.intents.abandonRevalidatedBeforeNonce).not.toHaveBeenCalled();
    expect(dependencies.nonceState.reserveObservedWith).toHaveBeenCalled();
  });
  for (const kind of ["expiry", "cancellation"] as const) {
    it.each(["signing", "staging", "send-admission"] as const)(`close refuses ${kind} during %s`, async (phase) => {
      const dependencies = deps(), controller = new AbortController(), matchHash = "d".repeat(64);
      let nowMs = NOW, entered!: () => void, finish!: () => void;
      Object.assign(dependencies, { now: () => nowMs });
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      const pause = async () => { entered(); await pending; };
      Object.assign(dependencies.client, {
        getAccount: vi.fn(async () => ({ code: 200, accounts: [{ index: 42, positions: [longPosition] }] })),
        getMarkets: vi.fn(async () => ({ code: 200, order_books: [market] })),
        getOrderBookOrders: vi.fn(async () => ({ code: 200, total_asks: 0, asks: [], total_bids: 1, bids: [bid] })),
        getAccountActiveOrders: vi.fn(async () => ({ code: 200, orders: [] })),
        getAccountInactiveOrders: vi.fn(async () => ({ code: 200, orders: [] })),
        getAccountTrades: vi.fn(async () => ({ code: 200, trades: [] })),
      });
    vi.mocked(dependencies.authSigner.signCreateOrder).mockImplementation(async (input) => {
      if (phase === "signing") await pause();
      return {
        kind: "lighter_create_order_signer_result",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      nonce: "9",
      clientOrderIndex: input.order.clientOrderIndex,
      matchHash: input.order.matchHash,
      txType: 14,
      txInfo: "signed-close",
      txHash: "hash-14",
      };
    });
    const closeIntent = intent({
      actionType: "close_position",
      matchHash,
      marketIndex: 0,
      providerOrderId: null,
      requestedBaseAmountInteger: "10000",
      requestedPriceInteger: "4950",
      requestedSide: "sell",
      reduceOnly: true,
      providerSnapshotJson: {
        position: {
          marketIndex: 0, symbol: "ETH", sign: 1, side: "long", position: "1.0000",
          averageEntryPrice: "45.00", positionValue: "50.000000", unrealizedPnl: "5.000000",
          liquidationPrice: "30.00",
        },
        marketSizeDecimals: 4,
        marketPriceDecimals: 2,
        maxSlippageBps: 100,
      },
    });
      if (phase === "staging") vi.mocked(dependencies.intents.markSubmissionStaged).mockImplementation(async () => { await pause(); return {}; });
      if (phase === "send-admission") vi.mocked(dependencies.intents.markSendAttemptStarted).mockImplementation(async () => { await pause(); return true; });
      const execution = executeApprovedLighterClosePosition(closeIntent, dependencies, controller.signal);
      const rejected = expect(execution).rejects.toMatchObject({ reason: expect.stringMatching(kind === "expiry" ? /^consent_expired_/ : /^cancelled_/) });
      await reached;
      if (kind === "expiry") nowMs = Date.parse(closeIntent.expiresAt); else controller.abort("lock");
      finish(); await rejected;
      expect(dependencies.client.sendTx).not.toHaveBeenCalled();
      expect(dependencies.authSigner.signCreateOrder).toHaveBeenCalledOnce();
      expect(dependencies.intents.markSigned).toHaveBeenCalledOnce();
      if (phase === "send-admission") expect(dependencies.intents.markExpiredUnsubmitted).not.toHaveBeenCalled();
      else expect(dependencies.intents.markExpiredUnsubmitted).toHaveBeenCalledOnce();
    });
  }

});

describe("lifecycle consent boundaries", () => {
  const executors = [executeApprovedLighterCancelOne, executeApprovedLighterModifyOrder, executeApprovedLighterCancelAll, executeApprovedLighterClosePosition];
  it.each(executors)("refuses an already cancelled dispatch before reserving", async (execute) => {
    const d = deps(), controller = new AbortController(); controller.abort("lock");
    await expect(execute(intent(), d, controller.signal)).rejects.toMatchObject({ reason: "cancelled_before_reservation" });
    expect(d.nonceState.reserveObservedWith).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });
  for (const action of ["cancel_one", "modify", "cancel_all"] as const) {
    it.each(["signing", "staging", "send-admission"] as const)(`${action} refuses cancellation at %s`, async (phase) => {
      const d = deps(), controller = new AbortController();
      let entered!: () => void, finish!: () => void;
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      const pause = async () => { entered(); await pending; };
      const approved = intent(action === "modify" ? {
        actionType: action, requestedBaseAmountInteger: "7500", requestedPriceInteger: "5125",
        providerSnapshotJson: { ...lifecycleSnapshot(openOrder), marketSizeDecimals: 4, marketPriceDecimals: 2 },
      } : action === "cancel_all" ? {
        actionType: action, marketIndex: null, providerOrderId: null,
        providerSnapshotJson: { orders: [lifecycleSnapshot(openOrder)], orderCount: 1 },
      } : {});
      const execute = action === "modify" ? executeApprovedLighterModifyOrder : action === "cancel_all" ? executeApprovedLighterCancelAll : executeApprovedLighterCancelOne;
      const method = action === "modify" ? "signModifyOrder" : action === "cancel_all" ? "signCancelAllOrders" : "signCancelOrder";
      const original = d.lifecycleSigner[method];
      const signed = lifecycleSignerResult(action);
      vi.mocked(original).mockClear();
      vi.mocked(original).mockImplementation(async () => { if (phase === "signing") await pause(); return signed; });
      if (phase === "staging") {
        vi.mocked(d.intents.markSubmissionStaged).mockImplementation(async () => { await pause(); return intent({ executionState: "submission_staged" }); });
      } else if (phase === "send-admission") {
        vi.mocked(d.intents.markSendAttemptStarted).mockImplementation(async () => { await pause(); return true; });
      }
      const execution = execute(approved, d, controller.signal);
      const rejected = expect(execution).rejects.toMatchObject({ reason: expect.stringMatching(/^cancelled_/) });
      await reached; controller.abort("lock"); finish(); await rejected;
      expect(d.client.sendTx).not.toHaveBeenCalled();
      expect(original).toHaveBeenCalledOnce();
      expect(d.intents.markSigned).toHaveBeenCalledOnce();
      if (phase === "send-admission") {
        expect(d.nonceState.releaseUnsubmittedReservation).not.toHaveBeenCalled();
        expect(d.intents.markExpiredUnsubmitted).not.toHaveBeenCalled();
      } else expect(d.nonceState.releaseUnsubmittedReservation).toHaveBeenCalledOnce();
    });
  }
});


/**
 * THE SIGNER SETTLEMENT CONTRACT for the lifecycle actions, proved in
 * composition (round-1 fix F2): the real lifecycle adapter projects a real
 * `runLighterSignerBinary` run over a scripted child, and the executor decides
 * the reserved nonce's fate on that evidence and nothing else.
 *
 * `close_position` signs through the create-order adapter, whose identical
 * contract is proved in `lighter-order-create-execution.test.ts`.
 */
describe("Lighter lifecycle signer settlement contract", () => {
  const ACTIONS = ["cancel_one", "modify", "cancel_all"] as const;

  function approvedIntent(action: typeof ACTIONS[number]): LighterOrderLifecycleIntentRow {
    return intent(action === "modify" ? {
      actionType: action, requestedBaseAmountInteger: "7500", requestedPriceInteger: "5125",
      providerSnapshotJson: { ...lifecycleSnapshot(openOrder), marketSizeDecimals: 4, marketPriceDecimals: 2 },
    } : action === "cancel_all" ? {
      actionType: action, marketIndex: null, providerOrderId: null,
      providerSnapshotJson: { orders: [lifecycleSnapshot(openOrder)], orderCount: 1 },
    } : {});
  }

  function executorFor(action: typeof ACTIONS[number]) {
    return action === "modify"
      ? executeApprovedLighterModifyOrder
      : action === "cancel_all" ? executeApprovedLighterCancelAll : executeApprovedLighterCancelOne;
  }

  function compositionDeps(signRunner: LighterSignerBinaryRunner): LighterOrderLifecycleExecutionDeps {
    return deps({
      lifecycleSigner: createLighterOrderLifecycleSignerBinary({
        binaryPath: "/tmp/vex-lighter-signer-test",
        // Small enough that a child which never closes is killed inside the test.
        timeoutMs: 5,
        runner: signRunner,
      }),
    });
  }

  it.each(ACTIONS)("retires a %s signed before consent expiry and releases its nonce", async (action) => {
    let nowMs = NOW;
    const approved = approvedIntent(action);
    const d = compositionDeps(signerRunnerEmitting(() => {
      nowMs = Date.parse(approved.expiresAt);
      return { ok: true, ...LIFECYCLE_SIGNER_TX[action] };
    }));
    Object.assign(d, { now: () => nowMs });

    await expect(executorFor(action)(approved, d))
      .rejects.toMatchObject({ reason: expect.stringMatching(/^consent_expired_/) });

    expect(d.intents.markExpiredUnsubmitted).toHaveBeenCalledWith(expect.objectContaining({
      signerTxHash: LIFECYCLE_SIGNER_TX[action].txHash,
    }));
    expect(d.nonceState.releaseUnsubmittedReservation).toHaveBeenCalledOnce();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it.each(ACTIONS)("releases the %s nonce when the signer child provably exited without signing", async (action) => {
    const d = compositionDeps(signerRunnerExitingWithoutOutput());

    await expect(executorFor(action)(approvedIntent(action), d)).rejects.toThrow();

    expect(d.intents.markUnsubmittedRefused).toHaveBeenCalledWith(expect.objectContaining({
      reason: "pre_sign_refused",
    }));
    expect(d.nonceState.releaseUnsubmittedReservation).toHaveBeenCalledOnce();
    expect(d.intents.markAmbiguous).not.toHaveBeenCalled();
  });

  it("releases the modify capital commitment on both unsubmitted exits", async () => {
    ledger.retired.length = 0;
    ledger.settled.length = 0;
    let nowMs = NOW;
    const expiring = approvedIntent("modify");
    const expired = compositionDeps(signerRunnerEmitting(() => {
      nowMs = Date.parse(expiring.expiresAt);
      return { ok: true, ...LIFECYCLE_SIGNER_TX.modify };
    }));
    Object.assign(expired, { now: () => nowMs });
    await expect(executeApprovedLighterModifyOrder(expiring, expired)).rejects.toThrow();

    const refusing = approvedIntent("modify");
    await expect(executeApprovedLighterModifyOrder(
      refusing,
      compositionDeps(signerRunnerExitingWithoutOutput()),
    )).rejects.toThrow();

    // Neither transition ever sent bytes, so the margin delta is released at
    // once instead of waiting out the ledger's observation lag.
    expect(ledger.retired).toEqual([
      { intentId: expiring.intentId, reason: "expired_unsubmitted" },
      { intentId: refusing.intentId, reason: "refused_unsubmitted" },
    ]);
    // Nothing settled at the provider, so nothing was stamped.
    expect(ledger.settled).toEqual([]);
  });

  it.each([
    ["a child that never closed", signerRunnerNeverClosing],
    ["a failure that never reached the child", signerRunnerRejectingWithoutEvidence],
  ])("keeps the cancel nonce reserved after %s", async (_name, runner) => {
    const d = compositionDeps(runner());

    await expect(executeApprovedLighterCancelOne(approvedIntent("cancel_one"), d)).rejects.toThrow();

    expect(d.intents.markAmbiguous).toHaveBeenCalledOnce();
    expect(d.nonceState.releaseUnsubmittedReservation).not.toHaveBeenCalled();
    expect(d.intents.markUnsubmittedRefused).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// LIGHTER_LIFECYCLE_PARALLEL_READS. OFF is today's sequential path; ON must
// refuse, write, sign and send exactly what OFF does, in every case below.
// ---------------------------------------------------------------------------

import { ErrorCodes, VexError } from "../../../errors.js";
import logger from "@utils/logger.js";
import type { LighterClient } from "@tools/lighter/client.js";
import type {
  LighterAccountLimitsResponse,
  LighterApprovedIntegrator,
  LighterSystemConfigResponse,
} from "@tools/lighter/types.js";
import { LighterIntentRefusal } from "@vex-agent/tools/protocols/lighter/intent-expiry.js";
import {
  LIGHTER_LIFECYCLE_PARALLEL_READS,
  lifecycleRead,
  prefetchLighterLifecycleFeeReads,
} from "@vex-agent/tools/protocols/lighter/lifecycle-parallel-reads.js";
import { requireValue } from "../../helpers/require-value.js";
import {
  beginLighterDeskPreparationFees,
  configureLighterDeskPreparationFeeDeps,
  LIGHTER_DESK_PREPARATION_FEE_SNAPSHOT,
} from "@vex-agent/tools/protocols/lighter/desk-preparation-fees.js";
import { configureLighterReadOnlyAccountAuthResolver } from "@vex-agent/tools/protocols/lighter/read-account-auth.js";
import { configureLighterOrderPreviewDeps } from "@vex-agent/tools/protocols/lighter/preview-snapshot.js";
import {
  clearLighterDeskPrewarm,
  LIGHTER_DESK_PREWARM_ACCOUNT_LIMITS_MAX_AGE_MS,
  LIGHTER_DESK_PREWARM_FEE_CONFIG_MAX_AGE_MS,
  recordLighterDeskPrewarmAccountLimits,
  recordLighterDeskPrewarmFeeConfig,
  takeLighterDeskPrewarmAccountLimits,
  takeLighterDeskPrewarmFeeConfig,
} from "@vex-agent/tools/protocols/lighter/desk-prewarm.js";

type LifecycleAction = "cancel_one" | "modify" | "cancel_all" | "close_position";
type LifecycleExecutor = (
  intent: LighterOrderLifecycleIntentRow,
  deps: LighterOrderLifecycleExecutionDeps,
  abortSignal?: AbortSignal,
  sessionWallet?: import("@vex-agent/tools/protocols/lighter/signing-ownership.js").LighterSigningOwnershipWallet,
) => Promise<unknown>;

const LIFECYCLE_EXECUTORS: Record<LifecycleAction, LifecycleExecutor> = {
  cancel_one: executeApprovedLighterCancelOne,
  modify: executeApprovedLighterModifyOrder,
  cancel_all: executeApprovedLighterCancelAll,
  close_position: executeApprovedLighterClosePosition,
};

const FEE_WALLET = `0x${"1".repeat(40)}`;
const FEE_POLICY = requireValue(feePolicy.resolveLighterFeePolicy("rhc", { enabled: true, accountIndex: 99, l1Address: FEE_WALLET }));
const PERP_FEES = feePolicy.getLighterIntegratorFees(FEE_POLICY, "perp");
const FEE_INTEGRATORS: LighterApprovedIntegrator[] = [{
  account_index: 99, name: "VEX", max_perps_maker_fee: 1000, max_perps_taker_fee: 1000,
  max_spot_maker_fee: 2500, max_spot_taker_fee: 2500, approval_expiry: Date.parse("2100-01-01T00:00:00.000Z"),
}];
const FEE_SYSTEM_CONFIG: LighterSystemConfigResponse = {
  code: 200, liquidity_pool_index: 0, staking_pool_index: 0, funding_fee_rebate_account_index: 0,
  market_maker_incentive_account_index: 0, liquidity_pool_cooldown_period: 0, staking_pool_lockup_period: 0,
  max_integrator_perps_maker_fee: 1000, max_integrator_perps_taker_fee: 1000,
  max_integrator_spot_maker_fee: 10_000, max_integrator_spot_taker_fee: 10_000,
};
const FEE_LIMITS: LighterAccountLimitsResponse = {
  code: 200, user_tier: "plus", user_tier_name: "Plus", current_maker_fee_tick: 50, current_taker_fee_tick: 50,
};
const OFFLINE = (message: string) => new VexError(ErrorCodes.LIGHTER_TIMEOUT, message);

function rejectAfter(error: unknown, delayMs: number): () => Promise<never> {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    throw error;
  };
}

function resolveAfter<T>(value: T, delayMs: number): () => Promise<T> {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return value;
  };
}

function rejectNow(error: unknown): () => Promise<never> {
  return async () => { throw error; };
}

/** One account read for every caller: the collector, the trader before the send, and the trader after it. */
function accountReads(input: {
  readonly positions?: () => LighterAccountPosition[];
  readonly integrators?: LighterApprovedIntegrator[];
} = {}) {
  return vi.fn<LighterClient["getAccount"]>(async (_environment, params) => {
    if (String(params.value) === "99") {
      return { code: 200, total: 1, accounts: [{ index: 99, status: 1, l1_address: FEE_WALLET }] };
    }
    return {
      code: 200,
      total: 1,
      accounts: [{
        index: 42,
        l1_address: "0x1111111111111111111111111111111111111111",
        collateral: "1000",
        available_balance: "900",
        cross_initial_margin_requirement: "0.000000",
        positions: input.positions?.() ?? [],
        approved_integrators: input.integrators ?? FEE_INTEGRATORS,
      }],
    };
  });
}

/** Fee collection ON for this environment, with a live, fully authorized fee setup. */
function withFees(d: LighterOrderLifecycleExecutionDeps): void {
  vi.mocked(feePolicy.getLighterFeePolicy).mockReturnValue(FEE_POLICY);
  Object.assign(d.client, {
    getSystemConfig: vi.fn<LighterClient["getSystemConfig"]>(async () => FEE_SYSTEM_CONFIG),
    getAccountLimits: vi.fn<LighterClient["getAccountLimits"]>(async () => FEE_LIMITS),
  });
}

interface LifecycleScenario {
  readonly intent: LighterOrderLifecycleIntentRow;
  readonly deps: LighterOrderLifecycleExecutionDeps;
}

function cancelOneScenario(): LifecycleScenario {
  return { intent: intent(), deps: deps() };
}

const MODIFIED_ORDER: LighterAccountOrder = {
  ...openOrder, initial_base_amount: "0.75", remaining_base_amount: "0.25", price: "51.25",
};

function modifyScenario(options: { readonly fees?: boolean } = {}): LifecycleScenario {
  const d = deps();
  vi.mocked(d.client.getAccountActiveOrders)
    .mockReset()
    .mockResolvedValueOnce({ code: 200, orders: [openOrder] })
    .mockResolvedValue({ code: 200, orders: [MODIFIED_ORDER] });
  vi.mocked(d.client.getAccountInactiveOrders).mockResolvedValue({ code: 200, orders: [] });
  vi.mocked(d.client.sendTx).mockResolvedValue({
    code: 200, tx_hash: "hash-17", predicted_execution_time_ms: 100, volume_quota_remaining: 99,
  });
  Object.assign(d.client, {
    getAccount: accountReads(),
    getMarkets: vi.fn(async () => ({
      code: 200,
      order_books: [{ market_id: 0, market_type: "perp", status: "active", supported_size_decimals: 4, supported_price_decimals: 2 }],
    })),
  });
  if (options.fees === true) withFees(d);
  return {
    intent: intent({
      actionType: "modify",
      requestedBaseAmountInteger: "7500",
      requestedPriceInteger: "5125",
      providerSnapshotJson: { ...lifecycleSnapshot(openOrder), marketSizeDecimals: 4, marketPriceDecimals: 2 },
      ...(options.fees === true ? { integratorFees: PERP_FEES } : {}),
    }),
    deps: d,
  };
}

const CANCEL_ALL_SECOND_ORDER: LighterAccountOrder = {
  ...openOrder,
  order_id: "281474976710657",
  client_order_id: "124",
  client_order_index: 124,
  market_index: 1,
  initial_base_amount: "2",
  remaining_base_amount: "2",
  filled_base_amount: "0",
  filled_quote_amount: "0",
  price: "25",
};

function cancelAllScenario(): LifecycleScenario {
  const d = deps();
  vi.mocked(d.client.getAccountActiveOrders)
    .mockReset()
    .mockResolvedValueOnce({ code: 200, orders: [CANCEL_ALL_SECOND_ORDER, openOrder] })
    .mockResolvedValue({ code: 200, orders: [] });
  vi.mocked(d.client.getAccountInactiveOrders).mockResolvedValue({
    code: 200,
    orders: [
      { ...openOrder, status: "canceled" },
      { ...CANCEL_ALL_SECOND_ORDER, status: "filled", remaining_base_amount: "0", filled_base_amount: "2", filled_quote_amount: "50" },
    ],
  });
  vi.mocked(d.client.sendTx).mockResolvedValue({
    code: 200, tx_hash: "hash-16", predicted_execution_time_ms: 100, volume_quota_remaining: 99,
  });
  const approvedOrders = [lifecycleSnapshot(openOrder), lifecycleSnapshot(CANCEL_ALL_SECOND_ORDER)];
  return {
    intent: intent({
      actionType: "cancel_all",
      marketIndex: null,
      providerOrderId: null,
      providerSnapshotJson: { orders: approvedOrders, orderCount: approvedOrders.length },
    }),
    deps: d,
  };
}

const CLOSE_MARKET = {
  symbol: "ETH", market_id: 0, market_type: "perp" as const, base_asset_id: 1, quote_asset_id: 3,
  status: "active" as const, taker_fee: "0.00045", maker_fee: "0.00010", liquidation_fee: "0.005",
  min_base_amount: "0.0001", min_quote_amount: "10", supported_size_decimals: 4, supported_price_decimals: 2,
  supported_quote_decimals: 6, order_quote_limit: "1000000", is_maker_fee_enabled: true, is_taker_fee_enabled: true,
};
const CLOSE_BID = {
  order_index: 1, order_id: "281474976710657", owner_account_index: 99, initial_base_amount: "2.0000",
  remaining_base_amount: "2.0000", price: "50.00", order_expiry: 0, transaction_time: NOW,
};
const CLOSE_MATCH_HASH = "d".repeat(64);

function closeScenario(options: { readonly fees?: boolean } = {}): LifecycleScenario {
  const d = deps();
  const clientOrderId = deriveVexAssignedClientOrderIndex(CLOSE_MATCH_HASH);
  const closeOrder: LighterAccountOrder = {
    ...openOrder,
    order_id: "281474976710658",
    client_order_id: clientOrderId,
    client_order_index: Number(clientOrderId),
    initial_base_amount: "1.0000",
    remaining_base_amount: "0.0000",
    filled_base_amount: "1.0000",
    filled_quote_amount: "49.75",
    price: "49.50",
    side: "sell",
    type: "market",
    time_in_force: "immediate-or-cancel",
    reduce_only: true,
    status: "filled",
  };
  let sent = false;
  Object.assign(d.client, {
    getAccount: accountReads({ positions: () => [sent ? { ...longPosition, position: "0.0000" } : longPosition] }),
    getMarkets: vi.fn(async () => ({ code: 200, order_books: [CLOSE_MARKET] })),
    getOrderBookOrders: vi.fn(async () => ({ code: 200, total_asks: 0, asks: [], total_bids: 1, bids: [CLOSE_BID] })),
    getAccountInactiveOrders: vi.fn(async () => ({ code: 200, orders: [closeOrder] })),
    sendTx: vi.fn(async () => {
      sent = true;
      return { code: 200, tx_hash: "hash-14", predicted_execution_time_ms: 100, volume_quota_remaining: 99 };
    }),
  });
  vi.mocked(d.authSigner.signCreateOrder).mockImplementation(async (input) => ({
    kind: "lighter_create_order_signer_result",
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    nonce: "9",
    clientOrderIndex: input.order.clientOrderIndex,
    matchHash: input.order.matchHash,
    txType: 14,
    txInfo: "signed-close",
    txHash: "hash-14",
  }));
  if (options.fees === true) withFees(d);
  return {
    intent: intent({
      actionType: "close_position",
      matchHash: CLOSE_MATCH_HASH,
      marketIndex: 0,
      providerOrderId: null,
      requestedBaseAmountInteger: "10000",
      requestedPriceInteger: "4950",
      requestedSide: "sell",
      reduceOnly: true,
      providerSnapshotJson: {
        position: {
          marketIndex: 0, symbol: "ETH", sign: 1, side: "long", position: "1.0000",
          averageEntryPrice: "45.00", positionValue: "50.000000", unrealizedPnl: "5.000000",
          liquidationPrice: "30.00",
        },
        marketSizeDecimals: 4,
        marketPriceDecimals: 2,
        maxSlippageBps: 100,
      },
      ...(options.fees === true ? { integratorFees: PERP_FEES } : {}),
    }),
    deps: d,
  };
}

/** Build a scenario, then change its client or deps for one case. */
function scenario(
  base: () => LifecycleScenario,
  change: (scenario: LifecycleScenario) => void,
): () => LifecycleScenario {
  return () => {
    const built = base();
    change(built);
    return built;
  };
}

const ROTATED_KEY = { code: 200, api_keys: [{
  account_index: 42, api_key_index: 7, nonce: 9, public_key: "c".repeat(80), transaction_time: NOW,
}] };
const CHANGED_ORDER: LighterAccountOrder = { ...openOrder, remaining_base_amount: "0.4" };

interface LifecycleCase {
  readonly label: string;
  readonly action: LifecycleAction;
  readonly build: () => LifecycleScenario;
  /** The OFF outcome, so each case provably exercises what it names. */
  readonly expected: RegExp;
}

const LIFECYCLE_CASES: readonly LifecycleCase[] = [
  // Cancel one.
  { label: "cancel one succeeds", action: "cancel_one", build: cancelOneScenario, expected: /"status":"canceled"/ },
  {
    label: "cancel one: the order is no longer open", action: "cancel_one", expected: /no longer active and open/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      vi.mocked(d.client.getAccountActiveOrders).mockReset().mockResolvedValue({ code: 200, orders: [] });
    }),
  },
  {
    label: "cancel one: the order changed", action: "cancel_one", expected: /changed before cancel submission/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      vi.mocked(d.client.getAccountActiveOrders).mockReset().mockResolvedValue({ code: 200, orders: [CHANGED_ORDER] });
    }),
  },
  {
    label: "cancel one: the active-order read fails", action: "cancel_one", expected: /active down/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      Object.assign(d.client, { getAccountActiveOrders: vi.fn(rejectNow(new Error("active down"))) });
    }),
  },
  {
    label: "cancel one: Lighter is unreachable on the active-order read", action: "cancel_one", expected: /couldn't reach Lighter before sending/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      Object.assign(d.client, { getAccountActiveOrders: vi.fn(rejectNow(OFFLINE("active timed out"))) });
    }),
  },
  {
    label: "cancel one: the key is no longer registered", action: "cancel_one", expected: /trading credential changed/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      Object.assign(d.client, { getApiKeys: vi.fn(async () => ({ code: 200, api_keys: [] })) });
    }),
  },
  {
    label: "cancel one: the key rotated", action: "cancel_one", expected: /trading credential changed/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      Object.assign(d.client, { getApiKeys: vi.fn(async () => ROTATED_KEY) });
    }),
  },
  {
    label: "cancel one: the key read fails", action: "cancel_one", expected: /keys down/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      Object.assign(d.client, { getApiKeys: vi.fn(rejectNow(new Error("keys down"))) });
    }),
  },
  {
    label: "cancel one: the nonce evidence is inconsistent", action: "cancel_one", expected: /inconsistent nonce evidence/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      Object.assign(d.client, { getNextNonce: vi.fn(async () => ({ code: 200, nonce: 10 })) });
    }),
  },
  {
    label: "cancel one: the nonce read fails", action: "cancel_one", expected: /nonce down/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      Object.assign(d.client, { getNextNonce: vi.fn(rejectNow(new Error("nonce down"))) });
    }),
  },
  {
    label: "cancel one: the order changed while the key and nonce reads failed first", action: "cancel_one",
    expected: /changed before cancel submission/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      Object.assign(d.client, {
        getAccountActiveOrders: vi.fn(resolveAfter({ code: 200, orders: [CHANGED_ORDER] }, 5)),
        getApiKeys: vi.fn(rejectNow(new Error("keys down"))),
        getNextNonce: vi.fn(rejectNow(OFFLINE("nonce timed out"))),
      });
    }),
  },
  {
    label: "cancel one: the key rotated while the nonce read failed first", action: "cancel_one", expected: /trading credential changed/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      Object.assign(d.client, {
        getApiKeys: vi.fn(resolveAfter(ROTATED_KEY, 5)),
        getNextNonce: vi.fn(rejectNow(new Error("nonce down"))),
      });
    }),
  },
  {
    label: "cancel one: the active-order read fails last, after an unreachable key read", action: "cancel_one", expected: /active down/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      Object.assign(d.client, {
        getAccountActiveOrders: vi.fn(rejectAfter(new Error("active down"), 5)),
        getApiKeys: vi.fn(rejectNow(OFFLINE("keys timed out"))),
      });
    }),
  },
  {
    label: "cancel one: revalidation evidence cannot persist", action: "cancel_one", expected: /could not persist revalidation/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      vi.mocked(d.intents.markPreSubmitRevalidated).mockResolvedValue(null);
    }),
  },
  {
    label: "cancel one: an earlier action still holds the nonce", action: "cancel_one", expected: /has been retired/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      vi.mocked(d.nonceState.recordExecutionObserved).mockResolvedValue(null);
      Object.assign(d, { recoverNonce: vi.fn(async () => ({})) });
    }),
  },
  {
    label: "cancel one: the trading key is not in the vault", action: "cancel_one", expected: /not present in the encrypted local vault/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      vi.mocked(d.secretReader.readTradingApiPrivateKey).mockResolvedValue(null);
    }),
  },
  {
    label: "cancel one: the send is ambiguous", action: "cancel_one", expected: /send_tx_transport_ambiguous/,
    build: scenario(cancelOneScenario, ({ deps: d }) => {
      vi.mocked(d.client.sendTx).mockRejectedValue(new Error("timeout"));
    }),
  },

  // Cancel all.
  { label: "cancel all succeeds", action: "cancel_all", build: cancelAllScenario, expected: /"status":"cancel_all_completed"/ },
  {
    label: "cancel all: the active-order set changed", action: "cancel_all", expected: /active-order set changed/,
    build: scenario(cancelAllScenario, ({ deps: d }) => {
      vi.mocked(d.client.getAccountActiveOrders).mockReset().mockResolvedValue({ code: 200, orders: [openOrder] });
    }),
  },
  {
    label: "cancel all: the active-order read fails", action: "cancel_all", expected: /active down/,
    build: scenario(cancelAllScenario, ({ deps: d }) => {
      Object.assign(d.client, { getAccountActiveOrders: vi.fn(rejectNow(new Error("active down"))) });
    }),
  },
  {
    label: "cancel all: the key rotated", action: "cancel_all", expected: /trading credential changed/,
    build: scenario(cancelAllScenario, ({ deps: d }) => {
      Object.assign(d.client, { getApiKeys: vi.fn(async () => ROTATED_KEY) });
    }),
  },
  {
    label: "cancel all: the nonce evidence is inconsistent", action: "cancel_all", expected: /inconsistent nonce evidence/,
    build: scenario(cancelAllScenario, ({ deps: d }) => {
      Object.assign(d.client, { getNextNonce: vi.fn(async () => ({ code: 200, nonce: 10 })) });
    }),
  },
  {
    label: "cancel all: the nonce read fails", action: "cancel_all", expected: /nonce down/,
    build: scenario(cancelAllScenario, ({ deps: d }) => {
      Object.assign(d.client, { getNextNonce: vi.fn(rejectNow(new Error("nonce down"))) });
    }),
  },
  {
    label: "cancel all: the set changed while the key and nonce reads failed first", action: "cancel_all", expected: /active-order set changed/,
    build: scenario(cancelAllScenario, ({ deps: d }) => {
      Object.assign(d.client, {
        getAccountActiveOrders: vi.fn(resolveAfter({ code: 200, orders: [openOrder] }, 5)),
        getApiKeys: vi.fn(rejectNow(new Error("keys down"))),
        getNextNonce: vi.fn(rejectNow(new Error("nonce down"))),
      });
    }),
  },
  {
    label: "cancel all: revalidation evidence cannot persist", action: "cancel_all", expected: /could not persist revalidation/,
    build: scenario(cancelAllScenario, ({ deps: d }) => {
      vi.mocked(d.intents.markPreSubmitRevalidated).mockResolvedValue(null);
    }),
  },

  // Modify.
  { label: "modify succeeds", action: "modify", build: () => modifyScenario(), expected: /"status":"modified"/ },
  { label: "modify succeeds with fees", action: "modify", build: () => modifyScenario({ fees: true }), expected: /"status":"modified"/ },
  {
    label: "modify: the market precision changed", action: "modify", expected: /precision or active status changed/,
    build: scenario(() => modifyScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getMarkets: vi.fn(async () => ({
        code: 200, order_books: [{ market_id: 0, market_type: "perp", status: "active", supported_size_decimals: 3, supported_price_decimals: 2 }],
      })) });
    }),
  },
  {
    label: "modify: the market read fails", action: "modify", expected: /markets down/,
    build: scenario(() => modifyScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getMarkets: vi.fn(rejectNow(new Error("markets down"))) });
    }),
  },
  {
    label: "modify: the market is gone while every later read failed first", action: "modify", expected: /precision or active status changed/,
    build: scenario(() => modifyScenario({ fees: true }), ({ deps: d }) => {
      Object.assign(d.client, {
        getMarkets: vi.fn(resolveAfter({ code: 200, order_books: [] }, 5)),
        getAccountActiveOrders: vi.fn(rejectNow(new Error("active down"))),
        getSystemConfig: vi.fn(rejectNow(OFFLINE("config timed out"))),
        getApiKeys: vi.fn(rejectNow(new Error("keys down"))),
        getNextNonce: vi.fn(rejectNow(new Error("nonce down"))),
      });
    }),
  },
  {
    label: "modify: the order is no longer open", action: "modify", expected: /no longer active and open/,
    build: scenario(() => modifyScenario(), ({ deps: d }) => {
      vi.mocked(d.client.getAccountActiveOrders).mockReset().mockResolvedValue({ code: 200, orders: [] });
    }),
  },
  {
    label: "modify: the order changed while the fee reads failed first", action: "modify", expected: /changed before modify submission/,
    build: scenario(() => modifyScenario({ fees: true }), ({ deps: d }) => {
      Object.assign(d.client, {
        getAccountActiveOrders: vi.fn(resolveAfter({ code: 200, orders: [CHANGED_ORDER] }, 5)),
        getSystemConfig: vi.fn(rejectNow(new Error("config down"))),
        getAccountLimits: vi.fn(rejectNow(OFFLINE("limits timed out"))),
      });
    }),
  },
  {
    label: "modify: the fee authorization is missing", action: "modify", expected: /Lighter fee setup is required/,
    build: scenario(() => modifyScenario({ fees: true }), ({ deps: d }) => {
      Object.assign(d.client, { getAccount: accountReads({ integrators: [] }) });
    }),
  },
  {
    label: "modify: the approved fee terms no longer match", action: "modify", expected: /fee policy or authorization changed/,
    build: scenario(() => modifyScenario({ fees: true }), (built) => {
      Object.assign(built, { intent: { ...built.intent, integratorFees: null } });
    }),
  },
  {
    label: "modify: a fee read fails", action: "modify", expected: /config down/,
    build: scenario(() => modifyScenario({ fees: true }), ({ deps: d }) => {
      Object.assign(d.client, { getSystemConfig: vi.fn(rejectNow(new Error("config down"))) });
    }),
  },
  {
    label: "modify: Lighter is unreachable on a fee read", action: "modify", expected: /couldn't reach Lighter before sending/,
    build: scenario(() => modifyScenario({ fees: true }), ({ deps: d }) => {
      Object.assign(d.client, { getAccountLimits: vi.fn(rejectNow(OFFLINE("limits timed out"))) });
    }),
  },
  {
    label: "modify: a fee read fails last, after the key and nonce reads failed", action: "modify", expected: /config down/,
    build: scenario(() => modifyScenario({ fees: true }), ({ deps: d }) => {
      Object.assign(d.client, {
        getSystemConfig: vi.fn(rejectAfter(new Error("config down"), 5)),
        getApiKeys: vi.fn(rejectNow(OFFLINE("keys timed out"))),
        getNextNonce: vi.fn(rejectNow(new Error("nonce down"))),
      });
    }),
  },
  {
    label: "modify: the key rotated", action: "modify", expected: /trading credential changed/,
    build: scenario(() => modifyScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getApiKeys: vi.fn(async () => ROTATED_KEY) });
    }),
  },
  {
    label: "modify: the nonce evidence is inconsistent", action: "modify", expected: /inconsistent nonce evidence/,
    build: scenario(() => modifyScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getNextNonce: vi.fn(async () => ({ code: 200, nonce: 10 })) });
    }),
  },
  {
    label: "modify: the nonce read fails", action: "modify", expected: /nonce down/,
    build: scenario(() => modifyScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getNextNonce: vi.fn(rejectNow(new Error("nonce down"))) });
    }),
  },
  {
    label: "modify: the capital re-admission cannot see the account", action: "modify", expected: /capital share could not be checked/,
    build: scenario(() => modifyScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getAccount: vi.fn(async () => ({ code: 200, total: 0, accounts: [] })) });
    }),
  },
  {
    label: "modify: the key rotated before a capital re-admission that would refuse", action: "modify", expected: /trading credential changed/,
    build: scenario(() => modifyScenario(), ({ deps: d }) => {
      Object.assign(d.client, {
        getAccount: vi.fn(async () => ({ code: 200, total: 0, accounts: [] })),
        getApiKeys: vi.fn(resolveAfter(ROTATED_KEY, 5)),
      });
    }),
  },

  // Close.
  { label: "close succeeds", action: "close_position", build: () => closeScenario(), expected: /"status":"closed"/ },
  { label: "close succeeds with fees", action: "close_position", build: () => closeScenario({ fees: true }), expected: /"status":"closed"/ },
  {
    label: "close: the account is not unique", action: "close_position", expected: /changed or is unavailable/,
    build: scenario(() => closeScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getAccount: vi.fn(async () => ({
        code: 200, accounts: [{ index: 42, positions: [longPosition] }, { index: 42, positions: [longPosition] }],
      })) });
    }),
  },
  {
    label: "close: the market precision changed", action: "close_position", expected: /close market or precision changed/,
    build: scenario(() => closeScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getMarkets: vi.fn(async () => ({ code: 200, order_books: [{ ...CLOSE_MARKET, supported_price_decimals: 3 }] })) });
    }),
  },
  {
    label: "close: the book read fails", action: "close_position", expected: /book down/,
    build: scenario(() => closeScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getOrderBookOrders: vi.fn(rejectNow(new Error("book down"))) });
    }),
  },
  {
    label: "close: Lighter is unreachable on the batch", action: "close_position", expected: /couldn't reach Lighter before sending/,
    build: scenario(() => closeScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getMarkets: vi.fn(rejectNow(OFFLINE("markets timed out"))) });
    }),
  },
  {
    label: "close: the batch fails last, after every other read failed", action: "close_position", expected: /book down/,
    build: scenario(() => closeScenario({ fees: true }), ({ deps: d }) => {
      Object.assign(d.client, {
        getOrderBookOrders: vi.fn(rejectAfter(new Error("book down"), 5)),
        getSystemConfig: vi.fn(rejectNow(OFFLINE("config timed out"))),
        getApiKeys: vi.fn(rejectNow(new Error("keys down"))),
        getNextNonce: vi.fn(rejectNow(new Error("nonce down"))),
      });
    }),
  },
  {
    label: "close: the position is gone", action: "close_position", expected: /no longer shown on Lighter/,
    build: scenario(() => closeScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getAccount: accountReads({ positions: () => [] }) });
    }),
  },
  {
    label: "close: the position size drifted, recorded durably, while every later read failed first", action: "close_position",
    expected: /position size, side, or entry changed/,
    build: scenario(() => closeScenario({ fees: true }), ({ deps: d }) => {
      Object.assign(d.client, {
        getMarkets: vi.fn(resolveAfter({ code: 200, order_books: [CLOSE_MARKET] }, 5)),
        getAccount: accountReads({ positions: () => [{ ...longPosition, position: "0.9000" }] }),
        getSystemConfig: vi.fn(rejectNow(new Error("config down"))),
        getApiKeys: vi.fn(rejectNow(new Error("keys down"))),
        getNextNonce: vi.fn(rejectNow(OFFLINE("nonce timed out"))),
      });
    }),
  },
  {
    label: "close: the position drift races a concurrent lifecycle transition", action: "close_position",
    expected: /lifecycle state advanced concurrently/,
    build: scenario(() => closeScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getAccount: accountReads({ positions: () => [{ ...longPosition, position: "0.9000" }] }) });
      vi.mocked(d.intents.markClosePositionChangedBeforeSubmissionWith).mockResolvedValue(null);
    }),
  },
  {
    label: "close: the book can no longer close at the approved price", action: "close_position",
    expected: /cannot close the full position at the approved worst price/,
    build: scenario(() => closeScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getOrderBookOrders: vi.fn(async () => ({
        code: 200, total_asks: 0, asks: [], total_bids: 1, bids: [{ ...CLOSE_BID, remaining_base_amount: "0.5000" }],
      })) });
    }),
  },
  {
    label: "close: the fee authorization was revoked", action: "close_position", expected: /fee policy or authorization changed/,
    build: scenario(() => closeScenario({ fees: true }), ({ deps: d }) => {
      Object.assign(d.client, { getAccount: accountReads({ positions: () => [longPosition], integrators: [] }) });
    }),
  },
  {
    label: "close: a fee read fails", action: "close_position", expected: /fee policy or authorization changed/,
    build: scenario(() => closeScenario({ fees: true }), ({ deps: d }) => {
      Object.assign(d.client, { getAccountLimits: vi.fn(rejectNow(new Error("limits down"))) });
    }),
  },
  {
    label: "close: a fee read is unreachable", action: "close_position", expected: /fee policy or authorization changed/,
    build: scenario(() => closeScenario({ fees: true }), ({ deps: d }) => {
      Object.assign(d.client, { getSystemConfig: vi.fn(rejectNow(OFFLINE("config timed out"))) });
    }),
  },
  {
    label: "close: the fee check refuses last, after the nonce read failed", action: "close_position",
    expected: /fee policy or authorization changed/,
    build: scenario(() => closeScenario({ fees: true }), ({ deps: d }) => {
      Object.assign(d.client, {
        getSystemConfig: vi.fn(rejectAfter(new Error("config down"), 5)),
        getNextNonce: vi.fn(rejectNow(new Error("nonce down"))),
      });
    }),
  },
  {
    label: "close: the key rotated", action: "close_position", expected: /trading credential changed/,
    build: scenario(() => closeScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getApiKeys: vi.fn(async () => ROTATED_KEY) });
    }),
  },
  {
    label: "close: the nonce evidence is inconsistent", action: "close_position", expected: /inconsistent nonce evidence/,
    build: scenario(() => closeScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getNextNonce: vi.fn(async () => ({ code: 200, nonce: 10 })) });
    }),
  },
  {
    label: "close: the nonce read fails", action: "close_position", expected: /nonce down/,
    build: scenario(() => closeScenario(), ({ deps: d }) => {
      Object.assign(d.client, { getNextNonce: vi.fn(rejectNow(new Error("nonce down"))) });
    }),
  },
  {
    label: "close: an earlier action still holds the nonce", action: "close_position", expected: /has been retired/,
    build: scenario(() => closeScenario(), ({ deps: d }) => {
      vi.mocked(d.nonceState.recordExecutionObserved).mockResolvedValue(null);
      Object.assign(d, { recoverNonce: vi.fn(async () => ({})) });
    }),
  },
];

function describeLifecycleFailure(error: unknown): Record<string, unknown> {
  if (error instanceof VexError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      hint: error.hint,
      retryable: error.retryable,
      ...(error instanceof LighterIntentRefusal ? { reason: error.reason } : {}),
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

const PROVIDER_READS = [
  "getAccount", "getMarkets", "getOrderBookOrders", "getAccountActiveOrders", "getApiKeys", "getNextNonce",
  "getSystemConfig", "getAccountLimits",
] as const;

interface LifecycleObservation {
  readonly outcome: Record<string, unknown>;
  readonly effects: Record<string, unknown>;
  /** Every provider read before and after the send, by method, in call order. */
  readonly reads: Record<string, string[]>;
}

async function observeLifecycle(
  action: LifecycleAction,
  built: LifecycleScenario,
  lifecycleParallelReads: boolean | "constant",
  ownership?: { readonly enabled: boolean; readonly wallet?: import("@vex-agent/tools/protocols/lighter/signing-ownership.js").LighterSigningOwnershipWallet },
): Promise<LifecycleObservation> {
  ledger.retired.length = 0;
  ledger.settled.length = 0;
  const { lifecycleParallelReads: _pinned, ...unpinned } = built.deps;
  const parallelDeps: LighterOrderLifecycleExecutionDeps = lifecycleParallelReads === "constant"
    ? unpinned
    : { ...unpinned, lifecycleParallelReads };
  const d = ownership === undefined ? parallelDeps : { ...parallelDeps, signingOwnershipRecheck: ownership.enabled };
  let outcome: Record<string, unknown>;
  try {
    outcome = { resolved: await LIFECYCLE_EXECUTORS[action](built.intent, d, undefined, ownership?.wallet) };
  } catch (error) {
    outcome = { rejected: describeLifecycleFailure(error) };
  }
  const client: Record<string, unknown> = d.client;
  const reads: Record<string, string[]> = {};
  for (const method of PROVIDER_READS) {
    const read = client[method];
    if (vi.isMockFunction(read)) reads[method] = read.mock.calls.map((call) => JSON.stringify(call));
  }
  return {
    outcome,
    effects: {
      secretReads: vi.mocked(d.secretReader.readTradingApiPrivateKey).mock.calls,
      authMints: vi.mocked(d.authSigner.createAccountAuth).mock.calls.length,
      markPreSubmitRevalidated: vi.mocked(d.intents.markPreSubmitRevalidated).mock.calls,
      markClosePositionChanged: vi.mocked(d.intents.markClosePositionChangedBeforeSubmissionWith).mock.calls.map((call) => call[1]),
      acquireSessionControlLock: vi.mocked(d.acquireSessionControlLock).mock.calls.map((call) => call[1]),
      abandonRevalidatedBeforeNonce: vi.mocked(d.intents.abandonRevalidatedBeforeNonce).mock.calls,
      recordExecutionObserved: vi.mocked(d.nonceState.recordExecutionObserved).mock.calls,
      reserveObservedWith: vi.mocked(d.nonceState.reserveObservedWith).mock.calls.map((call) => call[1]),
      attachNonceReservationWith: vi.mocked(d.intents.attachNonceReservationWith).mock.calls.map((call) => call[1]),
      signCancelOrder: vi.mocked(d.lifecycleSigner.signCancelOrder).mock.calls,
      signModifyOrder: vi.mocked(d.lifecycleSigner.signModifyOrder).mock.calls,
      signCancelAllOrders: vi.mocked(d.lifecycleSigner.signCancelAllOrders).mock.calls,
      signCreateOrder: vi.mocked(d.authSigner.signCreateOrder).mock.calls,
      markSigned: vi.mocked(d.intents.markSigned).mock.calls,
      markSubmissionStaged: vi.mocked(d.intents.markSubmissionStaged).mock.calls,
      markSendAttemptStarted: vi.mocked(d.intents.markSendAttemptStarted).mock.calls,
      sendTx: vi.mocked(d.client.sendTx).mock.calls,
      markApiAccepted: vi.mocked(d.intents.markApiAccepted).mock.calls,
      markProviderOutcome: vi.mocked(d.intents.markProviderOutcome).mock.calls,
      markAmbiguous: vi.mocked(d.intents.markAmbiguous).mock.calls,
      markUnsubmittedRefused: vi.mocked(d.intents.markUnsubmittedRefused).mock.calls,
      markExpiredUnsubmitted: vi.mocked(d.intents.markExpiredUnsubmitted).mock.calls,
      releaseUnsubmittedReservation: vi.mocked(d.nonceState.releaseUnsubmittedReservation).mock.calls,
      inactiveOrderReads: vi.mocked(d.client.getAccountInactiveOrders).mock.calls,
      capitalRetired: [...ledger.retired],
      capitalSettled: [...ledger.settled],
    },
    reads,
  };
}

/** Every read OFF made, ON made too (ON may add the reads an earlier refusal made moot). */
function expectReadsCovered(off: Record<string, string[]>, on: Record<string, string[]>): void {
  for (const [method, calls] of Object.entries(off)) {
    const remaining = [...(on[method] ?? [])];
    for (const call of calls) {
      const index = remaining.indexOf(call);
      expect(index, `${method} ${call}`).toBeGreaterThanOrEqual(0);
      remaining.splice(index, 1);
    }
  }
}

function createReadGate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

describe("LIGHTER_LIFECYCLE_PARALLEL_READS", () => {
  it("ships ON", () => {
    expect(LIGHTER_LIFECYCLE_PARALLEL_READS).toBe(true);
  });

  it.each(LIFECYCLE_CASES)("refuses, writes, signs and sends exactly what OFF does: $label", async ({ action, build, expected }) => {
    const off = await observeLifecycle(action, build(), false);
    const absent = await observeLifecycle(action, build(), "constant");
    const on = await observeLifecycle(action, build(), true);

    expect(JSON.stringify(off.outcome)).toMatch(expected);
    expect(absent.outcome).toEqual(off.outcome);
    expect(absent.effects).toEqual(off.effects);
    expect(on.outcome).toEqual(off.outcome);
    expect(on.effects).toEqual(off.effects);
    expectReadsCovered(off.reads, on.reads);
    if ("resolved" in off.outcome) expect(on.reads).toEqual(off.reads);
  });

  it("starts the fee, key and nonce reads beside the close batch, and signs only after every read", async () => {
    const built = closeScenario({ fees: true });
    const d = built.deps;
    const gate = createReadGate();
    Object.assign(d.client, {
      getMarkets: vi.fn(async () => {
        await gate.promise;
        return { code: 200, order_books: [CLOSE_MARKET] };
      }),
    });
    const execution = executeApprovedLighterClosePosition(built.intent, { ...d, lifecycleParallelReads: true });

    await vi.waitFor(() => {
      expect(d.client.getNextNonce).toHaveBeenCalledTimes(1);
      expect(d.client.getApiKeys).toHaveBeenCalledTimes(1);
      expect(d.client.getAccountLimits).toHaveBeenCalledTimes(1);
      expect(d.client.getSystemConfig).toHaveBeenCalledTimes(1);
    });
    // The signing secret was read once, where it is read today: before any provider read.
    expect(d.secretReader.readTradingApiPrivateKey).toHaveBeenCalledTimes(1);
    expect(d.intents.markPreSubmitRevalidated).not.toHaveBeenCalled();
    expect(d.nonceState.recordExecutionObserved).not.toHaveBeenCalled();
    expect(d.authSigner.signCreateOrder).not.toHaveBeenCalled();

    gate.release();
    await expect(execution).resolves.toMatchObject({ status: "closed" });
    expect(d.secretReader.readTradingApiPrivateKey).toHaveBeenCalledTimes(1);
    expect(d.client.sendTx).toHaveBeenCalledTimes(1);
  });

  it("OFF reads nothing past the close batch until it settles", async () => {
    const built = closeScenario({ fees: true });
    const d = built.deps;
    const gate = createReadGate();
    Object.assign(d.client, {
      getMarkets: vi.fn(async () => {
        await gate.promise;
        return { code: 200, order_books: [CLOSE_MARKET] };
      }),
    });
    const execution = executeApprovedLighterClosePosition(built.intent, { ...d, lifecycleParallelReads: false });

    await vi.waitFor(() => expect(d.client.getMarkets).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(d.client.getSystemConfig).not.toHaveBeenCalled();
    expect(d.client.getApiKeys).not.toHaveBeenCalled();
    expect(d.client.getNextNonce).not.toHaveBeenCalled();

    gate.release();
    await expect(execution).resolves.toMatchObject({ status: "closed" });
  });

  it("keeps the fee check's trader account its own fresh read beside the close batch", async () => {
    const built = closeScenario({ fees: true });
    await executeApprovedLighterClosePosition(built.intent, { ...built.deps, lifecycleParallelReads: true });

    const calls = vi.mocked(built.deps.client.getAccount).mock.calls;
    // The batch's own account read, unchanged and not fresh.
    expect(calls[0]).toEqual(["rhc", { by: "index", value: "42" }]);
    // The fee check's collector and trader reads, both fresh, never the batch's answer.
    expect(calls).toContainEqual(["rhc", { by: "index", value: 99 }, { fresh: true }]);
    expect(calls).toContainEqual(["rhc", { by: "index", value: 42 }, { fresh: true }]);
    expect(calls.filter((call) => call[1].activeOnly === undefined)).toHaveLength(3);
  });

  /** The action's first revalidation read answers only once the gate opens. */
  function gateActiveOrders(first: LighterAccountOrder[]) {
    return (d: LighterOrderLifecycleExecutionDeps, gate: Promise<void>): void => {
      let calls = 0;
      Object.assign(d.client, {
        getAccountActiveOrders: vi.fn(async () => {
          calls += 1;
          if (calls > 1) return { code: 200, orders: [] };
          await gate;
          return { code: 200, orders: first };
        }),
      });
    };
  }

  it.each([
    ["cancel_one", cancelOneScenario, gateActiveOrders([openOrder])],
    ["cancel_all", cancelAllScenario, gateActiveOrders([CANCEL_ALL_SECOND_ORDER, openOrder])],
    ["modify", () => modifyScenario({ fees: true }), (d: LighterOrderLifecycleExecutionDeps, gate: Promise<void>): void => {
      Object.assign(d.client, {
        getMarkets: vi.fn(async () => {
          await gate;
          return {
            code: 200,
            order_books: [{ market_id: 0, market_type: "perp", status: "active", supported_size_decimals: 4, supported_price_decimals: 2 }],
          };
        }),
      });
    }],
  ] as const)("%s starts its key and nonce reads before its first read settles", async (action, build, gateFirstRead) => {
    const built = build();
    const d = built.deps;
    const gate = createReadGate();
    gateFirstRead(d, gate.promise);
    const execution = LIFECYCLE_EXECUTORS[action](built.intent, { ...d, lifecycleParallelReads: true });

    await vi.waitFor(() => {
      expect(d.client.getApiKeys).toHaveBeenCalledTimes(1);
      expect(d.client.getNextNonce).toHaveBeenCalledTimes(1);
    });
    expect(d.intents.markPreSubmitRevalidated).not.toHaveBeenCalled();
    expect(d.nonceState.reserveObservedWith).not.toHaveBeenCalled();

    gate.release();
    await expect(execution).resolves.toBeDefined();
    expect(d.client.sendTx).toHaveBeenCalledTimes(1);
  });

  it("logs one numbers-only [lighter-lifecycle-timing] line per execution, sent or refused", async () => {
    const info = vi.spyOn(logger, "info");
    const sent = closeScenario({ fees: true });
    await executeApprovedLighterClosePosition(sent.intent, { ...sent.deps, lifecycleParallelReads: true });
    const refused = cancelOneScenario();
    vi.mocked(refused.deps.client.getAccountActiveOrders).mockReset().mockResolvedValue({ code: 200, orders: [] });
    await expect(executeApprovedLighterCancelOne(refused.intent, { ...refused.deps, lifecycleParallelReads: false }))
      .rejects.toThrow("no longer active and open");

    const lines = info.mock.calls
      .map((call) => Array.from<unknown>(call))
      .filter((args) => args[0] === "[lighter-lifecycle-timing]")
      .map((args) => args[1]);
    expect(lines).toHaveLength(2);
    const [closeLine, cancelLine] = lines;
    expect(closeLine).toMatchObject({ action: "close_position", intentId: sent.intent.intentId, parallelReads: 1, apiAccepted: 1 });
    expect(Object.keys(requireValue(closeLine))).toEqual(expect.arrayContaining([
      "secretMs", "authMs", "readsMs", "persistMs", "nonceReserveMs", "signMs", "sendMs",
      "reconcileMs", "decisionToApiAcceptedMs", "totalMs",
    ]));
    expect(cancelLine).toMatchObject({ action: "cancel_one", intentId: refused.intent.intentId, parallelReads: 0, apiAccepted: 0 });
    expect(cancelLine).not.toHaveProperty("sendMs");
    for (const line of lines) {
      for (const [key, value] of Object.entries(requireValue(line))) {
        if (key === "action" || key === "intentId") continue;
        expect(typeof value, key).toBe("number");
      }
    }
  });
});

describe("lifecycle parallel read helpers", () => {
  const auth = { token: "auth-token", accountIndex: 42 };

  function feeClient() {
    return {
      getSystemConfig: vi.fn<LighterClient["getSystemConfig"]>(async () => FEE_SYSTEM_CONFIG),
      getAccount: accountReads(),
      getAccountLimits: vi.fn<LighterClient["getAccountLimits"]>(async () => FEE_LIMITS),
    };
  }

  it("starts no fee read when OFF, when fee collection is off, or when the fee policy cannot be read", () => {
    const client = feeClient();
    expect(prefetchLighterLifecycleFeeReads({ parallel: false, client, environment: "rhc", accountIndex: 42, auth })).toBe(client);
    vi.mocked(feePolicy.getLighterFeePolicy).mockReturnValue(null);
    expect(prefetchLighterLifecycleFeeReads({ parallel: true, client, environment: "rhc", accountIndex: 42, auth })).toBe(client);
    vi.mocked(feePolicy.getLighterFeePolicy).mockImplementationOnce(() => { throw new Error("collector misconfigured"); });
    expect(prefetchLighterLifecycleFeeReads({ parallel: true, client, environment: "rhc", accountIndex: 42, auth })).toBe(client);
    expect(client.getSystemConfig).not.toHaveBeenCalled();
    expect(client.getAccount).not.toHaveBeenCalled();
    expect(client.getAccountLimits).not.toHaveBeenCalled();
  });

  it("answers each matching fee call once from the started reads, and anything else from the real client", async () => {
    vi.mocked(feePolicy.getLighterFeePolicy).mockReturnValue(FEE_POLICY);
    const client = feeClient();
    const prefetched = prefetchLighterLifecycleFeeReads({ parallel: true, client, environment: "rhc", accountIndex: 42, auth });
    expect(client.getSystemConfig).toHaveBeenCalledTimes(1);
    expect(client.getAccount).toHaveBeenCalledTimes(2);
    expect(client.getAccountLimits).toHaveBeenCalledTimes(1);

    await requireValue(prefetched.getSystemConfig)("rhc", { fresh: true });
    await requireValue(prefetched.getAccount)("rhc", { value: 42, by: "index" }, { fresh: true });
    await requireValue(prefetched.getAccount)("rhc", { by: "index", value: 99 }, { fresh: true });
    await requireValue(prefetched.getAccountLimits)("rhc", { accountIndex: 42 }, auth);
    expect(client.getSystemConfig).toHaveBeenCalledTimes(1);
    expect(client.getAccount).toHaveBeenCalledTimes(2);
    expect(client.getAccountLimits).toHaveBeenCalledTimes(1);

    // Used once each; a repeat, or a different query, reaches the provider.
    await requireValue(prefetched.getSystemConfig)("rhc", { fresh: true });
    await requireValue(prefetched.getAccount)("rhc", { by: "index", value: 42 });
    expect(client.getSystemConfig).toHaveBeenCalledTimes(2);
    expect(client.getAccount).toHaveBeenCalledTimes(3);
    expect(client.getAccount).toHaveBeenLastCalledWith("rhc", { by: "index", value: 42 });
  });

  it("issues an OFF read only when awaited, and surfaces an ON read's synchronous failure at its await", async () => {
    const start = vi.fn(async () => "value");
    const off = lifecycleRead(false, start);
    expect(start).not.toHaveBeenCalled();
    await expect(off()).resolves.toBe("value");
    expect(start).toHaveBeenCalledTimes(1);

    const throwing = lifecycleRead<string>(true, () => { throw new Error("thrown at start"); });
    await expect(throwing()).rejects.toThrow("thrown at start");
  });
});


const OWNERSHIP_SCENARIOS: readonly { action: LifecycleAction; build: () => LifecycleScenario }[] = [
  { action: "cancel_one", build: cancelOneScenario },
  { action: "modify", build: modifyScenario },
  { action: "cancel_all", build: cancelAllScenario },
  { action: "close_position", build: closeScenario },
];
const SELECTED_WALLET = { kind: "wallet" as const, address: FEE_WALLET };

describe("desk close preparation fee snapshot", () => {
  const auth = vi.fn(async () => ({ token: "read-only-token", accountIndex: 42 }));
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    clearLighterDeskPrewarm();
    configureLighterOrderPreviewDeps({ deskPrewarm: true });
    configureLighterReadOnlyAccountAuthResolver(auth);
    auth.mockClear();
  });
  afterEach(() => {
    clearLighterDeskPrewarm();
    configureLighterDeskPreparationFeeDeps(null);
    configureLighterOrderPreviewDeps(null);
    configureLighterReadOnlyAccountAuthResolver(null);
    vi.useRealTimers();
  });

  async function prepare(d: LighterOrderLifecycleExecutionDeps, enabled: boolean, desk = true) {
    configureLighterDeskPreparationFeeDeps({ deskPreparationFeeSnapshot: enabled });
    const snapshot = beginLighterDeskPreparationFees({ deskPreparation: desk, client: d.client, environment: "rhc", accountIndex: 42 });
    try {
      return { resolved: await prepareLighterClosePosition({
        environment: "rhc", accountIndex: 42, apiKeyIndex: 7, marketIndex: 0, maxSlippageBps: 100,
        client: d.client, ...(snapshot === undefined ? {} : { feeSnapshot: snapshot }),
      }) };
    } catch (error) {
      return { rejected: describeLifecycleFailure(error) };
    } finally {
      snapshot?.log("close_position");
    }
  }

  const cases: readonly { label: string; expected: "fees" | "unattributed" | RegExp; change: (d: LighterOrderLifecycleExecutionDeps) => void }[] = [
    { label: "live authorized fees", expected: "fees", change: () => undefined },
    { label: "fee collection off", expected: "unattributed", change: () => vi.mocked(feePolicy.getLighterFeePolicy).mockReturnValue(null) },
    { label: "locked vault", expected: "unattributed", change: () => configureLighterReadOnlyAccountAuthResolver(async () => null) },
    { label: "auth unavailable", expected: "unattributed", change: () => configureLighterReadOnlyAccountAuthResolver(rejectNow(new Error("auth down"))) },
    { label: "fee config unavailable", expected: "unattributed", change: (d) => vi.mocked(requireValue(d.client.getSystemConfig)).mockRejectedValue(new Error("config down")) },
    { label: "synchronous fee config failure", expected: "unattributed", change: (d) => vi.mocked(requireValue(d.client.getSystemConfig)).mockImplementation(() => { throw new Error("config down"); }) },
    { label: "fee limits unavailable", expected: "unattributed", change: (d) => vi.mocked(requireValue(d.client.getAccountLimits)).mockRejectedValue(new Error("limits down")) },
    { label: "unapproved trader", expected: "unattributed", change: (d) => Object.assign(d.client, { getAccount: accountReads({ positions: () => [longPosition], integrators: [] }) }) },
    { label: "account read unavailable", expected: /account down/, change: (d) => vi.mocked(d.client.getAccount).mockRejectedValue(new Error("account down")) },
    { label: "market read unavailable", expected: /market down/, change: (d) => vi.mocked(d.client.getMarkets).mockRejectedValue(new Error("market down")) },
    { label: "book read unavailable", expected: /book down/, change: (d) => vi.mocked(d.client.getOrderBookOrders).mockRejectedValue(new Error("book down")) },
    { label: "inactive market", expected: /active Lighter perpetual market/, change: (d) => vi.mocked(d.client.getMarkets).mockResolvedValue({ code: 200, order_books: [{ ...CLOSE_MARKET, status: "inactive" }] }) },
    { label: "missing position", expected: /no longer shown/, change: (d) => Object.assign(d.client, { getAccount: accountReads() }) },
    { label: "insufficient depth", expected: /no executable close liquidity/, change: (d) => vi.mocked(d.client.getOrderBookOrders).mockResolvedValue({ code: 200, total_asks: 0, asks: [], total_bids: 0, bids: [] }) },
  ];

  it.each(cases)("preserves cold OFF/ON result and no signing for $label", async ({ change, expected }) => {
    const off = closeScenario({ fees: true }).deps;
    change(off);
    const outcome = await prepare(off, false);
    if (expected instanceof RegExp) expect(JSON.stringify(outcome)).toMatch(expected);
    else expect(outcome).toMatchObject({ resolved: { integratorFees: expected === "fees" ? PERP_FEES : null } });
    clearLighterDeskPrewarm();
    const on = closeScenario({ fees: true }).deps;
    change(on);
    expect(await prepare(on, true)).toEqual(outcome);
    expect(on.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(on.authSigner.createAccountAuth).not.toHaveBeenCalled();
    expect(on.authSigner.signCreateOrder).not.toHaveBeenCalled();
    expect(on.nonceState.recordExecutionObserved).not.toHaveBeenCalled();
    expect(on.client.sendTx).not.toHaveBeenCalled();
  });

  it("warms only bounded fee inputs and rereads the live position with its own auth", async () => {
    expect(LIGHTER_DESK_PREPARATION_FEE_SNAPSHOT).toBe(true);
    const off = await prepare(closeScenario({ fees: true }).deps, false);
    const cold = closeScenario({ fees: true }).deps;
    expect(await prepare(cold, true)).toEqual(off);
    expect(cold.client.getAccount).toHaveBeenCalledTimes(2);
    expect(cold.client.getAccount).toHaveBeenCalledWith("rhc", { by: "index", value: "42" }, { fresh: true });
    const warm = closeScenario({ fees: true }).deps;
    auth.mockClear();
    expect(await prepare(warm, true)).toEqual(off);
    expect(warm.client.getSystemConfig).not.toHaveBeenCalled();
    expect(warm.client.getAccountLimits).not.toHaveBeenCalled();
    expect(warm.client.getAccount).toHaveBeenCalledTimes(1);
    expect(auth).toHaveBeenCalledTimes(1);
    const drift = closeScenario({ fees: true }).deps;
    Object.assign(drift.client, { getAccount: accountReads({ positions: () => [{ ...longPosition, position: "0.5" }] }) });
    expect(await prepare(drift, true)).toMatchObject({ resolved: { baseAmount: "0.5" } });
  });

  it("never uses warm limits to bypass a locked vault, and does not record failed fees", async () => {
    await prepare(closeScenario({ fees: true }).deps, true);
    configureLighterReadOnlyAccountAuthResolver(async () => null);
    const locked = closeScenario({ fees: true }).deps;
    expect(await prepare(locked, true)).toMatchObject({ resolved: { integratorFees: null } });
    expect(locked.client.getAccountLimits).not.toHaveBeenCalled();
    clearLighterDeskPrewarm();
    const failed = closeScenario({ fees: true }).deps;
    await prepare(failed, true);
    expect(takeLighterDeskPrewarmFeeConfig("rhc", 99, NOW)).toBeNull();
    expect(takeLighterDeskPrewarmAccountLimits("rhc", 42, NOW)).toBeNull();
  });

  it("expires tier and fee config independently without extending warmed timestamps", async () => {
    await prepare(closeScenario({ fees: true }).deps, true);
    vi.setSystemTime(NOW + LIGHTER_DESK_PREWARM_ACCOUNT_LIMITS_MAX_AGE_MS + 1);
    const tier = closeScenario({ fees: true }).deps;
    await prepare(tier, true);
    expect(tier.client.getAccountLimits).toHaveBeenCalledTimes(1);
    expect(tier.client.getSystemConfig).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + LIGHTER_DESK_PREWARM_FEE_CONFIG_MAX_AGE_MS + 1);
    const config = closeScenario({ fees: true }).deps;
    await prepare(config, true);
    expect(config.client.getSystemConfig).toHaveBeenCalledTimes(1);
  });

  it.each(["expired", "cleared"] as const)("rechecks a warm fee pair after the first batch, when it was %s in flight", async (change) => {
    await prepare(closeScenario({ fees: true }).deps, true);
    vi.setSystemTime(NOW + LIGHTER_DESK_PREWARM_FEE_CONFIG_MAX_AGE_MS - 100);
    const d = closeScenario({ fees: true }).deps;
    const gate = createReadGate();
    vi.mocked(d.client.getOrderBookOrders).mockImplementation(async () => {
      await gate.promise;
      return { code: 200, total_asks: 0, asks: [], total_bids: 1, bids: [CLOSE_BID] };
    });
    const currentConfig = { ...FEE_SYSTEM_CONFIG, liquidity_pool_index: 9 };
    vi.mocked(requireValue(d.client.getSystemConfig)).mockResolvedValue(currentConfig);
    const account = requireValue(vi.mocked(d.client.getAccount).getMockImplementation());
    vi.mocked(d.client.getAccount).mockImplementation(async (...args) => Number(args[1].value) === 99
      ? { code: 200, accounts: [{ index: 99, status: 7, l1_address: FEE_WALLET }] }
      : account(...args));
    const info = vi.spyOn(logger, "info");
    const pending = prepare(d, true);
    await vi.waitFor(() => expect(d.client.getOrderBookOrders).toHaveBeenCalledTimes(1));
    expect(d.client.getSystemConfig).not.toHaveBeenCalled();
    expect(auth).toHaveBeenCalledTimes(1);
    if (change === "expired") vi.setSystemTime(NOW + LIGHTER_DESK_PREWARM_FEE_CONFIG_MAX_AGE_MS + 1);
    else clearLighterDeskPrewarm();
    const readAtMs = Date.now();
    gate.release();
    expect(await pending).toHaveProperty("resolved.integratorFees", PERP_FEES);
    expect(d.client.getSystemConfig).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.client.getAccount).mock.calls.filter((call) => Number(call[1].value) === 99)).toHaveLength(1);
    expect(takeLighterDeskPrewarmFeeConfig("rhc", 99, readAtMs + 1)).toMatchObject({
      systemConfig: currentConfig, collectorAccount: { accounts: [{ status: 7 }] },
    });
    expect(takeLighterDeskPrewarmFeeConfig("rhc", 99, readAtMs + LIGHTER_DESK_PREWARM_FEE_CONFIG_MAX_AGE_MS + 1)).toBeNull();
    const line = info.mock.calls.map((call) => Array.from<unknown>(call)).find((call) => call[0] === "lighter.desk.preparation_fee_timing")?.[1];
    expect(line).toMatchObject({ prewarmFeeConfigHit: 0 });
  });

  it("does not use another account, environment or collector's warm inputs", async () => {
    recordLighterDeskPrewarmAccountLimits({ environment: "rhc", accountIndex: 43, response: FEE_LIMITS, atMs: NOW });
    recordLighterDeskPrewarmFeeConfig({ environment: "rhc", collectorAccountIndex: 98, systemConfig: FEE_SYSTEM_CONFIG, collectorAccount: { code: 200, accounts: [{ index: 98 }] }, atMs: NOW });
    recordLighterDeskPrewarmAccountLimits({ environment: "core", accountIndex: 42, response: FEE_LIMITS, atMs: NOW });
    const d = closeScenario({ fees: true }).deps;
    await prepare(d, true);
    expect(d.client.getSystemConfig).toHaveBeenCalledTimes(1);
    expect(d.client.getAccountLimits).toHaveBeenCalledTimes(1);
  });

  it("keeps OFF and chat on the prior read path even while fee inputs are warm", async () => {
    await prepare(closeScenario({ fees: true }).deps, true);
    for (const [enabled, desk] of [[false, true], [true, false]]) {
      const d = closeScenario({ fees: true }).deps;
      await prepare(d, requireValue(enabled), requireValue(desk));
      expect(d.client.getSystemConfig).toHaveBeenCalledTimes(1);
      expect(d.client.getAccountLimits).toHaveBeenCalledTimes(1);
      expect(d.client.getAccount).toHaveBeenCalledWith("rhc", { by: "index", value: "42" });
    }
  });

  it("starts only public fee reads before the book settles, and logs numeric timing safely", async () => {
    const d = closeScenario({ fees: true }).deps;
    const gate = createReadGate();
    vi.mocked(d.client.getOrderBookOrders).mockImplementation(async () => {
      await gate.promise;
      return { code: 200, total_asks: 0, asks: [], total_bids: 1, bids: [CLOSE_BID] };
    });
    const info = vi.spyOn(logger, "info");
    const execution = prepare(d, true);
    await vi.waitFor(() => expect(d.client.getSystemConfig).toHaveBeenCalledTimes(1));
    expect(auth).not.toHaveBeenCalled();
    expect(d.client.getAccountLimits).not.toHaveBeenCalled();
    gate.release();
    await execution;
    const line = requireValue(info.mock.calls.map((call) => Array.from<unknown>(call)).find((call) => call[0] === "lighter.desk.preparation_fee_timing")?.[1]);
    expect(line).toMatchObject({ action: "close_position", prewarmFeeConfigHit: 0, prewarmAccountLimitsHit: 0 });
    if (typeof line !== "object" || line === null) throw new Error("Expected timing fields.");
    for (const [key, value] of Object.entries(line)) if (key !== "action") expect(typeof value).toBe("number");
    vi.spyOn(globalThis, "structuredClone").mockImplementation(() => { throw new Error("clone failed"); });
    info.mockImplementation(() => { throw new Error("log sink failed"); });
    clearLighterDeskPrewarm();
    expect(await prepare(closeScenario({ fees: true }).deps, true)).toHaveProperty("resolved.integratorFees", PERP_FEES);
  });
});

describe("LIGHTER_LIFECYCLE_SIGNING_OWNERSHIP_RECHECK", () => {
  it.each(LIFECYCLE_CASES)("keeps parallel ownership outcomes and durable effects equal to sequential: $label", async ({ action, build }) => {
    const ownership = { enabled: true, wallet: SELECTED_WALLET };
    const off = await observeLifecycle(action, build(), false, ownership);
    const on = await observeLifecycle(action, build(), true, ownership);
    expect(on.outcome).toEqual(off.outcome);
    expect(on.effects).toEqual(off.effects);
    expectReadsCovered(off.reads, on.reads);
  });

  const prefetchedActions = OWNERSHIP_SCENARIOS.filter(({ action }) => action !== "close_position");

  it.each(prefetchedActions)("overlaps $action fresh ownership with active orders and still waits before nonce writes", async ({ action, build }) => {
    for (const parallel of [false, true]) {
      const { intent: approved, deps: d } = build();
      const activeGate = createReadGate();
      const ownershipGate = createReadGate();
      const active = d.client.getAccountActiveOrders;
      const account = requireValue(vi.mocked(d.client.getAccount).getMockImplementation());
      Object.assign(d.client, {
        getAccountActiveOrders: vi.fn<LighterClient["getAccountActiveOrders"]>(async (...args) => {
          await activeGate.promise;
          return active(...args);
        }),
      });
      vi.mocked(d.client.getAccount).mockImplementation(async (...args) => {
        if (args[2]?.fresh === true) await ownershipGate.promise;
        return account(...args);
      });
      const execution = LIFECYCLE_EXECUTORS[action](approved, {
        ...d, lifecycleParallelReads: parallel, signingOwnershipRecheck: true,
      }, undefined, SELECTED_WALLET);
      await vi.waitFor(() => expect(d.client.getAccountActiveOrders).toHaveBeenCalledTimes(1));
      const freshCalls = () => vi.mocked(d.client.getAccount).mock.calls.filter((call) => call[2]?.fresh === true);
      expect(freshCalls()).toHaveLength(parallel ? 1 : 0);
      expect(d.secretReader.readTradingApiPrivateKey).toHaveBeenCalledTimes(1);
      expect(d.authSigner.createAccountAuth).toHaveBeenCalledTimes(1);
      expect(requireValue(vi.mocked(d.authSigner.createAccountAuth).mock.invocationCallOrder[0]))
        .toBeLessThan(requireValue(vi.mocked(d.client.getAccountActiveOrders).mock.invocationCallOrder[0]));
      activeGate.release();
      await vi.waitFor(() => expect(freshCalls()).toHaveLength(1));
      expect(d.client.getAccount).toHaveBeenCalledWith("rhc", { by: "index", value: "42" }, { fresh: true });
      expect(d.intents.markPreSubmitRevalidated).not.toHaveBeenCalled();
      expect(d.nonceState.recordExecutionObserved).not.toHaveBeenCalled();
      expect(d.lifecycleSigner.signCancelOrder).not.toHaveBeenCalled();
      expect(d.lifecycleSigner.signModifyOrder).not.toHaveBeenCalled();
      expect(d.lifecycleSigner.signCancelAllOrders).not.toHaveBeenCalled();
      ownershipGate.release();
      await expect(execution).resolves.toBeDefined();
      expect(freshCalls()).toHaveLength(1);
      expect(d.secretReader.readTradingApiPrivateKey).toHaveBeenCalledTimes(1);
    }
  });

  it.each(prefetchedActions)("contains failed unused $action ownership reads while preserving earlier refusal", async ({ action, build }) => {
    for (const synchronous of [false, true]) {
      const prepare = () => {
        const built = build();
        vi.mocked(built.deps.client.getApiKeys).mockImplementation(rejectAfter(new Error("credential unavailable"), 5));
        vi.mocked(built.deps.client.getAccount).mockImplementation(() => {
          if (synchronous) throw new Error("ownership unavailable");
          return Promise.reject(new Error("ownership unavailable"));
        });
        return built;
      };
      const ownership = { enabled: true, wallet: SELECTED_WALLET };
      const off = await observeLifecycle(action, prepare(), false, ownership);
      const on = await observeLifecycle(action, prepare(), true, ownership);
      expect(on.outcome).toEqual(off.outcome);
      expect(on.outcome).toMatchObject({ rejected: { message: "credential unavailable" } });
      expect(on.effects).toEqual(off.effects);
      expect(off.reads.getAccount).toEqual([]);
      expect(on.reads.getAccount).toEqual([JSON.stringify(["rhc", { by: "index", value: "42" }, { fresh: true }])]);
    }
  });

  it.each(prefetchedActions)("keeps $action ownership-switch OFF free of speculative account reads", async ({ action, build }) => {
    const built = build();
    vi.mocked(built.deps.client.getApiKeys).mockRejectedValue(new Error("credential unavailable"));
    await observeLifecycle(action, built, true, { enabled: false, wallet: SELECTED_WALLET });
    expect(built.deps.client.getAccount).not.toHaveBeenCalled();
  });

  it.each(prefetchedActions)("refuses $action locked during ownership reads before reservation or signing", async ({ action, build }) => {
    for (const parallel of [false, true]) {
      const { intent: approved, deps: d } = build();
      const controller = new AbortController();
      const gate = createReadGate();
      const account = requireValue(vi.mocked(d.client.getAccount).getMockImplementation());
      vi.mocked(d.client.getAccount).mockImplementation(async (...args) => {
        if (args[2]?.fresh === true) await gate.promise;
        return account(...args);
      });
      const execution = LIFECYCLE_EXECUTORS[action](approved, {
        ...d, lifecycleParallelReads: parallel, signingOwnershipRecheck: true,
      }, controller.signal, SELECTED_WALLET);
      const refused = expect(execution).rejects.toMatchObject({ reason: "cancelled_before_reservation" });
      await vi.waitFor(() => expect(vi.mocked(d.client.getAccount).mock.calls.filter((call) => call[2]?.fresh === true)).toHaveLength(1));
      controller.abort("lock");
      gate.release();
      await refused;
      expect(d.secretReader.readTradingApiPrivateKey).toHaveBeenCalledTimes(1);
      expect(d.nonceState.reserveObservedWith).not.toHaveBeenCalled();
      expect(d.lifecycleSigner.signCancelOrder).not.toHaveBeenCalled();
      expect(d.lifecycleSigner.signModifyOrder).not.toHaveBeenCalled();
      expect(d.lifecycleSigner.signCancelAllOrders).not.toHaveBeenCalled();
      expect(d.client.sendTx).not.toHaveBeenCalled();
    }
  });

  it.each(LIFECYCLE_CASES)("preserves prior outcomes, writes and signing with a matching wallet: $label", async ({ action, build }) => {
    const off = await observeLifecycle(action, build(), true, { enabled: false, wallet: SELECTED_WALLET });
    const on = await observeLifecycle(action, build(), true, { enabled: true, wallet: SELECTED_WALLET });
    expect(on.outcome).toEqual(off.outcome);
    expect(on.effects).toEqual(off.effects);
  });

  it.each(OWNERSHIP_SCENARIOS)("refuses $action after auth, before passed evidence or nonce writes when the wallet drifted", async ({ action, build }) => {
    const built = build();
    const outcome = await observeLifecycle(action, built, true, {
      enabled: true, wallet: { kind: "wallet", address: `0x${"2".repeat(40)}` },
    });
    expect(outcome.outcome).toMatchObject({ rejected: { message: expect.stringContaining("no longer belongs to the selected wallet") } });
    expect(JSON.stringify(outcome.outcome)).toContain("No lifecycle transaction was signed or submitted.");
    expect(JSON.stringify(outcome.outcome)).not.toContain("No trading key was loaded");
    expect(built.deps.secretReader.readTradingApiPrivateKey).toHaveBeenCalledTimes(1);
    expect(built.deps.authSigner.createAccountAuth).toHaveBeenCalledTimes(1);
    expect(built.deps.intents.markPreSubmitRevalidated).not.toHaveBeenCalled();
    expect(built.deps.nonceState.recordExecutionObserved).not.toHaveBeenCalled();
    expect(built.deps.nonceState.reserveObservedWith).not.toHaveBeenCalled();
    expect(built.deps.lifecycleSigner.signCancelOrder).not.toHaveBeenCalled();
    expect(built.deps.lifecycleSigner.signModifyOrder).not.toHaveBeenCalled();
    expect(built.deps.lifecycleSigner.signCancelAllOrders).not.toHaveBeenCalled();
    expect(built.deps.authSigner.signCreateOrder).not.toHaveBeenCalled();
    expect(built.deps.client.sendTx).not.toHaveBeenCalled();
  });

  it.each(OWNERSHIP_SCENARIOS)("fails closed for $action with absent or unavailable session wallet", async ({ action, build }) => {
    for (const wallet of [undefined, { kind: "unavailable" as const }]) {
      const on = await observeLifecycle(action, build(), false, { enabled: true, ...(wallet === undefined ? {} : { wallet }) });
      expect(on.outcome).toMatchObject({ rejected: { message: expect.stringContaining("wallet selected for this session is no longer available") } });
      expect(on.effects.recordExecutionObserved).toEqual([]);
      expect(on.effects.sendTx).toEqual([]);
    }
  });

  it.each(OWNERSHIP_SCENARIOS)("uses the named default and a fresh account for $action", async ({ action, build }) => {
    const built = build();
    const { signingOwnershipRecheck: _override, ...d } = built.deps;
    await expect(LIFECYCLE_EXECUTORS[action](built.intent, d, undefined, SELECTED_WALLET)).resolves.toBeDefined();
    const accountMock = vi.mocked(d.client.getAccount);
    const sendOrder = requireValue(vi.mocked(d.client.sendTx).mock.invocationCallOrder[0]);
    const freshReads = accountMock.mock.calls.filter((call, index) =>
      call[2]?.fresh === true && requireValue(accountMock.mock.invocationCallOrder[index]) < sendOrder);
    expect(freshReads).toHaveLength(1);
    expect(freshReads[0]).toEqual(["rhc", { by: "index", value: "42" }, { fresh: true }]);
  });

  it.each(OWNERSHIP_SCENARIOS)("preserves trusted default without a wallet for $action", async ({ action, build }) => {
    const off = await observeLifecycle(action, build(), false, { enabled: false });
    const on = await observeLifecycle(action, build(), false, { enabled: true, wallet: { kind: "trusted_default_without_wallet" } });
    expect(on.outcome).toEqual(off.outcome);
    expect(on.effects).toEqual(off.effects);
  });

  it.each(OWNERSHIP_SCENARIOS)("keeps existing credential refusal ahead of ownership on $action", async ({ action, build }) => {
    const built = build();
    vi.mocked(built.deps.client.getApiKeys).mockResolvedValue({ code: 200, api_keys: [] });
    const on = await observeLifecycle(action, built, true, { enabled: true });
    expect(on.outcome).toMatchObject({ rejected: { message: expect.stringContaining("registered Lighter trading credential changed") } });
    expect(on.effects.recordExecutionObserved).toEqual([]);
  });

  it.each(OWNERSHIP_SCENARIOS)("refuses a fresh ownership read failure before nonce or signing on $action", async ({ action, build }) => {
    const built = build();
    const read = requireValue(vi.mocked(built.deps.client.getAccount).getMockImplementation());
    vi.mocked(built.deps.client.getAccount).mockImplementation(async (...args) => {
      if (args[2]?.fresh === true) throw OFFLINE("ownership timed out");
      return read(...args);
    });
    const on = await observeLifecycle(action, built, true, { enabled: true, wallet: SELECTED_WALLET });
    expect(on.outcome).toMatchObject({ rejected: { message: expect.stringContaining("nothing was signed or sent") } });
    expect(on.effects.markPreSubmitRevalidated).toEqual([]);
    expect(on.effects.recordExecutionObserved).toEqual([]);
    expect(on.effects.sendTx).toEqual([]);
  });
});
