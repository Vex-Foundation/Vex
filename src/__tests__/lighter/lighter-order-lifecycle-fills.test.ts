/**
 * THE DEDICATED CLOSE TOOL REACHES THE FILL LEDGER.
 *
 * `lighter__position.close` confirms its fill from an INACTIVE ORDER row and
 * never reads a trade, which is exactly the order-shaped confirmation that
 * left the create executor's fills unrecorded. Until the observation boundary
 * was wired here, every close Vex performed was money moved that AgentScan
 * would never hear about.
 *
 * Both tests drive the real executor over typed doubles, and the ledger row
 * they assert on carries the LIFECYCLE intent's id: `execution_intent_id`
 * stores whichever Vex intent owns the fill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import * as feePolicy from "@tools/lighter/fee-policy.js";
import { deriveVexAssignedClientOrderIndex } from "@tools/lighter/signer-order.js";
import type {
  LighterAccountOrder,
  LighterAccountPosition,
  LighterAssetDetail,
  LighterTrade,
} from "@tools/lighter/types.js";
import type { LighterNonceStateRow } from "@vex-agent/db/repos/lighter-nonce-state.js";
import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import type { LighterFillRecord } from "@vex-agent/tools/protocols/lighter/agentscan-activity.js";
import {
  resetLighterMarketAssetsCache,
  type LighterFillObservationDeps,
} from "@vex-agent/tools/protocols/lighter/fill-observation.js";
import {
  executeApprovedLighterClosePosition,
  type LighterOrderLifecycleExecutionDeps,
} from "@vex-agent/tools/protocols/lighter/order-lifecycle.js";
import { lifecycleIntent } from "../helpers/lighter-intents.js";
import { testPoolClient } from "../helpers/pool-client.js";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const ACCOUNT_INDEX = 42;
const MATCH_HASH = "d".repeat(64);
const CLIENT_ORDER_INDEX = deriveVexAssignedClientOrderIndex(MATCH_HASH);
const PUBLIC_KEY = "b".repeat(80);

type Client = LighterOrderLifecycleExecutionDeps["client"];
type Intents = LighterOrderLifecycleExecutionDeps["intents"];
type NonceState = LighterOrderLifecycleExecutionDeps["nonceState"];
type FillClient = LighterFillObservationDeps["client"];

// Lifecycle fixtures represent orders approved while collection is disabled;
// enabled-policy refusal has its own suite.
beforeEach(() => vi.spyOn(feePolicy, "getLighterFeePolicy").mockReturnValue(null));
afterEach(() => vi.restoreAllMocks());

const LONG_POSITION: LighterAccountPosition = {
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

const CLOSE_ORDER: LighterAccountOrder = {
  order_index: 2,
  client_order_index: Number(CLIENT_ORDER_INDEX),
  order_id: "281474976710658",
  client_order_id: CLIENT_ORDER_INDEX,
  market_index: 0,
  owner_account_index: ACCOUNT_INDEX,
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

/** The trade that closed the position, as Lighter reports it on the account's own page. */
const CLOSE_TRADE: LighterTrade = {
  trade_id: 700,
  trade_id_str: "700",
  tx_hash: "hash-14",
  type: "trade",
  market_id: 0,
  size: "1.0000",
  price: "49.75",
  usd_amount: "49.750000",
  ask_id: 281474976710658,
  ask_id_str: "281474976710658",
  bid_id: 9,
  bid_id_str: "9",
  ask_account_id: ACCOUNT_INDEX,
  bid_account_id: 99,
  is_maker_ask: false,
  block_height: 4242,
  timestamp: NOW,
  transaction_time: NOW * 1000,
  ask_client_id_str: CLIENT_ORDER_INDEX,
  taker_fee: 350,
};

function closeIntent(): LighterOrderLifecycleIntentRow {
  return lifecycleIntent({
    actionType: "close_position",
    matchHash: MATCH_HASH,
    marketIndex: 0,
    providerOrderId: null,
    requestedBaseAmountInteger: "10000",
    requestedPriceInteger: "4950",
    requestedSide: "sell",
    reduceOnly: true,
    approvalStatus: "approved",
    executionState: "approved",
    decisionReason: "approved",
    decidedAt: "2029-12-31T23:59:00.000Z",
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
}

/** A recording ledger, plus the SUM the completeness gate reads back from it. */
function ledger() {
  const rows = new Map<string, LighterFillRecord>();
  const recordFill = vi.fn<LighterFillObservationDeps["recordFill"]>(async (record: LighterFillRecord) => {
    if (rows.has(record.canonicalIdentity)) return { kind: "duplicate" as const, fillId: 1 };
    rows.set(record.canonicalIdentity, record);
    return { kind: "recorded" as const, fillId: rows.size };
  });
  return { rows, recordFill };
}

const RHC_COLLATERAL: LighterAssetDetail = {
  asset_id: 3,
  symbol: "USDG",
  l1_decimals: 6,
  decimals: 6,
  min_transfer_amount: "0",
  l1_address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
};

function fillDeps(
  recordFill: LighterFillObservationDeps["recordFill"],
  recordedFillBaseSize: LighterFillObservationDeps["recordedFillBaseSize"] =
    vi.fn<LighterFillObservationDeps["recordedFillBaseSize"]>(async () => "0"),
): LighterFillObservationDeps {
  resetLighterMarketAssetsCache();
  return {
    recordedFillBaseSize,
    recordFill,
    findFeeAuthorization: vi.fn<LighterFillObservationDeps["findFeeAuthorization"]>(async () => null),
    client: {
      getMarketDetails: vi.fn<FillClient["getMarketDetails"]>(async () => ({
        code: 200,
        order_book_details: [{
          symbol: "ETH", market_id: 0, market_type: "perp", base_asset_id: 0, quote_asset_id: 0,
          status: "active", taker_fee: "0", maker_fee: "0", liquidation_fee: "0",
          min_base_amount: "0", min_quote_amount: "0", supported_size_decimals: 4,
          supported_price_decimals: 2, supported_quote_decimals: 6, order_quote_limit: "0",
          is_maker_fee_enabled: true, is_taker_fee_enabled: true,
        }],
        spot_order_book_details: [],
      })),
      getAssetDetails: vi.fn<FillClient["getAssetDetails"]>(async () => ({
        code: 200,
        asset_details: [RHC_COLLATERAL],
      })),
    },
  };
}

/** One nonce-state row, in the shape the repository returns. */
function nonceRow(
  status: LighterNonceStateRow["status"],
  reservationId: string | null = null,
): LighterNonceStateRow {
  return {
    environment: "rhc",
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: 7,
    providerNonce: "9",
    publicKey: PUBLIC_KEY,
    providerTransactionTime: String(NOW),
    status,
    reservedNonce: "9",
    reservationId,
    source: "provider",
    observedAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
}

function closeDeps(input: {
  readonly fills?: LighterFillObservationDeps;
  readonly getAccountTrades: Client["getAccountTrades"];
}): LighterOrderLifecycleExecutionDeps {
  const staged = closeIntent();
  let accountReads = 0;
  return {
    secretReader: { readTradingApiPrivateKey: vi.fn(async () => "1".repeat(80)) },
    authSigner: {
      source: "official_lighter_signer",
      createAccountAuth: vi.fn<LighterOrderLifecycleExecutionDeps["authSigner"]["createAccountAuth"]>(
        async (signingInput) => ({
          kind: "lighter_account_auth_signer_result",
          environment: signingInput.environment,
          accountIndex: signingInput.accountIndex,
          apiKeyIndex: signingInput.apiKeyIndex,
          deadlineUnixSeconds: signingInput.deadlineUnixSeconds,
          authToken: `${signingInput.deadlineUnixSeconds}:42:7:${"a".repeat(128)}`,
          publicKey: PUBLIC_KEY,
        }),
      ),
      signCreateOrder: vi.fn<LighterOrderLifecycleExecutionDeps["authSigner"]["signCreateOrder"]>(
        async (signingInput) => ({
          kind: "lighter_create_order_signer_result",
          environment: "rhc",
          accountIndex: ACCOUNT_INDEX,
          apiKeyIndex: 7,
          nonce: "9",
          clientOrderIndex: signingInput.order.clientOrderIndex,
          matchHash: signingInput.order.matchHash,
          txType: 14,
          txInfo: "signed-close",
          txHash: "hash-14",
        }),
      ),
    },
    lifecycleSigner: {
      source: "official_lighter_signer",
      signCancelOrder: vi.fn(),
      signModifyOrder: vi.fn(),
      signCancelAllOrders: vi.fn(),
    },
    client: {
      // The pre-submit read sees the approved long position; every read after
      // the terminal order sees the account flat, which is what turns the
      // close into a CONFIRMED one.
      getAccount: vi.fn<Client["getAccount"]>(async () => {
        accountReads += 1;
        return {
          code: 200,
          total: 1,
          accounts: [{
            index: ACCOUNT_INDEX,
            positions: [accountReads === 1 ? LONG_POSITION : { ...LONG_POSITION, position: "0.0000", sign: 0 }],
          }],
        };
      }),
      getAccountActiveOrders: vi.fn<Client["getAccountActiveOrders"]>(async () => ({ code: 200, orders: [] })),
      getAccountInactiveOrders: vi.fn<Client["getAccountInactiveOrders"]>(
        async () => ({ code: 200, orders: [CLOSE_ORDER] }),
      ),
      getAccountTrades: input.getAccountTrades,
      getMarkets: vi.fn<Client["getMarkets"]>(async () => ({
        code: 200,
        order_books: [{
          symbol: "ETH", market_id: 0, market_type: "perp", base_asset_id: 0, quote_asset_id: 0,
          status: "active", taker_fee: "0", maker_fee: "0", liquidation_fee: "0",
          min_base_amount: "0", min_quote_amount: "0", supported_size_decimals: 4,
          supported_price_decimals: 2, supported_quote_decimals: 6, order_quote_limit: "0",
          is_maker_fee_enabled: true, is_taker_fee_enabled: true,
        }],
      })),
      getOrderBookOrders: vi.fn<Client["getOrderBookOrders"]>(async () => ({
        code: 200, total_asks: 0, asks: [], total_bids: 1,
        bids: [{
          order_index: 3, order_id: "3", owner_account_index: 9,
          initial_base_amount: "5", remaining_base_amount: "5", price: "49.50",
          order_expiry: NOW + 3_600_000, transaction_time: NOW,
        }],
      })),
      getApiKeys: vi.fn<Client["getApiKeys"]>(async () => ({
        code: 200,
        api_keys: [{
          account_index: ACCOUNT_INDEX, api_key_index: 7, nonce: 9,
          public_key: PUBLIC_KEY, transaction_time: NOW,
        }],
      })),
      getNextNonce: vi.fn<Client["getNextNonce"]>(async () => ({ code: 200, nonce: 9 })),
      sendTx: vi.fn<Client["sendTx"]>(async () => ({
        code: 200, tx_hash: "hash-14", predicted_execution_time_ms: 100, volume_quota_remaining: 99,
      })),
    },
    intents: {
      markSendAttemptStarted: vi.fn<Intents["markSendAttemptStarted"]>(async () => true),
      markExpiredUnsubmitted: vi.fn<Intents["markExpiredUnsubmitted"]>(async () => true),
      markUnsubmittedRefused: vi.fn<Intents["markUnsubmittedRefused"]>(async () => true),
      markPreSubmitRevalidated: vi.fn<Intents["markPreSubmitRevalidated"]>(async () => staged),
      attachNonceReservationWith: vi.fn<Intents["attachNonceReservationWith"]>(async () => staged),
      markSigned: vi.fn<Intents["markSigned"]>(async () => staged),
      markSubmissionStaged: vi.fn<Intents["markSubmissionStaged"]>(async () => staged),
      markApiAccepted: vi.fn<Intents["markApiAccepted"]>(async () => staged),
      markProviderOutcome: vi.fn<Intents["markProviderOutcome"]>(async () => staged),
      markAmbiguous: vi.fn<Intents["markAmbiguous"]>(async () => staged),
      markClosePositionChangedBeforeSubmissionWith:
        vi.fn<Intents["markClosePositionChangedBeforeSubmissionWith"]>(async () => staged),
    },
    nonceState: {
      releaseUnsubmittedReservation: vi.fn<NonceState["releaseUnsubmittedReservation"]>(async () => null),
      recordExecutionObserved: vi.fn<NonceState["recordExecutionObserved"]>(async () => nonceRow("observed")),
      reserveObservedWith: vi.fn<NonceState["reserveObservedWith"]>(
        async () => nonceRow("reserved", `lighter-lifecycle:${staged.intentId}`),
      ),
    },
    // Declared as the generic `withTransaction`, so the double is a plain
    // generic function rather than a mock whose call signature is narrower.
    transaction: async <T>(run: (client: PoolClient) => Promise<T>): Promise<T> => run(testPoolClient({})),
    acquireSessionControlLock:
      vi.fn<LighterOrderLifecycleExecutionDeps["acquireSessionControlLock"]>(async () => undefined),
    now: () => NOW,
    wait: vi.fn<LighterOrderLifecycleExecutionDeps["wait"]>(async () => undefined),
    ...(input.fills === undefined ? {} : { fills: input.fills }),
  };
}

describe("close position: the confirmed close reaches the fill ledger", () => {
  it("reads the account trades once and records the close as a fill of the LIFECYCLE intent", async () => {
    const { rows, recordFill } = ledger();
    const getAccountTrades = vi.fn<Client["getAccountTrades"]>(
      async () => ({ code: 200, trades: [CLOSE_TRADE] }),
    );
    const intent = closeIntent();

    const result = await executeApprovedLighterClosePosition(
      intent,
      closeDeps({ fills: fillDeps(recordFill), getAccountTrades }),
    );

    expect(result.status).toBe("closed");
    expect(getAccountTrades).toHaveBeenCalledTimes(1);
    const recorded = rows.get("lighter:rhc:42:0:700");
    expect(recorded).toBeDefined();
    expect(recorded?.executionIntentId).toBe(intent.intentId);
    expect(recorded?.clientOrderId).toBe(CLIENT_ORDER_INDEX);
    expect(recorded?.baseSize).toBe("1.0000");
    expect(recorded?.side).toBe("sell");
  });

  it("keeps the confirmed close when the ledger write is refused", async () => {
    const recordFill = vi.fn<LighterFillObservationDeps["recordFill"]>(async () => {
      throw new Error("ledger unavailable");
    });
    const getAccountTrades = vi.fn<Client["getAccountTrades"]>(
      async () => ({ code: 200, trades: [CLOSE_TRADE] }),
    );

    const result = await executeApprovedLighterClosePosition(
      closeIntent(),
      closeDeps({ fills: fillDeps(recordFill), getAccountTrades }),
    );

    expect(result.status).toBe("closed");
    expect(recordFill).toHaveBeenCalledTimes(1);
  });
});
