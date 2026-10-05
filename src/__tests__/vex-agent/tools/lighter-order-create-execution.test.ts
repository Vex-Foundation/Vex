import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as feePolicy from "@tools/lighter/fee-policy.js";
import { configureLighterReadOnlyAccountAuthResolver } from "@vex-agent/tools/protocols/lighter/read-account-auth.js";

// The capital-share boundary at execute-time re-admission. `null` limits is the
// DEFAULT INSTALL: no share is set, so no ceiling applies and the ledger is
// never reached. Enforcement with a share set, including the refusal when the
// live account shrank after approval, is proved in
// `lighter-capital-share-policy.test.ts`.
// `null` unless a single-snapshot capital-share case sets a share for one run.
const tradingLimits = vi.hoisted(() => ({
  current: null as { readonly agentCapitalSharePercent: number } | null,
}));
vi.mock("@vex-agent/db/repos/lighter-trading-limits.js", () => ({
  readLighterTradingLimits: async () => tradingLimits.current,
}));
// Both ledger exits are RECORDED rather than stubbed away, because the outcome
// paths must not confuse them: a commitment that outlives its intent shrinks
// the user's capital share forever, while one retired the moment its order
// filled hands the next admission a budget that counts the exposure NOWHERE.
// A never-sent order retires at once; a settled one is only STAMPED.
const ledger = vi.hoisted(() => ({
  retired: [] as { intentId: string; reason: string }[],
  settled: [] as string[],
  admitted: [] as unknown[],
  refuseAdmission: false,
}));
vi.mock("@vex-agent/db/repos/lighter-capital-commitments.js", () => ({
  admitLighterCapitalCommitment: async (input: unknown) => {
    ledger.admitted.push(input);
    return ledger.refuseAdmission
      ? { admitted: false, remainingUnits: "5000000", liveCommittedUnits: "1000000" }
      : { admitted: true, commitmentId: "commitment-test", liveCommittedUnits: "0" };
  },
  listLiveLighterCapitalCommitments: async () => [],
  retireLighterCapitalCommitment: async (input: { intentId: string; reason: string }) => {
    ledger.retired.push(input);
  },
  markLighterCapitalCommitmentSettled: async (intentId: string) => {
    ledger.settled.push(intentId);
  },
}));

import {
  configureLighterCreateOrderExecutionDeps,
  executeApprovedLighterCreateOrder,
  getConfiguredLighterCreateOrderExecutionDeps,
  LIGHTER_ORDER_PARALLEL_PREFLIGHT,
  LIGHTER_REVALIDATION_SINGLE_SNAPSHOT,
  type ExecuteApprovedLighterCreateOrderDeps,
} from "@vex-agent/tools/protocols/lighter/order-create-execution.js";
import type { LighterClient } from "@tools/lighter/client.js";
import logger from "@utils/logger.js";
import { requireValue } from "../../helpers/require-value.js";
import {
  LIGHTER_READ_AUTH_CACHE,
  LIGHTER_READ_AUTH_CACHE_TTL_MS,
  LighterReadAuthCache,
  lighterReadAuthCache,
} from "@vex-agent/tools/protocols/lighter/read-auth-cache.js";
import {
  LIGHTER_STREAM_REVALIDATION,
  LIGHTER_STREAM_REVALIDATION_MAX_AGE_MS,
  type LighterStreamOrderBookReader,
  type LighterStreamOrderBookSnapshot,
} from "@vex-agent/tools/protocols/lighter/stream-revalidation.js";
import type { LighterOrderReadyForSignerPlan } from "@vex-agent/tools/protocols/lighter/execution-plan.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
import { buildLighterUnsignedCreateOrderRequest } from "@tools/lighter/signer-order.js";
import {
  createLighterSignerBinaryAdapter,
  type LighterSignerBinaryRunner,
} from "@tools/lighter/signer-binary-adapter.js";
import {
  signerRunnerEmitting,
  signerRunnerExitingWithoutOutput,
  signerRunnerNeverClosing,
  signerRunnerRejectingWithoutEvidence,
} from "../../helpers/lighter-scripted-signer.js";
import { buildLighterOrderPreview } from "@tools/lighter/order-preview.js";
import type {
  LighterAccountAsset,
  LighterAccountLimitsResponse,
  LighterAccountResponse,
  LighterMarketDetail,
  LighterSystemConfigResponse,
  LighterTrade,
} from "@tools/lighter/types.js";
import { ErrorCodes, VexError } from "../../../errors.js";
import type { LighterFillRecord } from "@vex-agent/tools/protocols/lighter/agentscan-activity.js";
import {
  resetLighterMarketAssetsCache,
  type LighterFillObservationDeps,
} from "@vex-agent/tools/protocols/lighter/fill-observation.js";

// These lifecycle fixtures represent orders approved while collection is disabled.
// Enabled-policy refusal is exercised separately below and fee terms have their own suite.
beforeEach(() => vi.spyOn(feePolicy, "getLighterFeePolicy").mockReturnValue(null));
afterEach(() => vi.restoreAllMocks());

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
    // The live account endpoint always reports the owning wallet (measured
    // 2026-09-10 on RHC account 24226, checksummed). The capital-share
    // re-admission identifies the wallet from it and refuses without it, so the
    // fixture carries what the provider carries.
    l1_address: "0x1111111111111111111111111111111111111111",
    status: 1,
    collateral: "1000",
    available_balance: "900",
    cross_initial_margin_requirement: "0.000000",
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
  expiresAt: new Date(NOW + 3_600_000).toISOString(),
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

/**
 * The pipeline suites pin the K-3 switches OFF so they keep asserting the
 * sequential path (the rollback); each switch's own suite below passes ON
 * explicitly and proves it matches OFF.
 */
function deps(overrides: Partial<ExecuteApprovedLighterCreateOrderDeps> = {}): ExecuteApprovedLighterCreateOrderDeps {
  return {
    parallelPreflight: false,
    readAuthCache: null,
    streamRevalidation: false,
    revalidationSingleSnapshot: false, signingOwnershipRecheck: false,
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
      releaseUnsubmittedReservation: vi.fn(async () => null),
      recordExecutionObserved: vi.fn(async () => ({ status: "observed" })),
    },
    previews: {
      findFreshById: vi.fn(async () => APPROVED_PREVIEW_ROW),
    },
    now: vi.fn(() => NOW),
    wait: vi.fn(async () => undefined),
    intents: {
      markSendAttemptStarted: vi.fn(async () => true),
      markExpiredUnsubmitted: vi.fn(async () => true),
      markUnsubmittedRefused: vi.fn(async () => true),
      findByIntentIdAnySession: vi.fn(async () => null),
      markPreSubmitRevalidated: vi.fn(async () => APPROVED_INTENT_ROW),
      markSigned: vi.fn(async () => ({ ok: true })),
      markSubmitted: vi.fn(async () => ({ ok: true })),
      markApiAccepted: vi.fn(async () => ({
        executionState: "api_accepted",
        volumeQuotaRemaining: "99",
      })),
      markSequencerPending: vi.fn(async () => ({
        executionState: "sequencer_pending",
      })),
      markProviderOutcome: vi.fn(async (input) => ({
        executionState: input.state,
        providerOutcomeSource: input.source,
      })),
      markAmbiguous: vi.fn(async () => ({ executionState: "ambiguous" })),
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
  it("refuses a legacy no-fee approval when collection has become enabled", async () => {
    vi.mocked(feePolicy.getLighterFeePolicy).mockRestore();
    const d = deps();
    await expect(executeApprovedLighterCreateOrder({ plan: PLAN, deps: d })).rejects.toThrow("fee setup is required");
    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

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
    let nowMs = NOW;
    const now = () => nowMs;
    const d = deps({
      previews: { findFreshById: vi.fn(async () => fixture.previewRow) },
      now,
    });
    vi.mocked(d.signer.createAccountAuth).mockImplementation(async (input) => {
      const result = await deps().signer.createAccountAuth(input);
      nowMs = NOW + 5 * 60_000 + 1;
      return result;
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
    let nowMs = NOW;
    const now = () => nowMs;
    const d = deps({
      previews: { findFreshById: vi.fn(async () => fixture.previewRow) },
      now,
    });
    vi.mocked(d.signer.signCreateOrder).mockImplementation(async (input) => {
      const result = await deps().signer.signCreateOrder(input);
      nowMs = NOW + 5 * 60_000 + 1;
      return result;
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
      // `false`: revalidation reads the account's own margin fractions, and
      // `activeOnly: true` hides a market the account has leverage settings for
      // but no open position on.
      activeOnly: false,
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

  it("says nothing was sent when Lighter cannot be reached before the nonce is reserved", async () => {
    // 2026-09-24: approved, then Wi-Fi off. The pre-send read timed out after
    // 32 seconds and the desk showed the transport's own text.
    const base = deps();
    const offline = new VexError(ErrorCodes.LIGHTER_TIMEOUT, "Request timed out after 10000ms");
    const d = deps({ client: { ...base.client, getMarketDetails: vi.fn(async () => { throw offline; }) } });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("Vex couldn't reach Lighter before sending, so nothing was signed or sent.");

    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.signer.signCreateOrder).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("says nothing was sent when the fee revalidation cannot reach Lighter", async () => {
    // The same offline approval, failing in the fee check rather than the market read.
    vi.mocked(feePolicy.getLighterFeePolicy).mockRestore();
    configureLighterReadOnlyAccountAuthResolver(async () => ({ accountIndex: PLAN.accountIndex, token: "read-only" }));
    try {
      const base = deps();
      const offline = new VexError(ErrorCodes.LIGHTER_API_ERROR, "fetch failed", "Check network connectivity");
      const d = deps({
        client: {
          ...base.client,
          getSystemConfig: vi.fn(async () => { throw offline; }),
          getAccountLimits: vi.fn(async () => ({ code: 200, user_tier: "premium", user_tier_name: "Premium", current_maker_fee_tick: 120, current_taker_fee_tick: 350 })),
        },
      });

      const refusal = executeApprovedLighterCreateOrder({ plan: PLAN, deps: d });
      await expect(refusal).rejects.toThrow("Vex couldn't reach Lighter before sending, so nothing was signed or sent.");
      await expect(refusal).rejects.not.toThrow("fee setup is required");

      expect(d.reserveNonce).not.toHaveBeenCalled();
      expect(d.client.sendTx).not.toHaveBeenCalled();
    } finally {
      configureLighterReadOnlyAccountAuthResolver(null);
    }
  });

  it("tries recovery once, then explains a still-held nonce without asking the user to act", async () => {
    const recoverNonce = vi.fn(async () => ({}));
    const d = deps({
      nonceState: {
        releaseUnsubmittedReservation: vi.fn(async () => null),
        recordExecutionObserved: vi.fn(async () => null),
      },
      recoverNonce,
    });

    const refusal = executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    });
    await expect(refusal).rejects.toThrow("Vex clears the blocking reservation automatically");
    await expect(refusal).rejects.not.toThrow(/Ask Vex in chat|lighter\.order\.status/);

    expect(recoverNonce).toHaveBeenCalledTimes(1);
    expect(recoverNonce).toHaveBeenCalledWith({ environment: PLAN.environment, accountIndex: PLAN.accountIndex });
    expect(d.nonceState.recordExecutionObserved).toHaveBeenCalledTimes(2);
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.signer.signCreateOrder).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("proceeds after approval when recovery releases a stale earlier reservation", async () => {
    // The v0.2.13 desk refusal: a lock that was stale by execute time failed
    // the approved order and sent the trader to chat.
    let released = false;
    const recoverNonce = vi.fn(async () => { released = true; return {}; });
    const d = deps({
      nonceState: {
        releaseUnsubmittedReservation: vi.fn(async () => null),
        recordExecutionObserved: vi.fn(async () => (released ? { status: "observed" } : null)),
      },
      recoverNonce,
    });

    await executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    }).catch(() => undefined);

    expect(recoverNonce).toHaveBeenCalledTimes(1);
    expect(d.reserveNonce).toHaveBeenCalledTimes(1);
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
      return { status: "observed" };
    });
    const d = deps({
      client: {
        ...base.client,
        getAccountActiveOrders,
      },
      nonceState: {
      releaseUnsubmittedReservation: vi.fn(async () => null), recordExecutionObserved },
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

  it("records the signed transaction's own ExpiredAt with the signed state", async () => {
    const d = deps();
    const signedExpiry = NOW + 599_000;
    const original = d.signer.signCreateOrder;
    d.signer.signCreateOrder = vi.fn(async (input) => ({
      ...(await original(input)),
      txInfo: `{"AccountIndex":42,"OrderExpiry":0,"ExpiredAt":${signedExpiry},"Nonce":0}`,
    }));

    await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });

    expect(d.intents.markSigned).toHaveBeenCalledWith(expect.objectContaining({ signerExpiryMs: signedExpiry }));
  });

  it("refuses to send, and releases the nonce, when the signed expiry lies beyond the SDK window", async () => {
    const d = deps();
    const original = d.signer.signCreateOrder;
    d.signer.signCreateOrder = vi.fn(async (input) => ({
      ...(await original(input)),
      txInfo: `{"ExpiredAt":${NOW + 10 * 60_000 + 1},"Nonce":0}`,
    }));

    await expect(executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d }))
      .rejects.toThrow(/beyond the signer's default window/);

    expect(d.intents.markSigned).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
    expect(d.intents.markUnsubmittedRefused).toHaveBeenCalledOnce();
    expect(d.nonceState.releaseUnsubmittedReservation).toHaveBeenCalledOnce();
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
      // The fixture's signed info carries no ExpiredAt; repair then bounds it by consent.
      signerExpiryMs: null,
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

  it("STAMPS a filled order's capital commitment and never retires it early", async () => {
    // Retiring on provider evidence was the stale-snapshot gap: another session
    // that read the account BEFORE this fill would then find the capital in
    // neither `cross_initial_margin_requirement` nor the ledger, and admit a
    // second order against it. The stamp starts the observation lag instead.
    ledger.retired.length = 0;
    ledger.settled.length = 0;
    const d = deps();
    vi.mocked(d.client.getAccountInactiveOrders)
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValue({ code: 200, orders: [accountOrder({
        status: "filled", base_size: 0, filled_base_amount: "1", remaining_base_amount: "0",
        filled_quote_amount: "3000", is_ask: false,
      })] });

    const result = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });

    expect(result).toMatchObject({ status: "provider_confirmed", executionState: "filled" });
    expect(ledger.settled).toEqual([PLAN.intentId]);
    expect(ledger.retired).toEqual([]);
  });

  it("leaves a RESTING order's commitment untouched: it can still consume that capital", async () => {
    // `open` was retired with every other non-pending state. A resting order
    // still holds the margin its commitment reserved, so nothing is settled and
    // nothing is retired.
    ledger.retired.length = 0;
    ledger.settled.length = 0;
    const d = deps({
      client: {
        ...deps().client,
        getAccountActiveOrders: vi
          .fn()
          .mockResolvedValueOnce({ code: 200, orders: [] })
          .mockResolvedValueOnce({ code: 200, orders: [accountOrder()] }),
      },
    });

    const result = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });

    expect(result).toMatchObject({ status: "provider_confirmed", executionState: "open" });
    expect(ledger.settled).toEqual([]);
    expect(ledger.retired).toEqual([]);
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

  it("does not turn a cancel already confirmed by the stream into an unknown outcome", async () => {
    // The live shape behind "Outcome unknown": an IOC order Lighter refuses for
    // margin is terminal within a second, so the order stream commits
    // `canceled` while this REST lookup is still in flight. The transition
    // guard then refuses this write - correctly - and reading that refusal as
    // ambiguous told the desk nothing was known about an order the row beside
    // it had already settled.
    const d = deps();
    vi.mocked(d.client.getAccountInactiveOrders)
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValue({ code: 200, orders: [accountOrder({
        status: "canceled-margin-not-allowed", filled_base_amount: "0", remaining_base_amount: "0",
      })] });
    vi.mocked(d.intents.markProviderOutcome).mockResolvedValue(null);
    vi.mocked(d.intents.findByIntentIdAnySession).mockResolvedValue({
      ...APPROVED_INTENT_ROW, executionState: "canceled", clientOrderIndex: UNSIGNED_ORDER.clientOrderIndex,
      providerOrderId: "123", providerOrderStatus: "canceled-margin-not-allowed",
      providerOutcomeSource: "inactive_order",
      providerOutcomeJson: { status: "canceled-margin-not-allowed" },
    });
    const result = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });
    expect(result).toMatchObject({
      status: "provider_confirmed",
      executionState: "canceled",
      providerOrderStatus: "canceled-margin-not-allowed",
    });
    expect(d.intents.markAmbiguous).not.toHaveBeenCalled();
    expect(d.client.sendTx).toHaveBeenCalledTimes(1);
  });

  it("still reports ambiguous when the row the stream left is not terminal", async () => {
    // The guard only refuses a write it has a settled answer for. Anything
    // else reaching this branch is a persistence failure, and must keep saying
    // so rather than borrowing the stream's confidence.
    const d = deps();
    vi.mocked(d.client.getAccountInactiveOrders)
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValue({ code: 200, orders: [accountOrder({
        status: "canceled", filled_base_amount: "0", remaining_base_amount: "0",
      })] });
    vi.mocked(d.intents.markProviderOutcome).mockResolvedValue(null);
    vi.mocked(d.intents.findByIntentIdAnySession).mockResolvedValue({
      ...APPROVED_INTENT_ROW, executionState: "open", clientOrderIndex: UNSIGNED_ORDER.clientOrderIndex,
      providerOrderId: "123", providerOrderStatus: "open", providerOutcomeSource: "active_order",
    });
    const result = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });
    expect(result).toMatchObject({ status: "ambiguous" });
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
    // Both lists are read on every attempt, so the two rounds it took to see
    // the resting order cost two reads of each. Active still wins the round it
    // appears in.
    expect(d.client.getAccountActiveOrders).toHaveBeenCalledTimes(2);
    expect(d.client.getAccountInactiveOrders).toHaveBeenCalledTimes(2);
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

describe("Lighter consent and cancellation races", () => {
  it.each(["expiry", "cancellation"] as const)("refuses %s before reservation", async (kind) => {
    const controller = new AbortController();
    const d = deps();
    if (kind === "cancellation") controller.abort("lock");
    const plan = kind === "expiry" ? { ...PLAN, expiresAt: new Date(NOW).toISOString() } : PLAN;
    await expect(executeApprovedLighterCreateOrder({ plan, deps: d, abortSignal: controller.signal }))
      .rejects.toMatchObject({ reason: kind === "expiry" ? "consent_expired_before_reservation" : "cancelled_before_reservation" });
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.signer.signCreateOrder).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  for (const kind of ["expiry", "cancellation"] as const) {
    it.each(["acquisition", "signing", "staging", "send-admission"] as const)(`${kind} during %s cannot submit`, async (phase) => {
      let nowMs = NOW;
      const controller = new AbortController();
      const d = deps({ now: () => nowMs });
      const entered = createGate(), finish = createGate();
      const pause = async (): Promise<void> => { entered.release(); await finish.promise; };
      if (phase === "acquisition") {
        const original = deps().reserveNonce;
        vi.mocked(d.reserveNonce).mockImplementation(async (plan) => { const row = await original(plan); await pause(); return row; });
      } else if (phase === "signing") {
        const original = deps().signer.signCreateOrder;
        vi.mocked(d.signer.signCreateOrder).mockImplementation(async (input) => { const signed = await original(input); await pause(); return signed; });
      } else if (phase === "staging") {
        const original = deps().intents.markSubmitted;
        vi.mocked(d.intents.markSubmitted).mockImplementation(async (input) => { const row = await original(input); await pause(); return row; });
      } else {
        vi.mocked(d.intents.markSendAttemptStarted).mockImplementation(async () => { await pause(); return true; });
      }
      const execution = executeApprovedLighterCreateOrder({ plan: PLAN, deps: d, abortSignal: controller.signal });
      const rejected = expect(execution).rejects.toMatchObject({ reason: expect.stringMatching(kind === "expiry" ? /^consent_expired_/ : /^cancelled_/) });
      await entered.promise;
      if (kind === "expiry") nowMs = Date.parse(PLAN.expiresAt);
      else controller.abort("lock");
      expect(d.nonceState.releaseUnsubmittedReservation).not.toHaveBeenCalled();
      finish.release();
      await rejected;
      expect(d.client.sendTx).not.toHaveBeenCalled();
      expect(d.signer.signCreateOrder).toHaveBeenCalledTimes(phase === "acquisition" ? 0 : 1);
      if (phase !== "acquisition") expect(d.intents.markSigned).toHaveBeenCalledOnce();
      if (phase === "send-admission") {
        expect(d.intents.markExpiredUnsubmitted).not.toHaveBeenCalled();
        expect(d.nonceState.releaseUnsubmittedReservation).not.toHaveBeenCalled();
        expect(d.intents.markAmbiguous).toHaveBeenCalledOnce();
      } else {
        expect(d.nonceState.releaseUnsubmittedReservation).toHaveBeenCalledWith({
          environment: PLAN.environment, accountIndex: PLAN.accountIndex, apiKeyIndex: PLAN.apiKeyIndex,
          reservationId: `lighter-order:${PLAN.intentId}`, nonceValue: "0",
        });
      }
      const publicEvidence = JSON.stringify(vi.mocked(d.intents.markSigned).mock.calls);
      expect(publicEvidence).not.toContain(TX_INFO);
      expect(publicEvidence).not.toContain(PRIVATE_KEY);
    });
  }

  it("retains signed evidence across a failed evidence write without signing again", async () => {
    const d = deps(), controller = new AbortController();
    vi.mocked(d.intents.markSigned).mockRejectedValueOnce(new Error("database unavailable"));
    vi.mocked(d.signer.signCreateOrder).mockImplementation(async (input) => {
      controller.abort("lock");
      return deps().signer.signCreateOrder(input);
    });
    await expect(executeApprovedLighterCreateOrder({ plan: PLAN, deps: d, abortSignal: controller.signal }))
      .rejects.toMatchObject({ reason: "cancelled_after_signing" });
    expect(d.intents.markSigned).toHaveBeenCalledTimes(2);
    expect(d.intents.markSigned).toHaveBeenLastCalledWith(expect.objectContaining({ signerTxHash: TX_HASH }));
    expect(d.signer.signCreateOrder).toHaveBeenCalledOnce();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("reports known provider evidence even if consent is revoked during send", async () => {
    let nowMs = NOW;
    const d = deps({ now: () => nowMs }), controller = new AbortController();
    vi.mocked(d.client.sendTx).mockImplementation(async () => {
      controller.abort("lock");
      nowMs = Date.parse(PLAN.expiresAt);
      return { code: 200, tx_hash: TX_HASH, predicted_execution_time_ms: 1 };
    });
    vi.mocked(d.client.getAccountActiveOrders)
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValueOnce({ code: 200, orders: [accountOrder()] });
    const result = await executeApprovedLighterCreateOrder({ plan: PLAN, deps: d, abortSignal: controller.signal });
    expect(result).toMatchObject({ status: "provider_confirmed", executionState: "open" });
    expect(d.intents.markExpiredUnsubmitted).not.toHaveBeenCalled();
    expect(d.intents.markAmbiguous).not.toHaveBeenCalled();
    expect(d.client.sendTx).toHaveBeenCalledOnce();
  });
});


/**
 * THE SIGNER SETTLEMENT CONTRACT, proved in composition (round-1 fix F2).
 *
 * No mock stands between the executor and the evidence here: the real binary
 * adapter projects a real `runLighterSignerBinary` run over a scripted child,
 * and the executor decides on what that produced. A test that hands the
 * executor a hand-built signer result decides the answer itself and proves
 * nothing about who owns the contract.
 */
describe("Lighter create-order signer settlement contract", () => {
  const AUTH_DOCUMENT = { ok: true, authToken: AUTH_TOKEN, publicKey: PUBLIC_KEY };
  const ORDER_DOCUMENT = { ok: true, txType: 14, txInfo: TX_INFO, txHash: TX_HASH };

  function compositionDeps(
    signRunner: LighterSignerBinaryRunner,
    overrides: Partial<ExecuteApprovedLighterCreateOrderDeps> = {},
  ): ExecuteApprovedLighterCreateOrderDeps {
    const authAdapter = createLighterSignerBinaryAdapter({
      binaryPath: "/tmp/vex-lighter-signer-test",
      runner: signerRunnerEmitting(AUTH_DOCUMENT),
    });
    const signAdapter = createLighterSignerBinaryAdapter({
      binaryPath: "/tmp/vex-lighter-signer-test",
      // Small enough that a child which never closes is killed inside the test.
      timeoutMs: 5,
      runner: signRunner,
    });
    return deps({
      signer: {
        source: "official_lighter_signer",
        createAccountAuth: authAdapter.createAccountAuth,
        signCreateOrder: signAdapter.signCreateOrder,
      },
      ...overrides,
    });
  }

  const RELEASE = {
    environment: PLAN.environment,
    accountIndex: PLAN.accountIndex,
    apiKeyIndex: PLAN.apiKeyIndex,
    reservationId: `lighter-order:${PLAN.intentId}`,
    nonceValue: "0",
  };

  it("retires an order signed before consent expiry and releases its nonce", async () => {
    let nowMs = NOW;
    const d = compositionDeps(
      signerRunnerEmitting(() => {
        // Consent lapses between the signature and the pre-submission recheck.
        nowMs = Date.parse(PLAN.expiresAt);
        return ORDER_DOCUMENT;
      }),
      { now: () => nowMs },
    );

    await expect(executeApprovedLighterCreateOrder({ plan: PLAN, deps: d }))
      .rejects.toMatchObject({ reason: "consent_expired_after_signing" });

    expect(d.intents.markExpiredUnsubmitted).toHaveBeenCalledWith(expect.objectContaining({
      signerTxHash: TX_HASH, reason: "consent_expired_after_signing",
    }));
    // The schema proves this transition never started a send, so the capital it
    // reserved is released now, not after the ledger's observation lag.
    expect(ledger.retired).toContainEqual({
      intentId: PLAN.intentId, reason: "expired_unsubmitted",
    });
    expect(d.nonceState.releaseUnsubmittedReservation).toHaveBeenCalledWith(RELEASE);
    expect(d.intents.markAmbiguous).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("releases the nonce when the signer child provably exited without signing", async () => {
    const d = compositionDeps(signerRunnerExitingWithoutOutput());

    await expect(executeApprovedLighterCreateOrder({ plan: PLAN, deps: d })).rejects.toThrow();

    expect(d.intents.markUnsubmittedRefused).toHaveBeenCalledWith(expect.objectContaining({
      reason: "pre_sign_refused",
    }));
    expect(ledger.retired).toContainEqual({
      intentId: PLAN.intentId, reason: "refused_unsubmitted",
    });
    expect(d.nonceState.releaseUnsubmittedReservation).toHaveBeenCalledWith(RELEASE);
    expect(d.intents.markAmbiguous).not.toHaveBeenCalled();
  });

  it.each([
    ["a child that never closed", signerRunnerNeverClosing],
    ["a failure that never reached the child", signerRunnerRejectingWithoutEvidence],
  ])("keeps the nonce reserved after %s", async (_name, runner) => {
    const d = compositionDeps(runner());

    await expect(executeApprovedLighterCreateOrder({ plan: PLAN, deps: d })).rejects.toThrow();

    expect(d.intents.markAmbiguous).toHaveBeenCalledOnce();
    expect(d.nonceState.releaseUnsubmittedReservation).not.toHaveBeenCalled();
    expect(d.intents.markUnsubmittedRefused).not.toHaveBeenCalled();
    expect(d.intents.markExpiredUnsubmitted).not.toHaveBeenCalled();
  });
});

/**
 * FILLS CONFIRMED FROM ORDER EVIDENCE, measured live on 2026-09-08.
 *
 * One IOC buy settled from an inactive-order read (status filled) and returned
 * `executionState: "filled"`. The trade branch below it was never reached, so
 * nothing observed the trade and `lighter_fills` stayed EMPTY - the fill
 * existed on the venue and in Vex's own terminal outcome, and AgentScan would
 * never have heard of it. These tests drive the real executor and assert the
 * ledger row, not a call count.
 */
function fillLedger() {
  const rows = new Map<string, LighterFillRecord>();
  const recordFill = vi.fn<LighterFillObservationDeps["recordFill"]>(async (record) => {
    if (rows.has(record.canonicalIdentity)) return { kind: "duplicate", fillId: 1 };
    rows.set(record.canonicalIdentity, record);
    return { kind: "recorded", fillId: rows.size };
  });
  return { rows, recordFill };
}

function fillObservationDeps(
  recordFill: LighterFillObservationDeps["recordFill"],
): LighterFillObservationDeps {
  resetLighterMarketAssetsCache();
  return {
    client: {
      getMarketDetails: vi.fn<LighterFillObservationDeps["client"]["getMarketDetails"]>(async () => ({
        code: 200,
        order_book_details: [MARKET],
        spot_order_book_details: [],
      })),
      getAssetDetails: vi.fn<LighterFillObservationDeps["client"]["getAssetDetails"]>(async () => ({
        code: 200,
        asset_details: [
          // The Robinhood Chain collateral as Lighter lists it: asset 3, the
          // deployment's pinned USDG proxy, six decimals on both sides.
          { asset_id: 3, symbol: "USDG", l1_decimals: 6, decimals: 6, min_transfer_amount: "0", l1_address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" },
          { asset_id: 1, symbol: "ETH", l1_decimals: 18, decimals: 18, min_transfer_amount: "0", l1_address: "0x" },
        ],
      })),
    },
    recordFill,
    findFeeAuthorization: vi.fn<LighterFillObservationDeps["findFeeAuthorization"]>(async () => null),
    recordedFillBaseSize: vi.fn<LighterFillObservationDeps["recordedFillBaseSize"]>(async () => "0"),
  };
}

/** The live trade record of the fill the order evidence above proves. */
function settledTrade(overrides: Partial<LighterTrade> = {}): LighterTrade {
  return {
    trade_id: 491032980,
    trade_id_str: "491032980",
    tx_hash: "176f5ad254b7604e6d59f658607947b873979dc979ad16f680ecf08fa00c04fc0d7d91e1d3746ee3",
    type: "trade",
    market_id: PLAN.marketIndex,
    size: "0.0050",
    price: "2484.97",
    usd_amount: "12.424850",
    ask_id: 281475039427104,
    ask_id_str: "281475039427104",
    bid_id: 562949887334777,
    bid_id_str: "562949887334777",
    ask_account_id: 16948,
    bid_account_id: PLAN.accountIndex,
    is_maker_ask: true,
    block_height: 18912426,
    timestamp: 1788863950104,
    transaction_time: 1788863950329557,
    integrator_taker_fee: 1000,
    integrator_taker_fee_collector_index: 22869,
    taker_fee: 350,
    ask_client_id: 181836669862286,
    bid_client_id: Number(UNSIGNED_ORDER.clientOrderIndex),
    ask_client_id_str: "181836669862286",
    bid_client_id_str: UNSIGNED_ORDER.clientOrderIndex,
    taker_position_size_before: "0.0000",
    taker_entry_quote_before: "0.000000",
    taker_position_sign_changed: true,
    maker_position_size_before: "0.0000",
    maker_entry_quote_before: "0.000000",
    maker_position_sign_changed: true,
    ask_order_version: 0,
    bid_order_version: 0,
    ...overrides,
  };
}

function filledInactiveOrder() {
  return accountOrder({
    status: "filled",
    filled_base_amount: "1",
    remaining_base_amount: "0",
    filled_quote_amount: "3000",
  });
}

describe("Lighter create execution: the settlement poll", () => {
  it("takes an inactive-order answer on the first round, without waiting", async () => {
    // A market IOC never rests, so it is inactive from the moment it executes.
    // The poll used to read active orders three times before ever looking at
    // the list the answer was always in, sleeping between each miss.
    const d = deps();
    vi.mocked(d.client.getAccountActiveOrders).mockResolvedValue({ code: 200, orders: [] });
    vi.mocked(d.client.getAccountInactiveOrders)
      // The pre-submission duplicate check reads this list too, and must not
      // see the order it is about to send.
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValue({ code: 200, orders: [filledInactiveOrder()] });

    const result = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });

    expect(result).toMatchObject({ status: "provider_confirmed", executionState: "filled" });
    // One pre-submission check of each list, then ONE settlement round that
    // answers. `wait` never running is the proof the poll did not retry.
    expect(d.client.getAccountInactiveOrders).toHaveBeenCalledTimes(2);
    expect(d.client.getAccountActiveOrders).toHaveBeenCalledTimes(2);
    expect(d.wait).not.toHaveBeenCalled();
  });

  it("waits the time still left until the provider's predicted execution", async () => {
    // `predicted_execution_time_ms` is an INSTANT. Read as a duration it fed
    // the clamp an epoch figure, so every wait pinned to the 2s ceiling.
    const d = deps({
      client: {
        ...deps().client,
        sendTx: vi.fn(async () => ({
          code: 200,
          message: PROVIDER_SUBMIT_MESSAGE,
          tx_hash: TX_HASH,
          predicted_execution_time_ms: NOW + 400,
          volume_quota_remaining: 99,
        })),
      },
    });
    vi.mocked(d.client.getAccountActiveOrders).mockResolvedValue({ code: 200, orders: [] });
    vi.mocked(d.client.getAccountInactiveOrders).mockResolvedValue({ code: 200, orders: [] });

    await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });

    expect(d.wait).toHaveBeenNthCalledWith(1, 400);
    expect(d.wait).toHaveBeenNthCalledWith(2, 800);
  });

  it("floors the wait when the predicted instant has already passed", async () => {
    const d = deps({
      client: {
        ...deps().client,
        sendTx: vi.fn(async () => ({
          code: 200,
          message: PROVIDER_SUBMIT_MESSAGE,
          tx_hash: TX_HASH,
          predicted_execution_time_ms: NOW - 5_000,
          volume_quota_remaining: 99,
        })),
      },
    });
    vi.mocked(d.client.getAccountActiveOrders).mockResolvedValue({ code: 200, orders: [] });
    vi.mocked(d.client.getAccountInactiveOrders).mockResolvedValue({ code: 200, orders: [] });

    await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });

    // Already due: poll promptly rather than sleeping out a ceiling.
    expect(d.wait).toHaveBeenNthCalledWith(1, 100);
  });
});

describe("Lighter create execution: an ORDER-evidence fill still reaches the ledger", () => {
  it("spends no read when the ledger already holds the whole reported fill", async () => {
    // The account order stream watches the same order and on a fast fill
    // records the trade first. This follow-up then re-derived the market, the
    // assets and the trade page only to report that it held nothing new -
    // six seconds on the trader's critical path, measured live.
    const { recordFill } = fillLedger();
    const fills = fillObservationDeps(recordFill);
    // Level with the venue: the inactive order reports `filled_base_amount: "1"`.
    vi.mocked(fills.recordedFillBaseSize).mockResolvedValue("1");
    const d = deps({ fills });
    vi.mocked(d.client.getAccountInactiveOrders)
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValue({ code: 200, orders: [filledInactiveOrder()] });
    const result = await executeApprovedLighterCreateOrder({
      plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d,
    });

    expect(result).toMatchObject({ status: "provider_confirmed", executionState: "filled" });
    // The outcome still committed; only the redundant follow-up was skipped.
    // The one remaining trade read is the pre-submission duplicate check,
    // which runs before anything is signed.
    expect(d.client.getAccountTrades).toHaveBeenCalledTimes(1);
    expect(recordFill).not.toHaveBeenCalled();
  });

  it("still reads when the ledger is BEHIND the reported fill, not merely non-empty", async () => {
    // The gate is a completeness test. A partial fill already recorded must
    // never excuse the rest, which is how gating on mere existence loses a
    // late second fill for good.
    const { recordFill } = fillLedger();
    const fills = fillObservationDeps(recordFill);
    vi.mocked(fills.recordedFillBaseSize).mockResolvedValue("0.5");
    const d = deps({ fills });
    vi.mocked(d.client.getAccountInactiveOrders)
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValue({ code: 200, orders: [filledInactiveOrder()] });
    vi.mocked(d.client.getAccountTrades)
      .mockResolvedValueOnce({ code: 200, trades: [] })
      .mockResolvedValue({ code: 200, trades: [settledTrade()] });

    await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });

    expect(recordFill).toHaveBeenCalled();
  });

  it("records the fill an inactive-order confirmation proves", async () => {
    const { rows, recordFill } = fillLedger();
    const d = deps({ fills: fillObservationDeps(recordFill) });
    vi.mocked(d.client.getAccountInactiveOrders)
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValue({ code: 200, orders: [filledInactiveOrder()] });
    vi.mocked(d.client.getAccountTrades)
      .mockResolvedValueOnce({ code: 200, trades: [] })
      .mockResolvedValue({ code: 200, trades: [settledTrade()] });

    const result = await executeApprovedLighterCreateOrder({
      plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d,
    });

    expect(result).toMatchObject({
      status: "provider_confirmed", executionState: "filled", evidenceSource: "inactive_order",
    });
    const recorded = rows.get("lighter:rhc:42:0:491032980");
    expect(recorded).toBeDefined();
    expect(recorded?.executionIntentId).toBe(PLAN.intentId);
    expect(recorded?.tradeType).toBe("trade");
    expect(recorded?.usdAmount).toBe("12.424850");
    // MEASURED, not assumed: the authenticated trades page carries the
    // position "before" fields but no realized PnL for either side, so the
    // account half of the record is incomplete and the position effect stays
    // NULL rather than being guessed. It is established later, once, by an
    // observation that carries the PnL.
    expect(recorded?.positionEffect).toBeNull();
    expect(recorded?.accountFacts).toBeNull();
    expect(recorded?.integratorFeeTickObserved).toBe(1000);
    expect(recorded?.exchangeFeeTickObserved).toBe(350);
  });

  it("records the fill the stream confirmed while the REST lookup was in flight", async () => {
    const { rows, recordFill } = fillLedger();
    const d = deps({ fills: fillObservationDeps(recordFill) });
    vi.mocked(d.client.getAccountInactiveOrders)
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValue({ code: 200, orders: [filledInactiveOrder()] });
    vi.mocked(d.client.getAccountTrades)
      .mockResolvedValueOnce({ code: 200, trades: [] })
      .mockResolvedValue({ code: 200, trades: [settledTrade()] });
    vi.mocked(d.intents.markProviderOutcome).mockResolvedValue(null);
    vi.mocked(d.intents.findByIntentIdAnySession).mockResolvedValue({
      ...APPROVED_INTENT_ROW, executionState: "filled", clientOrderIndex: UNSIGNED_ORDER.clientOrderIndex,
      providerOrderId: "123", providerOrderStatus: "filled", providerOutcomeSource: "inactive_order",
      providerOutcomeJson: { filledBaseAmount: "1", remainingBaseAmount: "0", filledQuoteAmount: "3000" },
    });

    const result = await executeApprovedLighterCreateOrder({
      plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d,
    });

    expect(result).toMatchObject({ status: "provider_confirmed", executionState: "filled" });
    expect([...rows.keys()]).toEqual(["lighter:rhc:42:0:491032980"]);
  });

  it("leaves the confirmed outcome untouched when the follow-up trades read fails", async () => {
    const { rows, recordFill } = fillLedger();
    const d = deps({ fills: fillObservationDeps(recordFill) });
    vi.mocked(d.client.getAccountInactiveOrders)
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValue({ code: 200, orders: [filledInactiveOrder()] });
    vi.mocked(d.client.getAccountTrades)
      .mockResolvedValueOnce({ code: 200, trades: [] })
      .mockRejectedValue(new Error("provider unreachable"));

    const result = await executeApprovedLighterCreateOrder({
      plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d,
    });

    expect(result).toMatchObject({
      status: "provider_confirmed", executionState: "filled", evidenceSource: "inactive_order",
    });
    expect(d.intents.markAmbiguous).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
  });

  it("records nothing twice when the same trade is observed again", async () => {
    const { rows, recordFill } = fillLedger();
    const fills = fillObservationDeps(recordFill);
    const run = async () => {
      const d = deps({ fills });
      vi.mocked(d.client.getAccountInactiveOrders)
        .mockResolvedValueOnce({ code: 200, orders: [] })
        .mockResolvedValue({ code: 200, orders: [filledInactiveOrder()] });
      vi.mocked(d.client.getAccountTrades)
        .mockResolvedValueOnce({ code: 200, trades: [] })
        .mockResolvedValue({ code: 200, trades: [settledTrade()] });
      return executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });
    };

    await run();
    await run();

    expect(recordFill).toHaveBeenCalledTimes(2);
    expect([...rows.keys()]).toEqual(["lighter:rhc:42:0:491032980"]);
  });

  it("does not read the trades again when the trade branch already observed them", async () => {
    const { rows, recordFill } = fillLedger();
    const d = deps({ fills: fillObservationDeps(recordFill) });
    vi.mocked(d.client.getAccountTrades)
      .mockResolvedValueOnce({ code: 200, trades: [] })
      .mockResolvedValue({ code: 200, trades: [settledTrade()] });

    const result = await executeApprovedLighterCreateOrder({
      plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d,
    });

    expect(result).toMatchObject({ evidenceSource: "account_trade" });
    // One preflight read plus the trade branch's own read, and no third.
    expect(d.client.getAccountTrades).toHaveBeenCalledTimes(2);
    expect([...rows.keys()]).toEqual(["lighter:rhc:42:0:491032980"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 7 preflight switches. Every OFF value must be today's path exactly,
// and every ON value must refuse and record exactly what OFF does.
// ---------------------------------------------------------------------------

const CACHED_AUTH_TOKEN = `1893456300:42:7:${"c".repeat(128)}`;
const READ_AUTH_SCOPE = {
  environment: PLAN.environment,
  accountIndex: PLAN.accountIndex,
  apiKeyIndex: PLAN.apiKeyIndex,
};

function delayedRejection(error: unknown, delayMs: number): () => Promise<never> {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    throw error;
  };
}

interface PreflightObservation {
  readonly outcome: Record<string, unknown>;
  readonly effects: Record<string, unknown>;
}

async function observeCreateOrder(
  d: ExecuteApprovedLighterCreateOrderDeps,
  plan: LighterOrderReadyForSignerPlan = PLAN,
  sessionWallet?: LighterSigningOwnershipWallet,
): Promise<PreflightObservation> {
  let outcome: Record<string, unknown>;
  try {
    outcome = {
      resolved: await executeApprovedLighterCreateOrder({
        plan,
        unsignedOrder: buildLighterUnsignedCreateOrderRequest(plan),
        deps: d,
        ...(sessionWallet === undefined ? {} : { sessionWallet }),
      }),
    };
  } catch (error) {
    outcome = error instanceof VexError
      ? { rejected: { name: error.name, code: error.code, message: error.message, hint: error.hint, retryable: error.retryable } }
      : { rejected: { message: error instanceof Error ? error.message : String(error) } };
  }
  return {
    outcome,
    effects: {
      findFreshById: vi.mocked(d.previews.findFreshById).mock.calls,
      markPreSubmitRevalidated: vi.mocked(d.intents.markPreSubmitRevalidated).mock.calls,
      readTradingApiPrivateKey: vi.mocked(d.secretReader.readTradingApiPrivateKey).mock.calls,
      createAccountAuth: vi.mocked(d.signer.createAccountAuth).mock.calls.length,
      accountActiveOrders: vi.mocked(d.client.getAccountActiveOrders).mock.calls,
      accountInactiveOrders: vi.mocked(d.client.getAccountInactiveOrders).mock.calls,
      accountTrades: vi.mocked(d.client.getAccountTrades).mock.calls,
      recordExecutionObserved: vi.mocked(d.nonceState.recordExecutionObserved).mock.calls,
      reserveNonce: vi.mocked(d.reserveNonce).mock.calls,
      signCreateOrder: vi.mocked(d.signer.signCreateOrder).mock.calls.length,
      markSigned: vi.mocked(d.intents.markSigned).mock.calls,
      markSubmitted: vi.mocked(d.intents.markSubmitted).mock.calls,
      sendTx: vi.mocked(d.client.sendTx).mock.calls,
      markAmbiguous: vi.mocked(d.intents.markAmbiguous).mock.calls,
      markUnsubmittedRefused: vi.mocked(d.intents.markUnsubmittedRefused).mock.calls,
      releaseUnsubmittedReservation: vi.mocked(d.nonceState.releaseUnsubmittedReservation).mock.calls,
      markProviderOutcome: vi.mocked(d.intents.markProviderOutcome).mock.calls,
    },
  };
}

const PREFLIGHT_CASES: readonly {
  readonly label: string;
  readonly build: () => ExecuteApprovedLighterCreateOrderDeps;
  readonly expected: RegExp;
}[] = [
  {
    label: "the approved preview is unavailable",
    build: () => deps({ previews: { findFreshById: vi.fn(async () => null) } }),
    expected: /no longer fresh or available/,
  },
  {
    label: "the live price moved beyond the approved worst price",
    build: () => {
      const base = deps();
      return deps({
        client: {
          ...base.client,
          getOrderBookOrders: vi.fn(async () => ({ ...ORDER_BOOK, asks: [{ ...first(ORDER_BOOK.asks), price: "3002.01" }] })),
        },
      });
    },
    expected: /moved beyond the approved market-order worst price/,
  },
  {
    label: "revalidation evidence cannot persist",
    build: () => {
      const base = deps();
      return deps({ intents: { ...base.intents, markPreSubmitRevalidated: vi.fn(async () => null) } });
    },
    expected: /evidence could not be persisted/,
  },
  {
    label: "the market read fails",
    build: () => {
      const base = deps();
      return deps({ client: { ...base.client, getMarketDetails: vi.fn(async () => { throw new Error("market down"); }) } });
    },
    expected: /unavailable for post-approval revalidation/,
  },
  {
    label: "Lighter is unreachable during revalidation",
    build: () => {
      const base = deps();
      const offline = new VexError(ErrorCodes.LIGHTER_TIMEOUT, "Request timed out after 10000ms");
      return deps({ client: { ...base.client, getMarketDetails: vi.fn(async () => { throw offline; }) } });
    },
    expected: /couldn't reach Lighter before sending/,
  },
  {
    label: "the next nonce is unavailable",
    build: () => {
      const base = deps();
      return deps({ client: { ...base.client, getNextNonce: vi.fn(async () => { throw new Error("nonce down"); }) } });
    },
    expected: /next nonce is unavailable/,
  },
  {
    label: "the trading key is not registered",
    build: () => {
      const base = deps();
      return deps({ client: { ...base.client, getApiKeys: vi.fn(async () => ({ code: 200, api_keys: [] })) } });
    },
    expected: /not registered for the approved account scope/,
  },
  {
    label: "Lighter is unreachable during the credential read",
    build: () => {
      const base = deps();
      const offline = new VexError(ErrorCodes.LIGHTER_TIMEOUT, "Request timed out after 10000ms");
      return deps({ client: { ...base.client, getApiKeys: vi.fn(async () => { throw offline; }) } });
    },
    expected: /couldn't reach Lighter before sending/,
  },
  {
    label: "both fail, the credential first: the revalidation refusal wins",
    build: () => {
      const base = deps();
      return deps({
        client: {
          ...base.client,
          getMarketDetails: vi.fn(delayedRejection(new Error("market down"), 5)),
          getNextNonce: vi.fn(async () => { throw new Error("nonce down"); }),
        },
      });
    },
    expected: /unavailable for post-approval revalidation/,
  },
  {
    label: "both fail: an unreachable revalidation wins over a credential refusal",
    build: () => {
      const base = deps();
      return deps({
        client: {
          ...base.client,
          getMarketDetails: vi.fn(delayedRejection(new VexError(ErrorCodes.LIGHTER_TIMEOUT, "market timed out"), 5)),
          getApiKeys: vi.fn(async () => ({ code: 200, api_keys: [] })),
        },
      });
    },
    expected: /couldn't reach Lighter before sending/,
  },
  {
    label: "both fail: a revalidation refusal wins over an unreachable credential read",
    build: () => {
      const base = deps();
      return deps({
        client: {
          ...base.client,
          getMarketDetails: vi.fn(delayedRejection(new Error("market down"), 5)),
          getNextNonce: vi.fn(async () => { throw new VexError(ErrorCodes.LIGHTER_TIMEOUT, "nonce timed out"); }),
        },
      });
    },
    expected: /unavailable for post-approval revalidation/,
  },
  {
    label: "both unreachable: the revalidation's own transport text is the one restated",
    build: () => {
      const base = deps();
      return deps({
        client: {
          ...base.client,
          getMarketDetails: vi.fn(delayedRejection(new VexError(ErrorCodes.LIGHTER_TIMEOUT, "market timed out"), 5)),
          getNextNonce: vi.fn(async () => { throw new VexError(ErrorCodes.LIGHTER_API_ERROR, "nonce fetch failed"); }),
        },
      });
    },
    expected: /market timed out/,
  },
  {
    label: "the vault key does not match the registered key",
    build: () => {
      const base = deps();
      return deps({
        signer: {
          ...base.signer,
          createAccountAuth: vi.fn<ExecuteApprovedLighterCreateOrderDeps["signer"]["createAccountAuth"]>(async (input) => ({
            ...(await base.signer.createAccountAuth(input)),
            publicKey: "c".repeat(80),
          })),
        },
      });
    },
    expected: /does not match the public key/,
  },
  {
    label: "the client order id already has provider evidence",
    build: () => {
      const base = deps();
      return deps({
        client: {
          ...base.client,
          getAccountInactiveOrders: vi.fn(async () => ({
            code: 200,
            orders: [accountOrder({ status: "filled", filled_base_amount: "1", remaining_base_amount: "0" })],
          })),
        },
      });
    },
    expected: /same Vex client order id/,
  },
  {
    label: "an earlier action still holds the nonce",
    build: () => deps({
      nonceState: {
        releaseUnsubmittedReservation: vi.fn(async () => null),
        recordExecutionObserved: vi.fn(async () => null),
      },
      recoverNonce: vi.fn(async () => ({})),
    }),
    expected: /Vex clears the blocking reservation automatically/,
  },
];

describe("LIGHTER_ORDER_PARALLEL_PREFLIGHT", () => {
  it("ships ON", () => {
    expect(LIGHTER_ORDER_PARALLEL_PREFLIGHT).toBe(true);
  });

  it.each(PREFLIGHT_CASES)("refuses and records exactly what OFF does when $label", async ({ build, expected }) => {
    const off = await observeCreateOrder({ ...build(), parallelPreflight: false });
    const { parallelPreflight: _pinned, ...unpinned } = build();
    const absent = await observeCreateOrder(unpinned);
    const on = await observeCreateOrder({ ...build(), parallelPreflight: true });

    expect(JSON.stringify(off.outcome)).toMatch(expected);
    expect(absent).toEqual(off);
    expect(on).toEqual(off);
  });

  it("returns the same result and persists the same revalidation evidence on success", async () => {
    const off = await observeCreateOrder({ ...deps(), parallelPreflight: false });
    const on = await observeCreateOrder({ ...deps(), parallelPreflight: true });

    expect(off.outcome).toMatchObject({ resolved: { status: "sequencer_pending" } });
    expect(on).toEqual(off);
  });

  it("overlaps the credential read with revalidation and loads the key only after both", async () => {
    const revalidationGate = createGate();
    const credentialGate = createGate();
    const base = deps();
    const markPreSubmitRevalidated = vi.fn(async () => {
      await revalidationGate.promise;
      return APPROVED_INTENT_ROW;
    });
    const getNextNonce = vi.fn(async () => {
      await credentialGate.promise;
      return { code: 200, nonce: 0 };
    });
    const d = deps({
      client: { ...base.client, getNextNonce },
      intents: { ...base.intents, markPreSubmitRevalidated },
      parallelPreflight: true,
    });

    const execution = executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });

    await vi.waitFor(() => {
      expect(markPreSubmitRevalidated).toHaveBeenCalledTimes(1);
      expect(getNextNonce).toHaveBeenCalledTimes(1);
    });
    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();

    credentialGate.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.signer.createAccountAuth).not.toHaveBeenCalled();

    revalidationGate.release();
    const result = await execution;
    expect(d.secretReader.readTradingApiPrivateKey).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("sequencer_pending");
  });

  it("never loads the key when revalidation fails after the credential read succeeded", async () => {
    const base = deps();
    const d = deps({
      client: { ...base.client, getMarketDetails: vi.fn(delayedRejection(new Error("market down"), 5)) },
      parallelPreflight: true,
    });

    await expect(executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d }))
      .rejects.toThrow("unavailable for post-approval revalidation");
    expect(d.client.getNextNonce).toHaveBeenCalledTimes(1);
    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.nonceState.recordExecutionObserved).not.toHaveBeenCalled();
    expect(d.reserveNonce).not.toHaveBeenCalled();
  });
});

describe("LighterReadAuthCache", () => {
  it("hands out a token only inside its TTL and well before its own deadline", () => {
    const cache = new LighterReadAuthCache();
    const deadlineUnixSeconds = Math.floor(NOW / 1_000) + 600;
    cache.remember(READ_AUTH_SCOPE, { token: CACHED_AUTH_TOKEN, publicKey: `0x${PUBLIC_KEY.toUpperCase()}`, deadlineUnixSeconds }, NOW);

    expect(cache.get(READ_AUTH_SCOPE, NOW)).toEqual({
      token: CACHED_AUTH_TOKEN,
      publicKey: PUBLIC_KEY,
      storedAtMs: NOW,
      deadlineMs: deadlineUnixSeconds * 1_000,
    });
    expect(cache.get(READ_AUTH_SCOPE, NOW + LIGHTER_READ_AUTH_CACHE_TTL_MS - 1)).not.toBeNull();
    expect(cache.get(READ_AUTH_SCOPE, NOW + LIGHTER_READ_AUTH_CACHE_TTL_MS)).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("refuses to remember a token with too little life left, and never serves one stored in the future", () => {
    const cache = new LighterReadAuthCache();
    cache.remember(READ_AUTH_SCOPE, { token: CACHED_AUTH_TOKEN, publicKey: PUBLIC_KEY, deadlineUnixSeconds: Math.floor(NOW / 1_000) + 120 }, NOW);
    expect(cache.size).toBe(0);

    cache.remember(READ_AUTH_SCOPE, { token: CACHED_AUTH_TOKEN, publicKey: PUBLIC_KEY, deadlineUnixSeconds: Math.floor(NOW / 1_000) + 600 }, NOW);
    expect(cache.get(READ_AUTH_SCOPE, NOW - 1)).toBeNull();
  });

  it("invalidates by environment, account and key index", () => {
    const cache = new LighterReadAuthCache();
    const deadlineUnixSeconds = Math.floor(NOW / 1_000) + 600;
    const other = { ...READ_AUTH_SCOPE, apiKeyIndex: 8 };
    cache.remember(READ_AUTH_SCOPE, { token: CACHED_AUTH_TOKEN, publicKey: PUBLIC_KEY, deadlineUnixSeconds }, NOW);
    cache.remember(other, { token: CACHED_AUTH_TOKEN, publicKey: PUBLIC_KEY, deadlineUnixSeconds }, NOW);

    cache.invalidate({ environment: "core" });
    expect(cache.size).toBe(2);
    cache.invalidate({ environment: "rhc", accountIndex: 42, apiKeyIndex: 8 });
    expect(cache.get(other, NOW)).toBeNull();
    expect(cache.get(READ_AUTH_SCOPE, NOW)).not.toBeNull();
    cache.invalidate();
    expect(cache.size).toBe(0);
  });
});

describe("LIGHTER_READ_AUTH_CACHE", () => {
  function primedCache(publicKey = PUBLIC_KEY): LighterReadAuthCache {
    const cache = new LighterReadAuthCache();
    cache.remember(READ_AUTH_SCOPE, { token: CACHED_AUTH_TOKEN, publicKey, deadlineUnixSeconds: Math.floor(NOW / 1_000) + 600 }, NOW);
    return cache;
  }

  function tokensUsedBy(calls: readonly (readonly unknown[])[]): unknown[] {
    return calls.map((call) => {
      const auth = call[2];
      return typeof auth === "object" && auth !== null && "token" in auth ? auth.token : null;
    });
  }

  function withoutAccountReads(effects: Record<string, unknown>): Record<string, unknown> {
    const { accountActiveOrders: _active, accountInactiveOrders: _inactive, accountTrades: _trades, ...rest } = effects;
    return rest;
  }

  it("ships ON, and OFF (null) leaves the process cache untouched by a whole order", async () => {
    expect(LIGHTER_READ_AUTH_CACHE).toBe(true);
    lighterReadAuthCache.invalidate();
    const result = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: deps({ readAuthCache: null }) });
    expect(result.status).toBe("sequencer_pending");
    expect(lighterReadAuthCache.size).toBe(0);
  });

  it.each(PREFLIGHT_CASES)("ON with an empty cache refuses and records exactly what OFF does when $label", async ({ build }) => {
    const off = await observeCreateOrder({ ...build(), readAuthCache: null });
    const on = await observeCreateOrder({ ...build(), readAuthCache: new LighterReadAuthCache() });
    expect(on).toEqual(off);
  });

  it.each(PREFLIGHT_CASES)("ON with a primed cache refuses with exactly what OFF does when $label", async ({ build }) => {
    const off = await observeCreateOrder({ ...build(), readAuthCache: null });
    const on = await observeCreateOrder({ ...build(), readAuthCache: primedCache() });
    expect(on.outcome).toEqual(off.outcome);
    // Every durable write and every key, nonce and send step is identical;
    // only which token the duplicate-evidence reads carried may differ.
    expect(withoutAccountReads(on.effects)).toEqual(withoutAccountReads(off.effects));
  });

  it("remembers the fresh token only after Lighter accepted it for the duplicate-evidence reads", async () => {
    const cache = new LighterReadAuthCache();
    const result = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: deps({ readAuthCache: cache }) });

    expect(result.status).toBe("sequencer_pending");
    expect(cache.get(READ_AUTH_SCOPE, NOW)).toMatchObject({ token: AUTH_TOKEN, publicKey: PUBLIC_KEY });
    expect(JSON.stringify(cache.get(READ_AUTH_SCOPE, NOW))).not.toContain(PRIVATE_KEY.slice(2));
  });

  it("runs the duplicate-evidence reads in the first batch with the cached token, and still proves the fresh key", async () => {
    const revalidationGate = createGate();
    const base = deps();
    const markPreSubmitRevalidated = vi.fn(async () => {
      await revalidationGate.promise;
      return APPROVED_INTENT_ROW;
    });
    const d = deps({
      intents: { ...base.intents, markPreSubmitRevalidated },
      readAuthCache: primedCache(),
    });

    const execution = executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });
    await vi.waitFor(() => {
      expect(markPreSubmitRevalidated).toHaveBeenCalledTimes(1);
      expect(d.client.getAccountActiveOrders).toHaveBeenCalledTimes(1);
      expect(d.client.getAccountInactiveOrders).toHaveBeenCalledTimes(1);
      expect(d.client.getAccountTrades).toHaveBeenCalledTimes(1);
    });
    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();

    revalidationGate.release();
    const result = await execution;

    expect(result.status).toBe("sequencer_pending");
    expect(d.secretReader.readTradingApiPrivateKey).toHaveBeenCalledTimes(1);
    expect(d.signer.createAccountAuth).toHaveBeenCalledTimes(1);
    // One cached-token read per list before sending; the settlement reads after
    // sendTx carry the freshly minted token exactly as today.
    expect(tokensUsedBy(vi.mocked(d.client.getAccountTrades).mock.calls)).toEqual([CACHED_AUTH_TOKEN, AUTH_TOKEN]);
    expect(tokensUsedBy(vi.mocked(d.client.getAccountActiveOrders).mock.calls).slice(0, 2)).toEqual([CACHED_AUTH_TOKEN, AUTH_TOKEN]);
  });

  it("drops the entry and reads again with the fresh token after any cached-token read failure", async () => {
    const cache = primedCache();
    const base = deps();
    const unauthorized = new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST, "Lighter request failed: 401");
    const getAccountTrades = vi.fn(async (_environment: unknown, _params: unknown, auth?: { readonly token: string }) => {
      if (auth?.token === CACHED_AUTH_TOKEN) throw unauthorized;
      return { code: 200, trades: [] };
    });
    const d = deps({ client: { ...base.client, getAccountTrades }, readAuthCache: cache });

    const result = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });

    expect(result.status).toBe("sequencer_pending");
    expect(tokensUsedBy(getAccountTrades.mock.calls).slice(0, 2)).toEqual([CACHED_AUTH_TOKEN, AUTH_TOKEN]);
    expect(cache.get(READ_AUTH_SCOPE, NOW)).toMatchObject({ token: AUTH_TOKEN });
  });

  it("never trusts a cached answer read for a key other than the one the fresh mint proved", async () => {
    const cache = primedCache("d".repeat(80));
    const d = deps({ readAuthCache: cache });

    const result = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });

    expect(result.status).toBe("sequencer_pending");
    expect(tokensUsedBy(vi.mocked(d.client.getAccountTrades).mock.calls).slice(0, 2)).toEqual([CACHED_AUTH_TOKEN, AUTH_TOKEN]);
    expect(cache.get(READ_AUTH_SCOPE, NOW)).toMatchObject({ token: AUTH_TOKEN, publicKey: PUBLIC_KEY });
  });

  it("drops the entry when the fresh-token reads fail, refusing exactly as today", async () => {
    const cache = primedCache();
    const base = deps();
    const d = deps({
      client: { ...base.client, getAccountActiveOrders: vi.fn(async () => { throw new Error("canonical auth unavailable"); }) },
      readAuthCache: cache,
    });

    await expect(executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d }))
      .rejects.toThrow("provider outcome repair is unavailable");
    expect(cache.size).toBe(0);
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("refuses a duplicate seen with the cached token only at today's point, after the key proof", async () => {
    const base = deps();
    const d = deps({
      client: {
        ...base.client,
        getAccountInactiveOrders: vi.fn(async () => ({
          code: 200,
          orders: [accountOrder({ status: "filled", filled_base_amount: "1", remaining_base_amount: "0" })],
        })),
      },
      readAuthCache: primedCache(),
    });

    await expect(executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d }))
      .rejects.toThrow("same Vex client order id");
    expect(d.signer.createAccountAuth).toHaveBeenCalledTimes(1);
    expect(d.client.getAccountInactiveOrders).toHaveBeenCalledTimes(1);
    expect(d.reserveNonce).not.toHaveBeenCalled();
  });

  it.each(PREFLIGHT_CASES)("composes with the parallel preflight and still refuses as OFF when $label", async ({ build }) => {
    const off = await observeCreateOrder({ ...build(), readAuthCache: null, parallelPreflight: false });
    const on = await observeCreateOrder({ ...build(), readAuthCache: primedCache(), parallelPreflight: true });
    expect(on.outcome).toEqual(off.outcome);
    expect(withoutAccountReads(on.effects)).toEqual(withoutAccountReads(off.effects));
  });
});

describe("LIGHTER_STREAM_REVALIDATION", () => {
  const FRESH_STREAM_BOOK: LighterStreamOrderBookSnapshot = {
    environment: PLAN.environment,
    marketId: PLAN.marketIndex,
    marketType: "perp",
    receivedAtMs: NOW - 200,
    bestAsk: "3001.00",
    bestBid: "2999.00",
  };

  function streamReader(snapshot: LighterStreamOrderBookSnapshot | null = FRESH_STREAM_BOOK) {
    return vi.fn<LighterStreamOrderBookReader>(() => snapshot);
  }

  function persistedEvidence(d: ExecuteApprovedLighterCreateOrderDeps): Record<string, unknown> {
    return first(vi.mocked(d.intents.markPreSubmitRevalidated).mock.calls)[0].evidence;
  }

  /** Revalidation's own book read (limit 250); the margin-fit depth read stays REST. */
  function revalidationBookReads(d: ExecuteApprovedLighterCreateOrderDeps): number {
    return vi.mocked(d.client.getOrderBookOrders).mock.calls
      .filter((call) => call[1].limit === 250)
      .length;
  }

  function withoutRevalidationWrite(effects: Record<string, unknown>): Record<string, unknown> {
    const { markPreSubmitRevalidated: _write, ...rest } = effects;
    return rest;
  }

  it("ships ON, and OFF never consults the stream", async () => {
    expect(LIGHTER_STREAM_REVALIDATION).toBe(true);
    expect(LIGHTER_STREAM_REVALIDATION_MAX_AGE_MS).toBe(1_500);
    const reader = streamReader();
    const d = deps({ streamRevalidation: false, streamOrderBook: reader });

    const result = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });

    expect(result.status).toBe("sequencer_pending");
    expect(reader).not.toHaveBeenCalled();
    expect(revalidationBookReads(d)).toBe(1);
    expect(persistedEvidence(d)).not.toHaveProperty("orderBookSource");
  });

  it("revalidates from a live book younger than the max age, and names the source in the evidence", async () => {
    const off = deps({ streamRevalidation: false });
    const on = deps({ streamRevalidation: true, streamOrderBook: streamReader() });

    const offResult = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: off });
    const onResult = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: on });

    expect(onResult).toEqual(offResult);
    expect(revalidationBookReads(on)).toBe(0);
    expect(revalidationBookReads(off)).toBe(1);
    // Market, account, API key and nonce reads stay REST, call for call.
    for (const read of ["getMarketDetails", "getAccount", "getApiKeys", "getNextNonce"] as const) {
      expect(vi.mocked(on.client[read]).mock.calls).toEqual(vi.mocked(off.client[read]).mock.calls);
    }
    expect(persistedEvidence(on)).toEqual({
      ...persistedEvidence(off),
      orderBookSource: "public_stream",
      orderBookAgeMs: 200,
    });
  });

  it("uses a book exactly at the max age", async () => {
    const d = deps({
      streamRevalidation: true,
      streamOrderBook: streamReader({ ...FRESH_STREAM_BOOK, receivedAtMs: NOW - LIGHTER_STREAM_REVALIDATION_MAX_AGE_MS }),
    });

    await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });

    expect(revalidationBookReads(d)).toBe(0);
    expect(persistedEvidence(d)).toMatchObject({ orderBookAgeMs: LIGHTER_STREAM_REVALIDATION_MAX_AGE_MS });
  });

  const UNUSABLE_STREAM_BOOKS: readonly {
    readonly label: string;
    readonly reader: () => LighterStreamOrderBookReader;
  }[] = [
    { label: "absent", reader: () => streamReader(null) },
    { label: "one millisecond past the max age", reader: () => streamReader({ ...FRESH_STREAM_BOOK, receivedAtMs: NOW - LIGHTER_STREAM_REVALIDATION_MAX_AGE_MS - 1 }) },
    { label: "stamped in the future", reader: () => streamReader({ ...FRESH_STREAM_BOOK, receivedAtMs: NOW + 1 }) },
    { label: "missing its bid side", reader: () => streamReader({ ...FRESH_STREAM_BOOK, bestBid: null }) },
    { label: "missing its ask side", reader: () => streamReader({ ...FRESH_STREAM_BOOK, bestAsk: null }) },
    { label: "crossed", reader: () => streamReader({ ...FRESH_STREAM_BOOK, bestBid: "3001.00" }) },
    { label: "not a decimal", reader: () => streamReader({ ...FRESH_STREAM_BOOK, bestAsk: "3,001.00" }) },
    { label: "for another market", reader: () => streamReader({ ...FRESH_STREAM_BOOK, marketId: PLAN.marketIndex + 1 }) },
    { label: "for another environment", reader: () => streamReader({ ...FRESH_STREAM_BOOK, environment: "core" }) },
    { label: "for another market type", reader: () => streamReader({ ...FRESH_STREAM_BOOK, marketType: "spot" }) },
    {
      label: "unreadable",
      reader: () => vi.fn<LighterStreamOrderBookReader>(() => { throw new Error("stream supervisor stopped"); }),
    },
  ];

  it.each(UNUSABLE_STREAM_BOOKS)("reads REST and records exactly what OFF does when the stream book is $label", async ({ reader }) => {
    const off = await observeCreateOrder(deps({ streamRevalidation: false }));
    const onDeps = deps({ streamRevalidation: true, streamOrderBook: reader() });
    const on = await observeCreateOrder(onDeps);

    expect(on).toEqual(off);
    expect(revalidationBookReads(onDeps)).toBe(1);
  });

  it("refuses exactly as OFF when the late REST book read after a market-type mismatch fails", async () => {
    const failingBook = () => {
      const base = deps();
      return { ...base.client, getOrderBookOrders: vi.fn(async () => { throw new Error("book down"); }) };
    };
    const off = await observeCreateOrder(deps({ client: failingBook(), streamRevalidation: false }));
    const on = await observeCreateOrder(deps({
      client: failingBook(),
      streamRevalidation: true,
      streamOrderBook: streamReader({ ...FRESH_STREAM_BOOK, marketType: "spot" }),
    }));

    expect(JSON.stringify(off.outcome)).toMatch(/unavailable for post-approval revalidation/);
    expect(on).toEqual(off);
  });

  it("refuses a stream price beyond the approved worst price exactly as REST refuses the same price", async () => {
    const base = deps();
    const off = await observeCreateOrder(deps({
      client: {
        ...base.client,
        getOrderBookOrders: vi.fn(async () => ({ ...ORDER_BOOK, asks: [{ ...first(ORDER_BOOK.asks), price: "3002.01" }] })),
      },
      streamRevalidation: false,
    }));
    const onDeps = deps({ streamRevalidation: true, streamOrderBook: streamReader({ ...FRESH_STREAM_BOOK, bestAsk: "3002.01" }) });
    const on = await observeCreateOrder(onDeps);

    expect(JSON.stringify(off.outcome)).toMatch(/moved beyond the approved market-order worst price/);
    expect(on).toEqual(off);
    expect(revalidationBookReads(onDeps)).toBe(0);
    expect(onDeps.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
  });

  it.each(PREFLIGHT_CASES.filter(({ label }) => label !== "the live price moved beyond the approved worst price"))(
    "ON with a fresh stream book refuses as OFF when $label",
    async ({ build }) => {
      const off = await observeCreateOrder({ ...build(), streamRevalidation: false });
      const on = await observeCreateOrder({ ...build(), streamRevalidation: true, streamOrderBook: streamReader() });

      expect(on.outcome).toEqual(off.outcome);
      // Only the revalidation row may differ, by naming the stream as its source.
      expect(withoutRevalidationWrite(on.effects)).toEqual(withoutRevalidationWrite(off.effects));
    },
  );

  it("composes with the parallel preflight and the read-auth cache", async () => {
    const d = deps({
      streamRevalidation: true,
      streamOrderBook: streamReader(),
      parallelPreflight: true,
      readAuthCache: new LighterReadAuthCache(),
    });

    const result = await executeApprovedLighterCreateOrder({ plan: PLAN, unsignedOrder: UNSIGNED_ORDER, deps: d });

    expect(result.status).toBe("sequencer_pending");
    expect(revalidationBookReads(d)).toBe(0);
    expect(persistedEvidence(d)).toMatchObject({ orderBookSource: "public_stream" });
  });
});

// ---------------------------------------------------------------------------
// LIGHTER_REVALIDATION_SINGLE_SNAPSHOT: one snapshot of reads, today's checks.
// ---------------------------------------------------------------------------

const FEE_COLLECTOR_INDEX = 99;
const FEE_COLLECTOR_WALLET = `0x${"2".repeat(40)}`;
const FEE_POLICY = requireValue(feePolicy.resolveLighterFeePolicy("rhc", {
  enabled: true,
  accountIndex: FEE_COLLECTOR_INDEX,
  l1Address: FEE_COLLECTOR_WALLET,
}));
const READ_ONLY_AUTH = { accountIndex: PLAN.accountIndex, token: "read-only-test-token" } as const;
/** A perpetual market whose margin fraction the margin-fit and capital-share checks can price. */
const PRICED_MARKET: LighterMarketDetail = { ...MARKET, default_initial_margin_fraction: 500 };
const SPOT_MARKET: LighterMarketDetail = {
  ...MARKET,
  symbol: "ETH/USDC",
  market_id: 2048,
  market_type: "spot",
  quote_asset_id: 3,
};
const SPOT_ASSETS: LighterAccountAsset[] = [{
  symbol: "USDC",
  asset_id: 3,
  balance: "5000.000000",
  locked_balance: "0.000000",
  margin_balance: "5000.000000",
  margin_mode: "enabled",
  multiplier: "1.000000000000000000",
}];
const VEX_FEE_APPROVAL = [{
  account_index: FEE_COLLECTOR_INDEX,
  name: "VEX",
  max_perps_maker_fee: 1_000_000,
  max_perps_taker_fee: 1_000_000,
  max_spot_maker_fee: 1_000_000,
  max_spot_taker_fee: 1_000_000,
  approval_expiry: NOW + 3_600_000,
}];
const COLLECTOR_ACCOUNT: LighterAccountResponse = {
  code: 200,
  total: 1,
  accounts: [{ index: FEE_COLLECTOR_INDEX, status: 1, l1_address: FEE_COLLECTOR_WALLET }],
};
const SYSTEM_CONFIG: LighterSystemConfigResponse = {
  code: 200,
  liquidity_pool_index: 1,
  staking_pool_index: 2,
  funding_fee_rebate_account_index: 3,
  market_maker_incentive_account_index: 4,
  liquidity_pool_cooldown_period: 0,
  staking_pool_lockup_period: 0,
  max_integrator_perps_maker_fee: 1_000_000,
  max_integrator_perps_taker_fee: 1_000_000,
  max_integrator_spot_maker_fee: 1_000_000,
  max_integrator_spot_taker_fee: 1_000_000,
};
const ACCOUNT_LIMITS: LighterAccountLimitsResponse = {
  code: 200,
  user_tier: "premium",
  user_tier_name: "Premium",
  current_maker_fee_tick: 120,
  current_taker_fee_tick: 350,
};

type SnapshotClient = ExecuteApprovedLighterCreateOrderDeps["client"];
type SnapshotAccountRow = LighterAccountResponse["accounts"][number];

interface SnapshotScenario {
  readonly market?: LighterMarketDetail;
  /** Overrides on the account row every execute-time account read returns. */
  readonly account?: Partial<SnapshotAccountRow>;
  /** Collection enabled for RHC. */
  readonly feesEnabled?: boolean;
  /** The approval carries the fee terms collection implies; default: when enabled. */
  readonly approvedWithFees?: boolean;
  readonly share?: number;
  readonly auth?: "token" | "none" | "throws";
  readonly refuseAdmission?: boolean;
  /** The last word on the provider reads. */
  readonly client?: (client: SnapshotClient) => Partial<SnapshotClient>;
}

interface SnapshotFixture {
  readonly plan: LighterOrderReadyForSignerPlan;
  readonly build: () => ExecuteApprovedLighterCreateOrderDeps;
}

function snapshotFixture(scenario: SnapshotScenario = {}): SnapshotFixture {
  const market = scenario.market ?? MARKET;
  const spot = market.market_type === "spot";
  const feesEnabled = scenario.feesEnabled === true;
  const integratorFees = (scenario.approvedWithFees ?? feesEnabled)
    ? feePolicy.getLighterIntegratorFees(FEE_POLICY, market.market_type)
    : null;
  const previewRow: SnapshotAccountRow = {
    ...first(ACCOUNT.accounts),
    ...(spot ? { assets: SPOT_ASSETS } : {}),
    ...(feesEnabled ? { approved_integrators: VEX_FEE_APPROVAL } : {}),
  };
  const liveRow: SnapshotAccountRow = { ...previewRow, ...scenario.account };
  const preview = buildLighterOrderPreview({
    sessionId: PLAN.sessionId,
    environment: PLAN.environment,
    accountIndex: PLAN.accountIndex,
    apiKeyIndex: PLAN.apiKeyIndex,
    marketId: market.market_id,
    side: "buy",
    baseAmount: "1",
    price: "3002",
    orderType: "market",
    timeInForce: "immediate-or-cancel",
    reduceOnly: false,
    orderExpiry: ORDER_EXPIRY,
    clientOrderIndexPolicy: "vex_assigned_uint48",
    nowMs: NOW,
    integratorFees,
  }, { market, orderBook: ORDER_BOOK, account: { ...ACCOUNT, accounts: [previewRow] } });
  const plan: LighterOrderReadyForSignerPlan = {
    ...PLAN,
    previewId: preview.previewId,
    matchHash: preview.matchHash,
    marketIndex: market.market_id,
    baseAmountInteger: preview.identity.baseAmountInteger,
    priceInteger: preview.identity.priceInteger,
    ...(integratorFees === null ? {} : { integratorFees }),
  };
  const row: LighterOrderPreviewRow = {
    ...APPROVED_PREVIEW_ROW,
    previewId: plan.previewId,
    matchHash: plan.matchHash,
    marketIndex: plan.marketIndex,
    baseAmountInteger: plan.baseAmountInteger,
    priceInteger: plan.priceInteger,
    previewJson: { ...preview.preview },
    expiresAt: preview.expiresAt,
    ...(integratorFees === null ? {} : { integratorFees }),
  };
  return {
    plan,
    build: () => {
      const base = deps();
      const client: SnapshotClient = {
        ...base.client,
        getMarketDetails: vi.fn(async () => ({
          code: 200,
          order_book_details: spot ? [] : [market],
          spot_order_book_details: spot ? [market] : [],
        })),
        getAccount: vi.fn<LighterClient["getAccount"]>(async (_environment, params) => (
          Number(params.value) === FEE_COLLECTOR_INDEX ? COLLECTOR_ACCOUNT : { ...ACCOUNT, accounts: [liveRow] }
        )),
        getSystemConfig: vi.fn(async () => SYSTEM_CONFIG),
        getAccountLimits: vi.fn(async () => ACCOUNT_LIMITS),
      };
      return deps({
        client: { ...client, ...scenario.client?.(client) },
        previews: { findFreshById: vi.fn(async () => row) },
      });
    },
  };
}

/** The process-wide state a scenario needs; armed afresh before every run. */
function armSnapshotScenario(scenario: SnapshotScenario) {
  vi.mocked(feePolicy.getLighterFeePolicy).mockReturnValue(scenario.feesEnabled === true ? FEE_POLICY : null);
  tradingLimits.current = scenario.share === undefined ? null : { agentCapitalSharePercent: scenario.share };
  ledger.refuseAdmission = scenario.refuseAdmission === true;
  ledger.admitted.length = 0;
  ledger.retired.length = 0;
  const resolver = vi.fn(async () => {
    if (scenario.auth === "throws") throw new Error("vault read failed");
    return scenario.auth === "none" ? null : READ_ONLY_AUTH;
  });
  configureLighterReadOnlyAccountAuthResolver(resolver);
  return resolver;
}

interface SnapshotRun {
  readonly observation: PreflightObservation & { readonly ledger: Record<string, unknown> };
  readonly reads: Record<string, number>;
}

async function observeSnapshotRun(
  scenario: SnapshotScenario,
  revalidationSingleSnapshot: boolean | "constant",
): Promise<SnapshotRun> {
  const fixture = snapshotFixture(scenario);
  const resolver = armSnapshotScenario(scenario);
  const { revalidationSingleSnapshot: _pinned, ...unpinned } = fixture.build();
  const d: ExecuteApprovedLighterCreateOrderDeps = revalidationSingleSnapshot === "constant"
    ? unpinned
    : { ...unpinned, revalidationSingleSnapshot };
  const observation = await observeCreateOrder(d, fixture.plan);
  return {
    observation: {
      ...observation,
      ledger: { admitted: [...ledger.admitted], retired: [...ledger.retired] },
    },
    reads: {
      readOnlyAuth: resolver.mock.calls.length,
      getAccount: vi.mocked(d.client.getAccount).mock.calls.length,
      getMarketDetails: vi.mocked(d.client.getMarketDetails).mock.calls.length,
      getSystemConfig: d.client.getSystemConfig === undefined ? 0 : vi.mocked(d.client.getSystemConfig).mock.calls.length,
      getAccountLimits: d.client.getAccountLimits === undefined ? 0 : vi.mocked(d.client.getAccountLimits).mock.calls.length,
      getOrderBookOrders: vi.mocked(d.client.getOrderBookOrders).mock.calls.length,
    },
  };
}

function failing(message: string) {
  return async (): Promise<never> => {
    throw new Error(message);
  };
}

const SNAPSHOT_CASES: readonly {
  readonly label: string;
  readonly scenario: SnapshotScenario;
  /** The OFF outcome, so each case provably exercises what it names. */
  readonly expected: RegExp;
}[] = [
  // The fee check.
  {
    label: "fees pass and the order is sent",
    scenario: { feesEnabled: true },
    expected: /"status":"sequencer_pending"/,
  },
  {
    label: "the read-only auth is unavailable",
    scenario: { feesEnabled: true, auth: "none" },
    expected: /fee setup is required before this trade\. Unlock the local vault/,
  },
  {
    label: "the read-only auth resolver throws",
    scenario: { feesEnabled: true, auth: "throws" },
    expected: /fee setup is required before this trade\. vault read failed/,
  },
  {
    label: "the system config read fails",
    scenario: { feesEnabled: true, client: () => ({ getSystemConfig: vi.fn(failing("config down")) }) },
    expected: /fee setup is required before this trade\. config down/,
  },
  {
    label: "the system config read cannot reach Lighter",
    scenario: {
      feesEnabled: true,
      client: () => ({
        getSystemConfig: vi.fn(async () => { throw new VexError(ErrorCodes.LIGHTER_TIMEOUT, "config timed out"); }),
      }),
    },
    expected: /couldn't reach Lighter before sending/,
  },
  {
    label: "the collector account read fails",
    scenario: {
      feesEnabled: true,
      client: (client) => ({
        getAccount: vi.fn<LighterClient["getAccount"]>(async (environment, params, options) => {
          if (Number(params.value) === FEE_COLLECTOR_INDEX) throw new Error("collector down");
          return client.getAccount(environment, params, options);
        }),
      }),
    },
    expected: /fee setup is required before this trade\. collector down/,
  },
  {
    label: "the collector belongs to another wallet",
    scenario: {
      feesEnabled: true,
      client: (client) => ({
        getAccount: vi.fn<LighterClient["getAccount"]>(async (environment, params, options) => (
          Number(params.value) === FEE_COLLECTOR_INDEX
            ? { ...COLLECTOR_ACCOUNT, accounts: [{ ...first(COLLECTOR_ACCOUNT.accounts), l1_address: `0x${"3".repeat(40)}` }] }
            : client.getAccount(environment, params, options)
        )),
      }),
    },
    expected: /does not belong to VEX's configured wallet/,
  },
  {
    label: "the provider fee cap fell below Vex's fee",
    scenario: {
      feesEnabled: true,
      client: () => ({ getSystemConfig: vi.fn(async () => ({ ...SYSTEM_CONFIG, max_integrator_perps_taker_fee: 0 })) }),
    },
    expected: /exceeds the current provider limit/,
  },
  {
    label: "the account limits read fails",
    scenario: { feesEnabled: true, client: () => ({ getAccountLimits: vi.fn(failing("limits down")) }) },
    expected: /fee setup is required before this trade\. limits down/,
  },
  {
    label: "the account is not on a Plus or Premium tier",
    scenario: {
      feesEnabled: true,
      client: () => ({ getAccountLimits: vi.fn(async () => ({ ...ACCOUNT_LIMITS, user_tier: "standard" })) }),
    },
    expected: /require a Plus or Premium account/,
  },
  {
    label: "the trading account no longer approves Vex's fee",
    scenario: { feesEnabled: true, account: { approved_integrators: [] } },
    expected: /Approve VEX's Lighter trading fees/,
  },
  {
    label: "the system config and the account limits both fail: the earlier read's refusal wins",
    scenario: {
      feesEnabled: true,
      client: () => ({ getSystemConfig: vi.fn(failing("config down")), getAccountLimits: vi.fn(failing("limits down")) }),
    },
    expected: /config down/,
  },
  {
    label: "the order was approved before collection was enabled",
    scenario: { feesEnabled: true, approvedWithFees: false },
    expected: /fee policy or authorization changed after this preview/,
  },
  {
    label: "the market read fails while the fee reads also fail",
    scenario: {
      feesEnabled: true,
      client: () => ({
        getMarketDetails: vi.fn(delayedRejection(new Error("market down"), 5)),
        getSystemConfig: vi.fn(failing("config down")),
        getAccountLimits: vi.fn(failing("limits down")),
      }),
    },
    expected: /unavailable for post-approval revalidation/,
  },
  {
    label: "the account read cannot reach Lighter while the fee reads are in flight",
    scenario: {
      feesEnabled: true,
      client: (client) => ({
        getAccount: vi.fn<LighterClient["getAccount"]>(async (environment, params, options) => {
          if (Number(params.value) === PLAN.accountIndex) throw new VexError(ErrorCodes.LIGHTER_TIMEOUT, "account timed out");
          return client.getAccount(environment, params, options);
        }),
      }),
    },
    expected: /couldn't reach Lighter before sending/,
  },
  // The spot fee-tier check.
  {
    label: "a spot buy with fees passes its account fee tier",
    scenario: { feesEnabled: true, market: SPOT_MARKET },
    expected: /"status":"sequencer_pending"/,
  },
  {
    label: "a spot buy's account taker fee tier is invalid",
    scenario: {
      feesEnabled: true,
      market: SPOT_MARKET,
      client: () => ({ getAccountLimits: vi.fn(async () => ({ ...ACCOUNT_LIMITS, current_taker_fee_tick: -1 })) }),
    },
    expected: /current Lighter account taker fee is invalid/,
  },
  {
    label: "a spot buy's account limits read fails",
    scenario: { feesEnabled: true, market: SPOT_MARKET, client: () => ({ getAccountLimits: vi.fn(failing("limits down")) }) },
    expected: /limits down/,
  },
  // The margin-fit check inside the re-admission.
  {
    label: "the order no longer fits the account's available margin",
    scenario: { market: PRICED_MARKET, account: { available_balance: "10", collateral: "10" } },
    expected: /would cancel this ETH order with no fill/,
  },
  {
    label: "the margin-fit depth and tier reads fail, which lets the order through as today",
    scenario: {
      market: PRICED_MARKET,
      client: (client) => ({
        getOrderBookOrders: vi.fn<LighterClient["getOrderBookOrders"]>(async (environment, params, options) => {
          if (params.limit !== 250) throw new Error("depth down");
          return client.getOrderBookOrders(environment, params, options);
        }),
        getAccountLimits: vi.fn(failing("limits down")),
      }),
    },
    expected: /"status":"sequencer_pending"/,
  },
  {
    label: "the margin-fit check finds no read-only auth",
    scenario: { market: PRICED_MARKET, auth: "none" },
    expected: /"status":"sequencer_pending"/,
  },
  // The capital-share re-admission.
  {
    label: "the account reports no owning wallet",
    scenario: { account: { l1_address: "not-a-wallet" } },
    expected: /reported no owning L1 address/,
  },
  {
    // The ledger (recorded above) receives the very same budget and requirement.
    label: "the capital share hands the ledger the live budget and requirement",
    scenario: { market: PRICED_MARKET, share: 1 },
    expected: /"status":"sequencer_pending"/,
  },
  {
    label: "the capital share cannot read the account's exchange fee tier",
    scenario: { market: PRICED_MARKET, share: 50, client: () => ({ getAccountLimits: vi.fn(failing("limits down")) }) },
    expected: /could not read this Lighter account's exchange fee tier \(limits down\)/,
  },
  {
    label: "the capital share has no read-only auth",
    scenario: { market: PRICED_MARKET, share: 50, auth: "none" },
    expected: /could not read this Lighter account's exchange fee tier, so the charge/,
  },
  {
    label: "the capital share cannot read the account's resting orders",
    scenario: {
      market: PRICED_MARKET,
      share: 50,
      account: { total_order_count: 1 },
      client: () => ({
        getAccountActiveOrders: vi.fn<LighterClient["getAccountActiveOrders"]>(async (_environment, params) => {
          if (params.marketId === undefined) throw new Error("orders down");
          return { code: 200, orders: [] };
        }),
      }),
    },
    expected: /could not read this Lighter account's resting orders \(orders down\)/,
  },
  {
    label: "the ledger refuses the re-admission",
    scenario: { market: PRICED_MARKET, share: 50, refuseAdmission: true },
    expected: /still available under the agent's 50% capital share/,
  },
  {
    label: "the market has no margin fraction to price the capital share",
    scenario: { share: 50 },
    expected: /default_initial_margin_fraction/,
  },
  {
    label: "a fee-bearing order is re-admitted under the capital share",
    scenario: { feesEnabled: true, market: PRICED_MARKET, share: 50, account: { total_order_count: 1 } },
    expected: /"status":"sequencer_pending"/,
  },
];

describe("LIGHTER_REVALIDATION_SINGLE_SNAPSHOT", () => {
  afterEach(() => {
    configureLighterReadOnlyAccountAuthResolver(null);
    tradingLimits.current = null;
    ledger.refuseAdmission = false;
    ledger.admitted.length = 0;
    ledger.retired.length = 0;
  });

  it("ships ON", () => {
    expect(LIGHTER_REVALIDATION_SINGLE_SNAPSHOT).toBe(true);
  });

  it.each(PREFLIGHT_CASES)("refuses and records exactly what OFF does when $label", async ({ build, expected }) => {
    const off = await observeCreateOrder({ ...build(), revalidationSingleSnapshot: false });
    const { revalidationSingleSnapshot: _pinned, ...unpinned } = build();
    const absent = await observeCreateOrder(unpinned);
    const on = await observeCreateOrder({ ...build(), revalidationSingleSnapshot: true });

    expect(JSON.stringify(off.outcome)).toMatch(expected);
    expect(absent).toEqual(off);
    expect(on).toEqual(off);
  });

  it.each(PREFLIGHT_CASES)("composes with the other K-3 switches and still refuses as OFF when $label", async ({ build }) => {
    const off = await observeCreateOrder({ ...build(), revalidationSingleSnapshot: false });
    const on = await observeCreateOrder({
      ...build(),
      revalidationSingleSnapshot: true,
      parallelPreflight: true,
      readAuthCache: new LighterReadAuthCache(),
    });
    expect(on).toEqual(off);
  });

  it.each(SNAPSHOT_CASES)("refuses, writes and admits exactly what OFF does when $label", async ({ scenario, expected }) => {
    const off = await observeSnapshotRun(scenario, false);
    const absent = await observeSnapshotRun(scenario, "constant");
    const on = await observeSnapshotRun(scenario, true);

    expect(JSON.stringify(off.observation.outcome)).toMatch(expected);
    expect(absent.observation).toEqual(off.observation);
    expect(on.observation).toEqual(off.observation);
  });

  it.each(SNAPSHOT_CASES)("still matches OFF beside the parallel preflight when $label", async ({ scenario }) => {
    const off = await observeSnapshotRun(scenario, false);
    const fixture = snapshotFixture(scenario);
    armSnapshotScenario(scenario);
    const on = await observeCreateOrder({ ...fixture.build(), revalidationSingleSnapshot: true, parallelPreflight: true }, fixture.plan);
    expect(on).toEqual({ outcome: off.observation.outcome, effects: off.observation.effects });
  });

  it("reads each value once: the call map of a fee-bearing order under a capital share", async () => {
    const scenario: SnapshotScenario = { feesEnabled: true, market: PRICED_MARKET, share: 50, account: { total_order_count: 1 } };
    const off = await observeSnapshotRun(scenario, false);
    const on = await observeSnapshotRun(scenario, true);

    expect(off.observation.outcome).toMatchObject({ resolved: { status: "sequencer_pending" } });
    // Today: the trader account four times (revalidation, fee check, collector
    // aside, re-admission), the market three times, the auth and the limits
    // once per check that needs them.
    expect(off.reads).toEqual({
      readOnlyAuth: 3,
      getAccount: 4,
      getMarketDetails: 3,
      getSystemConfig: 1,
      getAccountLimits: 3,
      getOrderBookOrders: 2,
    });
    expect(on.reads).toEqual({
      readOnlyAuth: 1,
      getAccount: 2,
      getMarketDetails: 1,
      getSystemConfig: 1,
      getAccountLimits: 1,
      getOrderBookOrders: 2,
    });
  });

  it("starts the fee reads beside the first batch but resolves no auth until that batch succeeded", async () => {
    const scenario: SnapshotScenario = { feesEnabled: true };
    const fixture = snapshotFixture(scenario);
    const resolver = armSnapshotScenario(scenario);
    const marketGate = createGate();
    const base = fixture.build();
    const getMarketDetails = vi.fn(async () => {
      await marketGate.promise;
      return { code: 200, order_book_details: [MARKET], spot_order_book_details: [] };
    });
    const d = deps({ ...base, client: { ...base.client, getMarketDetails }, revalidationSingleSnapshot: true });

    const execution = executeApprovedLighterCreateOrder({
      plan: fixture.plan,
      unsignedOrder: buildLighterUnsignedCreateOrderRequest(fixture.plan),
      deps: d,
    });
    await vi.waitFor(() => {
      expect(getMarketDetails).toHaveBeenCalledTimes(1);
      expect(d.client.getSystemConfig).toHaveBeenCalledTimes(1);
      expect(d.client.getAccount).toHaveBeenCalledWith(PLAN.environment, { by: "index", value: FEE_COLLECTOR_INDEX }, { fresh: true });
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(d.client.getAccountLimits).not.toHaveBeenCalled();
    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();

    marketGate.release();
    const result = await execution;
    expect(result.status).toBe("sequencer_pending");
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("runs the re-admission's margin-fit reads beside the fee reads instead of after them", async () => {
    for (const revalidationSingleSnapshot of [false, true]) {
      const scenario: SnapshotScenario = { feesEnabled: true, market: PRICED_MARKET };
      const fixture = snapshotFixture(scenario);
      armSnapshotScenario(scenario);
      const configGate = createGate();
      const base = fixture.build();
      const getSystemConfig = vi.fn(async () => {
        await configGate.promise;
        return SYSTEM_CONFIG;
      });
      const d = deps({ ...base, client: { ...base.client, getSystemConfig }, revalidationSingleSnapshot });
      const depthReads = () => vi.mocked(d.client.getOrderBookOrders).mock.calls.filter((call) => call[1].limit !== 250).length;

      const execution = executeApprovedLighterCreateOrder({
        plan: fixture.plan,
        unsignedOrder: buildLighterUnsignedCreateOrderRequest(fixture.plan),
        deps: d,
      });
      await vi.waitFor(() => expect(getSystemConfig).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(d.client.getAccountLimits).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(depthReads()).toBe(revalidationSingleSnapshot ? 1 : 0);
      expect(d.intents.markPreSubmitRevalidated).not.toHaveBeenCalled();

      configGate.release();
      expect((await execution).status).toBe("sequencer_pending");
      expect(depthReads()).toBe(1);
    }
  });

  it("logs one numbers-only timing line per accepted order, and none for a refusal", async () => {
    const info = vi.spyOn(logger, "info");
    const timingLines = (): (readonly unknown[])[] => {
      const calls: readonly (readonly unknown[])[] = info.mock.calls;
      return calls.filter((call) => call[0] === "[lighter-order-timing]");
    };
    await observeSnapshotRun({ feesEnabled: true }, true);
    const lines = timingLines();
    expect(lines).toHaveLength(1);
    const meta: unknown = first(lines)[1];
    expect(typeof meta === "object" && meta !== null).toBe(true);
    const fields = Object.entries(typeof meta === "object" && meta !== null ? meta : {});
    expect(Object.fromEntries(fields.filter(([key]) => key === "intentId"))).toEqual({ intentId: PLAN.intentId });
    expect(fields.map(([key]) => key).sort()).toEqual([
      "authMs",
      "credentialMs",
      "decisionToApiAcceptedMs",
      "intentId",
      "keyLoadMs",
      "nonceReserveMs",
      "revalidationMs",
      "sendMs",
      "signMs",
    ]);
    for (const [key, value] of fields) {
      if (key !== "intentId") expect(typeof value).toBe("number");
    }

    info.mockClear();
    await observeSnapshotRun({ feesEnabled: true, auth: "none" }, true);
    expect(timingLines()).toHaveLength(0);
  });
});

import {
  LIGHTER_SIGNING_OWNERSHIP_NOT_MASTER,
  LIGHTER_SIGNING_OWNERSHIP_NOT_OWNED,
  LIGHTER_SIGNING_OWNERSHIP_RECHECK,
  LIGHTER_SIGNING_OWNERSHIP_WALLET_UNAVAILABLE,
  type LighterSigningOwnershipWallet,
} from "@vex-agent/tools/protocols/lighter/signing-ownership.js";

// ---------------------------------------------------------------------------
// LIGHTER_SIGNING_OWNERSHIP_RECHECK: the session wallet must still own the
// approved account, judged from the revalidation's own fresh account read.
// ---------------------------------------------------------------------------

const OWNER_WALLET: LighterSigningOwnershipWallet = { kind: "wallet", address: "0x1111111111111111111111111111111111111111" };
const OTHER_WALLET: LighterSigningOwnershipWallet = { kind: "wallet", address: `0x${"4".repeat(40)}` };

/** deps() whose every account read reports the given row changes. */
function depsWithAccount(row: Partial<LighterAccountResponse["accounts"][number]>, overrides: Partial<ExecuteApprovedLighterCreateOrderDeps> = {}) {
  const base = deps(overrides);
  return {
    ...base,
    client: {
      ...base.client,
      getAccount: vi.fn<LighterClient["getAccount"]>(async () => ({ ...ACCOUNT, accounts: [{ ...first(ACCOUNT.accounts), ...row }] })),
    },
  };
}

function nothingLoadedOrSent(observation: PreflightObservation): void {
  expect(observation.effects).toMatchObject({
    markPreSubmitRevalidated: [],
    readTradingApiPrivateKey: [],
    createAccountAuth: 0,
    reserveNonce: [],
    signCreateOrder: 0,
    markSigned: [],
    sendTx: [],
  });
}

describe("LIGHTER_SIGNING_OWNERSHIP_RECHECK", () => {
  afterEach(() => {
    configureLighterReadOnlyAccountAuthResolver(null);
    tradingLimits.current = null;
    ledger.refuseAdmission = false;
    ledger.admitted.length = 0;
    ledger.retired.length = 0;
  });

  it("ships ON", () => {
    expect(LIGHTER_SIGNING_OWNERSHIP_RECHECK).toBe(true);
  });

  it.each(PREFLIGHT_CASES)("matches OFF when the session wallet still owns the account and $label", async ({ build, expected }) => {
    const off = await observeCreateOrder({ ...build(), signingOwnershipRecheck: false }, PLAN, OWNER_WALLET);
    const { signingOwnershipRecheck: _pinned, ...unpinned } = build();
    const absent = await observeCreateOrder(unpinned, PLAN, OWNER_WALLET);
    const on = await observeCreateOrder({ ...build(), signingOwnershipRecheck: true }, PLAN, OWNER_WALLET);

    expect(JSON.stringify(off.outcome)).toMatch(expected);
    expect(absent).toEqual(off);
    expect(on).toEqual(off);
  });

  it.each(PREFLIGHT_CASES)("matches OFF beside every other order-path speed switch when $label", async ({ build }) => {
    const speed = { parallelPreflight: true, revalidationSingleSnapshot: true } as const;
    const off = await observeCreateOrder({ ...build(), ...speed, signingOwnershipRecheck: false }, PLAN, OWNER_WALLET);
    const on = await observeCreateOrder({ ...build(), ...speed, signingOwnershipRecheck: true }, PLAN, OWNER_WALLET);
    expect(on).toEqual(off);
  });

  it.each(SNAPSHOT_CASES)("refuses, writes and admits exactly what OFF does when $label", async ({ scenario, expected }) => {
    const runs: (PreflightObservation & { readonly ledger: unknown })[] = [];
    for (const signingOwnershipRecheck of [false, true]) {
      const fixture = snapshotFixture(scenario);
      armSnapshotScenario(scenario);
      const observation = await observeCreateOrder(
        { ...fixture.build(), revalidationSingleSnapshot: true, signingOwnershipRecheck },
        fixture.plan,
        OWNER_WALLET,
      );
      runs.push({ ...observation, ledger: { admitted: [...ledger.admitted], retired: [...ledger.retired] } });
    }
    expect(JSON.stringify(requireValue(runs[0]).outcome)).toMatch(expected);
    expect(runs[1]).toEqual(runs[0]);
  });

  it.each([
    {
      label: "the session's selected wallet changed between preview and approval",
      wallet: OTHER_WALLET,
      account: {},
      reason: LIGHTER_SIGNING_OWNERSHIP_NOT_OWNED,
    },
    {
      label: "the account now reports another owner (account moved)",
      wallet: OWNER_WALLET,
      account: { l1_address: `0x${"5".repeat(40)}` },
      reason: LIGHTER_SIGNING_OWNERSHIP_NOT_OWNED,
    },
    {
      label: "the account is not the wallet's master account",
      wallet: OWNER_WALLET,
      account: { account_type: 1 },
      reason: LIGHTER_SIGNING_OWNERSHIP_NOT_MASTER,
    },
    {
      label: "the session wallet is no longer available at execute",
      wallet: { kind: "unavailable" } as const,
      account: {},
      reason: LIGHTER_SIGNING_OWNERSHIP_WALLET_UNAVAILABLE,
    },
    {
      label: "no session wallet reached the executor at all",
      wallet: undefined,
      account: {},
      reason: LIGHTER_SIGNING_OWNERSHIP_WALLET_UNAVAILABLE,
    },
  ])("refuses before any key, auth or nonce when $label, where OFF would send", async ({ wallet, account, reason }) => {
    const off = await observeCreateOrder(depsWithAccount(account, { signingOwnershipRecheck: false }), PLAN, wallet);
    expect(off.outcome).toMatchObject({ resolved: { status: "sequencer_pending" } });

    const on = await observeCreateOrder(depsWithAccount(account, { signingOwnershipRecheck: true }), PLAN, wallet);
    expect(on.outcome).toEqual({
      rejected: {
        name: "VexError",
        code: ErrorCodes.LIGHTER_INVALID_REQUEST,
        message: reason,
        hint: "Restart from a fresh Lighter preview and approval before attempting submission.",
        // Never marked retryable, like every other pre-submit refusal.
        retryable: undefined,
      },
    });
    nothingLoadedOrSent(on);
  });

  it("refuses the same way beside the parallel preflight, ahead of a credential refusal", async () => {
    const base = depsWithAccount({ l1_address: `0x${"5".repeat(40)}` }, { parallelPreflight: true, signingOwnershipRecheck: true });
    const unregistered = { ...base, client: { ...base.client, getApiKeys: vi.fn(async () => ({ code: 200, api_keys: [] })) } };
    const on = await observeCreateOrder(unregistered, PLAN, OWNER_WALLET);
    expect(on.outcome).toMatchObject({ rejected: { message: LIGHTER_SIGNING_OWNERSHIP_NOT_OWNED } });
    nothingLoadedOrSent(on);
  });

  it("keeps an existing revalidation refusal first when ownership also fails", async () => {
    const moved = (recheck: boolean) => {
      const base = depsWithAccount({ l1_address: `0x${"5".repeat(40)}` }, { signingOwnershipRecheck: recheck });
      return {
        ...base,
        client: {
          ...base.client,
          getOrderBookOrders: vi.fn(async () => ({ ...ORDER_BOOK, asks: [{ ...first(ORDER_BOOK.asks), price: "3002.01" }] })),
        },
      };
    };
    const off = await observeCreateOrder(moved(false), PLAN, OWNER_WALLET);
    const on = await observeCreateOrder(moved(true), PLAN, OWNER_WALLET);
    expect(JSON.stringify(off.outcome)).toMatch(/moved beyond the approved market-order worst price/);
    expect(on).toEqual(off);
  });

  it("lets the existing capital-share refusal speak first for an account with no owner at all", async () => {
    tradingLimits.current = null;
    const off = await observeCreateOrder(depsWithAccount({ l1_address: undefined }, { signingOwnershipRecheck: false }), PLAN, OWNER_WALLET);
    const on = await observeCreateOrder(depsWithAccount({ l1_address: undefined }, { signingOwnershipRecheck: true }), PLAN, OWNER_WALLET);
    expect(JSON.stringify(off.outcome)).toMatch(/reported no owning L1 address/);
    expect(on).toEqual(off);
  });

  it("matches the owner without regard to address case, and accepts a reported master account", async () => {
    const info = vi.spyOn(logger, "info");
    const checksummed = depsWithAccount({ l1_address: "0x1111111111111111111111111111111111111111".toUpperCase().replace("0X", "0x"), account_type: 0 }, { signingOwnershipRecheck: true });
    const on = await observeCreateOrder(checksummed, PLAN, OWNER_WALLET);
    expect(on.outcome).toMatchObject({ resolved: { status: "sequencer_pending" } });
    const calls: readonly (readonly unknown[])[] = info.mock.calls;
    const lines = calls.filter((call) => call[0] === "lighter.order.signing_ownership_recheck");
    expect(lines.map((call) => call[1])).toEqual([{ outcome: "matched", accountTypeReported: 1 }]);
    info.mockRestore();
  });

  it("lets a trusted default context with no EVM wallet through, as its preview did", async () => {
    const trusted: LighterSigningOwnershipWallet = { kind: "trusted_default_without_wallet" };
    const off = await observeCreateOrder(deps({ signingOwnershipRecheck: false }), PLAN, trusted);
    const on = await observeCreateOrder(deps({ signingOwnershipRecheck: true }), PLAN, trusted);
    expect(on.outcome).toMatchObject({ resolved: { status: "sequencer_pending" } });
    expect(on).toEqual(off);
  });
});
