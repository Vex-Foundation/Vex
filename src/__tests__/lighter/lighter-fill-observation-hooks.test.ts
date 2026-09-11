/**
 * THE FILL OBSERVATION BOUNDARY, driven through the real owners.
 *
 * The four sentences the round-2 amendment requires, each one an entry-path
 * test rather than a unit test of the writer:
 *
 *   1. two fills in one frame produce two ledger rows - the stream advances
 *      the intent ONCE off a single trade and deduplicates the rest, so a
 *      post-transition hook would record one of the two;
 *   2. replay after an interrupted ledger write produces no duplicate and no
 *      lost row - the second observation records what the first did not and
 *      recognises what it did;
 *   3. order evidence accompanied by trades records the trades - order repair
 *      returns an ACTIVE-order classification before it ever reaches the trade
 *      branch, and the trades it already read must not be lost with it;
 *   4. a failed ledger write NEVER misrepresents a confirmed provider outcome
 *      - the transition commits, the ledger write is owed to the next
 *      observation, and nothing reports the order as unresolved.
 */
import { describe, it, expect, vi, type Mock } from "vitest";

import type {
  LighterAccountAllOrdersStreamMessage,
  LighterAccountAllTradesStreamMessage,
  LighterAccountOrder,
  LighterAssetDetail,
  LighterMarketDetail,
  LighterTrade,
} from "@tools/lighter/types.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type { LighterFillRecord } from "@vex-agent/tools/protocols/lighter/agentscan-activity.js";
import {
  reconcileLighterAccountStreamMessage,
  type LighterAccountStreamReconciliationDeps,
} from "@vex-agent/tools/protocols/lighter/account-stream-reconciliation.js";
import {
  repairLighterOrderIntent,
  type LighterOrderRepairDeps,
} from "@vex-agent/tools/protocols/lighter/order-repair.js";
import {
  LIGHTER_FILL_FOLLOW_UP_TRADES_LIMIT,
  observeLighterFills,
  observeLighterFillsFromAccountTrades,
  resetLighterMarketAssetsCache,
  resolveLighterMarketAssets,
  type LighterFillObservationDeps,
} from "@vex-agent/tools/protocols/lighter/fill-observation.js";

const ACCOUNT_INDEX = 42;
const CLIENT_ORDER_INDEX = "700";

type FillClient = LighterFillObservationDeps["client"];
type StreamClient = LighterAccountStreamReconciliationDeps["client"];
type OrderIntents = LighterAccountStreamReconciliationDeps["orderIntents"];
type MarkStreamOutcome = OrderIntents["markStreamOutcome"];
type StreamLifecycleIntents = LighterAccountStreamReconciliationDeps["lifecycleIntents"];
type StreamNonceState = LighterAccountStreamReconciliationDeps["nonceState"];
type RepairClient = LighterOrderRepairDeps["client"];
type RepairIntents = LighterOrderRepairDeps["intents"];
type RepairNonceState = LighterOrderRepairDeps["nonceState"];

function trade(overrides: Partial<LighterTrade> = {}): LighterTrade {
  return {
    trade_id: 1,
    trade_id_str: "1",
    tx_hash: "0xtrade",
    type: "trade",
    market_id: 0,
    size: "1.5",
    price: "2000.0",
    usd_amount: "3000",
    ask_id: 9,
    ask_id_str: "9",
    bid_id: 8,
    bid_id_str: "8",
    ask_account_id: 99,
    bid_account_id: ACCOUNT_INDEX,
    is_maker_ask: true,
    block_height: 1000,
    timestamp: 1_760_000_000_000,
    bid_client_id_str: CLIENT_ORDER_INDEX,
    ...overrides,
  };
}

function tradesFrame(trades: readonly LighterTrade[]): LighterAccountAllTradesStreamMessage {
  return {
    type: "update/account_all_trades",
    channel: `account_all_trades:${ACCOUNT_INDEX}`,
    trades,
  };
}

function executionIntent(
  overrides: Partial<LighterOrderExecutionIntentRow> = {},
): LighterOrderExecutionIntentRow {
  return {
    intentId: `lighter-order-${"a".repeat(32)}`,
    sessionId: "session-1",
    previewId: "preview-1",
    protocolExecutionId: null,
    approvalId: "approval-1",
    matchHash: "b".repeat(64),
    environment: "core",
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: 7,
    marketIndex: 0,
    side: "buy",
    baseAmountInteger: "150",
    priceInteger: "200000",
    orderType: "market",
    timeInForce: "immediate-or-cancel",
    reduceOnly: false,
    triggerPriceInteger: null,
    orderExpiryMs: 0,
    clientOrderIndexPolicy: "vex_assigned_v1",
    providerVersion: "v1",
    credentialRefJson: {
      kind: "encrypted_vault_reference",
      environment: "core",
      accountIndex: ACCOUNT_INDEX,
      apiKeyIndex: 7,
      vaultCredentialId: "lighter/core/account-42/api-key-7",
    },
    approvalStatus: "approved",
    executionState: "submitted",
    decisionReason: "approved",
    decidedAt: "2026-09-08T09:00:00.000Z",
    nonceReservationId: "reservation-1",
    nonceValue: "9",
    clientOrderIndex: CLIENT_ORDER_INDEX,
    signerTxHash: "0xsigner",
    submittedTxHash: "0xsubmitted",
    submitCode: 200,
    submitMessage: "accepted",
    predictedExecutionTimeMs: 500,
    volumeQuotaRemaining: null,
    ambiguousReason: null,
    signedAt: "2026-09-08T09:00:00.000Z",
    submittedAt: "2026-09-08T09:00:01.000Z",
    apiAcceptedAt: "2026-09-08T09:00:01.000Z",
    ambiguousAt: null,
    providerOrderId: null,
    providerOrderStatus: null,
    providerOutcomeSource: null,
    providerOutcomeJson: null,
    providerOutcomeCheckedAt: null,
    preSubmitRevalidationJson: { baseDecimals: 2, priceDecimals: 2 },
    preSubmitRevalidatedAt: "2026-09-08T09:00:00.000Z",
    integratorFees: { integratorAccountIndex: 5, integratorMakerFee: 400, integratorTakerFee: 1000 },
    createdAt: "2026-09-08T09:00:00.000Z",
    updatedAt: "2026-09-08T09:00:01.000Z",
    expiresAt: "2026-09-08T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * A recording ledger: the same identity map `lighter_fills` enforces in SQL,
 * and the same SUM over `base_size` the completeness gate reads back.
 *
 * The sum is served from the rows this ledger actually holds, so a test never
 * has to state the completeness answer by hand - it falls out of what was
 * recorded, which is the property under test.
 */
function ledger(options: { readonly failFirst?: boolean; readonly failOn?: string } = {}) {
  const rows = new Map<string, LighterFillRecord>();
  let failuresLeft = options.failFirst === true ? 1 : 0;
  const failedIdentities = new Set<string>();
  const recordFill = vi.fn<LighterFillObservationDeps["recordFill"]>(async (record: LighterFillRecord) => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error("ledger write interrupted");
    }
    if (options.failOn !== undefined
      && record.canonicalIdentity === options.failOn
      && !failedIdentities.has(record.canonicalIdentity)) {
      failedIdentities.add(record.canonicalIdentity);
      throw new Error("ledger write interrupted");
    }
    const existing = rows.get(record.canonicalIdentity);
    if (existing !== undefined) {
      return { kind: "duplicate" as const, fillId: 1 };
    }
    rows.set(record.canonicalIdentity, record);
    return { kind: "recorded" as const, fillId: rows.size };
  });
  const recordedFillBaseSize = vi.fn<LighterFillObservationDeps["recordedFillBaseSize"]>(
    async (executionIntentId: string) => {
      let total = 0n;
      for (const row of rows.values()) {
        if (row.executionIntentId !== executionIntentId) continue;
        // The ledger stores base_size in the market's four size decimals; the
        // sum is exact integer arithmetic on those, never a float.
        total += baseSizeUnits(row.baseSize);
      }
      return formatBaseSize(total);
    },
  );
  return { rows, recordFill, recordedFillBaseSize };
}

const BASE_SIZE_DECIMALS = 4;

function baseSizeUnits(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(BASE_SIZE_DECIMALS, "0").slice(0, BASE_SIZE_DECIMALS)}`);
}

function formatBaseSize(units: bigint): string {
  const text = units.toString().padStart(BASE_SIZE_DECIMALS + 1, "0");
  return `${text.slice(0, text.length - BASE_SIZE_DECIMALS)}.${text.slice(text.length - BASE_SIZE_DECIMALS)}`;
}

function fillDeps(
  recordFill: LighterFillObservationDeps["recordFill"],
  recordedFillBaseSize: LighterFillObservationDeps["recordedFillBaseSize"] =
    vi.fn<LighterFillObservationDeps["recordedFillBaseSize"]>(async () => "0"),
): LighterFillObservationDeps {
  resetLighterMarketAssetsCache();
  return {
    recordedFillBaseSize,
    client: {
      getMarketDetails: vi.fn<FillClient["getMarketDetails"]>(async () => ({
        code: 200,
        order_book_details: [{
          symbol: "ETH",
          market_id: 0,
          market_type: "perp",
          base_asset_id: 1,
          quote_asset_id: 0,
          status: "active",
          taker_fee: "0",
          maker_fee: "0",
          liquidation_fee: "0",
          min_base_amount: "0",
          min_quote_amount: "0",
          supported_size_decimals: 4,
          supported_price_decimals: 2,
          supported_quote_decimals: 6,
          order_quote_limit: "0",
          is_maker_fee_enabled: true,
          is_taker_fee_enabled: true,
        }],
        spot_order_book_details: [],
      })),
      getAssetDetails: vi.fn<FillClient["getAssetDetails"]>(async () => ({
        code: 200,
        asset_details: [
          // The Core collateral as Lighter lists it: asset 3, the deployment's
          // pinned USDC proxy, six decimals on both sides.
          {
            asset_id: 3,
            symbol: "USDC",
            l1_decimals: 6,
            decimals: 6,
            min_transfer_amount: "0",
            l1_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          },
          { asset_id: 1, symbol: "ETH", l1_decimals: 18, decimals: 18, min_transfer_amount: "0", l1_address: "0x" },
        ],
      })),
    },
    recordFill,
    findFeeAuthorization: vi.fn<LighterFillObservationDeps["findFeeAuthorization"]>(async () => null),
  };
}

/**
 * A trade frame carries its own evidence, so it must never spend a privileged
 * follow-up read. Asking is a defect, not a quiet empty page.
 */
function unaskedTradesReader() {
  return vi.fn<StreamClient["getAccountTrades"]>(async () => {
    throw new Error("unexpected account trades read on a trade frame");
  });
}

function streamDeps(
  intent: LighterOrderExecutionIntentRow,
  fills: LighterFillObservationDeps,
  markStreamOutcome: Mock<MarkStreamOutcome> = vi.fn<MarkStreamOutcome>(async () => intent),
): { deps: LighterAccountStreamReconciliationDeps; markStreamOutcome: Mock<MarkStreamOutcome> } {
  const deps: LighterAccountStreamReconciliationDeps = {
    client: {
      getNextNonce: vi.fn<StreamClient["getNextNonce"]>(async () => ({ code: 200, nonce: 10 })),
      getAccountTrades: unaskedTradesReader(),
    },
    orderIntents: {
      listStreamWatchable: vi.fn<OrderIntents["listStreamWatchable"]>(async () => [intent]),
      markStreamOutcome,
      markEvidenceConflict: vi.fn<OrderIntents["markEvidenceConflict"]>(async () => null),
    },
    lifecycleIntents: {
      listStreamWatchable: vi.fn<StreamLifecycleIntents["listStreamWatchable"]>(async () => []),
      markStreamEvidence: vi.fn<StreamLifecycleIntents["markStreamEvidence"]>(async () => null),
    },
    nonceState: {
      find: vi.fn<StreamNonceState["find"]>(async () => null),
      recordExecutionObserved: vi.fn<StreamNonceState["recordExecutionObserved"]>(async () => null),
    },
    fills,
  };
  return { deps, markStreamOutcome };
}

describe("account stream: every fill in the frame reaches the ledger", () => {
  it("records TWO rows for two fills of one order, though the intent advances once", async () => {
    const { rows, recordFill } = ledger();
    const intent = executionIntent();
    const { deps, markStreamOutcome } = streamDeps(intent, fillDeps(recordFill));

    const report = await reconcileLighterAccountStreamMessage(
      "core",
      ACCOUNT_INDEX,
      tradesFrame([
        trade({ trade_id: 1, trade_id_str: "1", size: "1.0" }),
        trade({ trade_id: 2, trade_id_str: "2", size: "0.5", block_height: 1001 }),
      ]),
      deps,
    );

    expect(report.fillsObserved).toBe(2);
    expect(report.fillsRecorded).toBe(2);
    expect([...rows.keys()].sort()).toEqual([
      "lighter:core:42:0:1",
      "lighter:core:42:0:2",
    ]);
    // The mutable outcome still carries ONE trade - which is exactly why the
    // ledger cannot be derived from it.
    expect(markStreamOutcome).toHaveBeenCalledTimes(1);
  });

  it("records every fill even when the transition is DEDUPLICATED away", async () => {
    const { rows, recordFill } = ledger();
    const intent = executionIntent({
      providerOutcomeSource: "account_trade",
      providerOutcomeJson: { tradeId: "1" },
    });
    const { deps, markStreamOutcome } = streamDeps(intent, fillDeps(recordFill));

    const report = await reconcileLighterAccountStreamMessage(
      "core",
      ACCOUNT_INDEX,
      tradesFrame([
        trade({ trade_id: 1, trade_id_str: "1", size: "1.0" }),
        trade({ trade_id: 2, trade_id_str: "2", size: "0.5" }),
      ]),
      deps,
    );

    expect(markStreamOutcome).not.toHaveBeenCalled();
    expect(report.fillsRecorded).toBe(2);
    expect(rows.size).toBe(2);
  });

  it("replay after an INTERRUPTED ledger write loses no row and duplicates none", async () => {
    const { rows, recordFill } = ledger({ failFirst: true });
    const intent = executionIntent();
    const fills = fillDeps(recordFill);
    const frame = tradesFrame([
      trade({ trade_id: 1, trade_id_str: "1", size: "1.0" }),
      trade({ trade_id: 2, trade_id_str: "2", size: "0.5" }),
    ]);

    const first = await reconcileLighterAccountStreamMessage(
      "core", ACCOUNT_INDEX, frame, streamDeps(intent, fills).deps,
    );
    expect(first.fillsRecorded).toBe(1);
    expect(rows.size).toBe(1);

    const replay = await reconcileLighterAccountStreamMessage(
      "core", ACCOUNT_INDEX, frame, streamDeps(intent, fills).deps,
    );

    // The interrupted row is written now; the one that survived is recognised
    // rather than written twice.
    expect(replay.fillsRecorded).toBe(1);
    expect([...rows.keys()].sort()).toEqual([
      "lighter:core:42:0:1",
      "lighter:core:42:0:2",
    ]);
  });

  it("a ledger write that keeps failing NEVER stops the provider outcome committing", async () => {
    const recordFill = vi.fn<LighterFillObservationDeps["recordFill"]>(async () => {
      throw new Error("ledger unavailable");
    });
    const intent = executionIntent();
    const { deps, markStreamOutcome } = streamDeps(intent, fillDeps(recordFill));

    const report = await reconcileLighterAccountStreamMessage(
      "core", ACCOUNT_INDEX, tradesFrame([trade()]), deps,
    );

    expect(report.createTradeMatches).toBe(1);
    expect(report.fillsRecorded).toBe(0);
    expect(markStreamOutcome).toHaveBeenCalledTimes(1);
    expect(markStreamOutcome.mock.calls[0]?.[0]).toMatchObject({ state: "partially_filled" });
  });
});

describe("order repair: trades read alongside order evidence are not lost", () => {
  it("records the trades even when an ACTIVE order classifies the intent first", async () => {
    const { rows, recordFill } = ledger();
    const intent = executionIntent({ executionState: "sequencer_pending" });
    const resolved = { ...intent, executionState: "partially_filled" as const };
    const deps: LighterOrderRepairDeps = {
      client: {
        getNextNonce: vi.fn<RepairClient["getNextNonce"]>(async () => ({ code: 200, nonce: 10 })),
        getAccountActiveOrders: vi.fn<RepairClient["getAccountActiveOrders"]>(async () => ({
          code: 200,
          orders: [{
            order_index: 8,
            client_order_index: Number(CLIENT_ORDER_INDEX),
            order_id: "8",
            client_order_id: CLIENT_ORDER_INDEX,
            owner_account_index: ACCOUNT_INDEX,
            market_index: 0,
            status: "open",
            initial_base_amount: "1.50",
            remaining_base_amount: "0.50",
            filled_base_amount: "1.00",
            filled_quote_amount: "2000.00",
            price: "2000.00",
            is_ask: false,
          }],
        })),
        getAccountInactiveOrders: vi.fn<RepairClient["getAccountInactiveOrders"]>(
          async () => ({ code: 200, orders: [] }),
        ),
        getAccountTrades: vi.fn<RepairClient["getAccountTrades"]>(
          async () => ({ code: 200, trades: [trade()] }),
        ),
      },
      intents: {
        listUnresolved: vi.fn<RepairIntents["listUnresolved"]>(async () => [intent]),
        findByIntentIdAnySession: vi.fn<RepairIntents["findByIntentIdAnySession"]>(async () => intent),
        markRepairResolved: vi.fn<RepairIntents["markRepairResolved"]>(async () => resolved),
        markEvidenceConflict: vi.fn<RepairIntents["markEvidenceConflict"]>(async () => null),
      },
      nonceState: {
        find: vi.fn<RepairNonceState["find"]>(async () => null),
        releaseReservation: vi.fn<RepairNonceState["releaseReservation"]>(async () => null),
        recordExecutionObserved: vi.fn<RepairNonceState["recordExecutionObserved"]>(async () => null),
      },
      resolvePrivilegedAccountAuth: vi.fn(async () => ({ token: "read-token", accountIndex: ACCOUNT_INDEX })),
      fills: fillDeps(recordFill),
      now: () => 1_760_000_000_000,
    };

    const report = await repairLighterOrderIntent(intent, deps);

    expect(report.evidenceSource).toBe("active_order");
    expect([...rows.keys()]).toEqual(["lighter:core:42:0:1"]);
  });
});

/**
 * THE ORDER-EVIDENCE GAP, measured live on 2026-09-08.
 *
 * One IOC buy of 0.0050 ETH settled from an `update/account_all_orders` frame
 * (status filled) before any trade frame was consumed. The intent reached
 * `filled`, `lighter__order_status` classified it `already_terminal` without
 * reading anything, and `lighter_fills` stayed EMPTY - so AgentScan would
 * never have heard of a fill that happened on the venue.
 *
 * The trade below is that trade, with its real economics.
 */
const LIVE_TRADE: LighterTrade = {
  trade_id: 491032980,
  trade_id_str: "491032980",
  tx_hash: "176f5ad254b7604e6d59f658607947b873979dc979ad16f680ecf08fa00c04fc0d7d91e1d3746ee3",
  type: "trade",
  market_id: 0,
  size: "0.0050",
  price: "2484.97",
  usd_amount: "12.424850",
  ask_id: 281475039427104,
  ask_id_str: "281475039427104",
  bid_id: 562949887334777,
  bid_id_str: "562949887334777",
  ask_account_id: 16948,
  bid_account_id: ACCOUNT_INDEX,
  is_maker_ask: true,
  block_height: 18912426,
  timestamp: 1788863950104,
  transaction_time: 1788863950329557,
  integrator_taker_fee: 1000,
  integrator_taker_fee_collector_index: 22869,
  taker_fee: 350,
  ask_client_id: 181836669862286,
  bid_client_id: 40253714670725,
  ask_client_id_str: "181836669862286",
  bid_client_id_str: CLIENT_ORDER_INDEX,
  taker_position_size_before: "0.0000",
  taker_entry_quote_before: "0.000000",
  taker_position_sign_changed: true,
  maker_position_size_before: "0.0000",
  maker_entry_quote_before: "0.000000",
  maker_position_sign_changed: true,
  ask_order_version: 0,
  bid_order_version: 0,
};

function filledOrder(overrides: Partial<LighterAccountOrder> = {}): LighterAccountOrder {
  return {
    order_index: 1,
    client_order_index: Number(CLIENT_ORDER_INDEX),
    order_id: "562949887334777",
    client_order_id: CLIENT_ORDER_INDEX,
    market_index: 0,
    owner_account_index: ACCOUNT_INDEX,
    initial_base_amount: "0.0050",
    remaining_base_amount: "0",
    filled_base_amount: "0.0050",
    filled_quote_amount: "12.424850",
    price: "2484.97",
    side: "buy",
    status: "filled",
    ...overrides,
  };
}

function ordersFrame(orders: readonly LighterAccountOrder[]): LighterAccountAllOrdersStreamMessage {
  return {
    type: "update/account_all_orders",
    channel: `account_all_orders:${ACCOUNT_INDEX}`,
    orders: { "0": [...orders] },
  };
}

/** A trades reader typed as the reconciler's own dependency, so the assertions run on the real contract. */
function tradesReader(trades: readonly LighterTrade[]) {
  return vi.fn<StreamClient["getAccountTrades"]>(async () => ({ code: 200, trades: [...trades] }));
}

function orderFrameDeps(
  intent: LighterOrderExecutionIntentRow,
  fills: LighterFillObservationDeps,
  getAccountTrades: StreamClient["getAccountTrades"],
): LighterAccountStreamReconciliationDeps {
  return {
    client: {
      getNextNonce: vi.fn<StreamClient["getNextNonce"]>(async () => ({ code: 200, nonce: 10 })),
      getAccountTrades,
    },
    orderIntents: {
      listStreamWatchable: vi.fn(async () => [intent]),
      markStreamOutcome: vi.fn(async () => intent),
      markEvidenceConflict: vi.fn(async () => null),
    },
    lifecycleIntents: {
      listStreamWatchable: vi.fn(async () => []),
      markStreamEvidence: vi.fn(async () => null),
    },
    nonceState: { find: vi.fn(async () => null), recordExecutionObserved: vi.fn(async () => null) },
    fills,
    resolveAuth: vi.fn(async () => ({ token: "read-token", accountIndex: ACCOUNT_INDEX })),
  };
}

describe("account stream: an ORDER frame with no trade still reaches the ledger", () => {
  it("reads the account trades ONCE and records the fill the order frame proves", async () => {
    const { rows, recordFill } = ledger();
    const intent = executionIntent();
    const getAccountTrades = tradesReader([LIVE_TRADE]);
    const deps = orderFrameDeps(intent, fillDeps(recordFill), getAccountTrades);

    const report = await reconcileLighterAccountStreamMessage(
      "core", ACCOUNT_INDEX, ordersFrame([filledOrder()]), deps,
    );

    expect(getAccountTrades).toHaveBeenCalledTimes(1);
    // The bound is Lighter's own documented maximum page, asserted by name so
    // a change to it is a change to a declared contract, not a silent edit.
    expect(LIGHTER_FILL_FOLLOW_UP_TRADES_LIMIT).toBe(100);
    expect(getAccountTrades.mock.calls[0]).toEqual([
      "core",
      { accountIndex: ACCOUNT_INDEX, limit: LIGHTER_FILL_FOLLOW_UP_TRADES_LIMIT, sortBy: "timestamp" },
      { token: "read-token", accountIndex: ACCOUNT_INDEX },
    ]);
    expect(report.fillsObserved).toBe(1);
    expect(report.fillsRecorded).toBe(1);
    const recorded = rows.get("lighter:core:42:0:491032980");
    expect(recorded).toBeDefined();
    expect(recorded?.executionIntentId).toBe(intent.intentId);
    expect(recorded?.usdAmount).toBe("12.424850");
    expect(recorded?.integratorFeeTickObserved).toBe(1000);
    expect(recorded?.exchangeFeeTickObserved).toBe(350);
  });

  it("does not read at all for an order frame that fills nothing", async () => {
    const { recordFill } = ledger();
    const getAccountTrades = tradesReader([LIVE_TRADE]);
    const deps = orderFrameDeps(executionIntent(), fillDeps(recordFill), getAccountTrades);

    await reconcileLighterAccountStreamMessage(
      "core",
      ACCOUNT_INDEX,
      ordersFrame([filledOrder({ status: "open", filled_base_amount: "0", remaining_base_amount: "0.0050" })]),
      deps,
    );

    expect(getAccountTrades).not.toHaveBeenCalled();
    expect(recordFill).not.toHaveBeenCalled();
  });

  it("records ONE row when the order frame is followed by the trade frame for the same fill", async () => {
    const { rows, recordFill, recordedFillBaseSize } = ledger();
    const intent = executionIntent();
    const fills = fillDeps(recordFill, recordedFillBaseSize);
    const getAccountTrades = tradesReader([LIVE_TRADE]);

    await reconcileLighterAccountStreamMessage(
      "core", ACCOUNT_INDEX, ordersFrame([filledOrder()]), orderFrameDeps(intent, fills, getAccountTrades),
    );

    const second = await reconcileLighterAccountStreamMessage(
      "core", ACCOUNT_INDEX, tradesFrame([LIVE_TRADE]), streamDeps(intent, fills).deps,
    );

    expect(second.fillsObserved).toBe(1);
    // Observed again, recorded once: the ledger dedupes on canonical identity.
    expect(second.fillsRecorded).toBe(0);
    expect([...rows.keys()]).toEqual(["lighter:core:42:0:491032980"]);
  });

  it("spends no provider request when the ledger is already LEVEL with the frame", async () => {
    const { recordFill } = ledger();
    const getAccountTrades = tradesReader([LIVE_TRADE]);
    // The frame says 0.0050 filled and the ledger already sums to 0.0050.
    const fills = fillDeps(
      recordFill,
      vi.fn<LighterFillObservationDeps["recordedFillBaseSize"]>(async () => "0.0050"),
    );

    await reconcileLighterAccountStreamMessage(
      "core", ACCOUNT_INDEX, ordersFrame([filledOrder()]),
      orderFrameDeps(executionIntent(), fills, getAccountTrades),
    );

    expect(getAccountTrades).not.toHaveBeenCalled();
  });

  /**
   * THE FILL AN EXISTENCE TEST THREW AWAY, driven through the reconciler.
   *
   * A partial frame records fill A. The order then reaches `filled` and the
   * frame reports MORE base filled than the ledger holds, because trade B has
   * not arrived yet. A follow-up gated on "a row exists" skips its read here,
   * the intent leaves the stream-watchable set, and terminal repair applies
   * the same test - so B is never recorded by anyone. Gated on completeness,
   * the read runs and B lands.
   */
  it("still reads when the frame reports MORE filled than the ledger holds", async () => {
    const { rows, recordFill, recordedFillBaseSize } = ledger();
    const intent = executionIntent();
    const fills = fillDeps(recordFill, recordedFillBaseSize);
    const tradeA = { ...LIVE_TRADE, trade_id: 1, trade_id_str: "1", size: "0.0020" };
    const tradeB = { ...LIVE_TRADE, trade_id: 2, trade_id_str: "2", size: "0.0030" };

    // 1. The partial frame's trade records fill A and nothing else.
    await reconcileLighterAccountStreamMessage(
      "core", ACCOUNT_INDEX, tradesFrame([tradeA]), streamDeps(intent, fills).deps,
    );
    expect([...rows.keys()]).toEqual(["lighter:core:42:0:1"]);

    // 2. The order frame reports the order fully filled at 0.0050 while the
    //    ledger holds 0.0020. Trade B is on the account's trade page by now.
    const getAccountTrades = tradesReader([tradeA, tradeB]);
    const report = await reconcileLighterAccountStreamMessage(
      "core",
      ACCOUNT_INDEX,
      ordersFrame([filledOrder()]),
      orderFrameDeps(intent, fills, getAccountTrades),
    );

    expect(getAccountTrades).toHaveBeenCalledTimes(1);
    expect(report.fillsRecorded).toBe(1);
    expect([...rows.keys()].sort()).toEqual(["lighter:core:42:0:1", "lighter:core:42:0:2"]);
  });

  /**
   * The same sequence with B's FIRST ledger write refused. The outcome the
   * reconciler committed is untouched, and the next trigger - terminal repair
   * - still sees the ledger behind the venue and writes B.
   */
  it("recovers fill B on repair when its first ledger write was refused", async () => {
    const { rows, recordFill, recordedFillBaseSize } = ledger({ failOn: "lighter:core:42:0:2" });
    const intent = executionIntent();
    const fills = fillDeps(recordFill, recordedFillBaseSize);
    const tradeA = { ...LIVE_TRADE, trade_id: 1, trade_id_str: "1", size: "0.0020" };
    const tradeB = { ...LIVE_TRADE, trade_id: 2, trade_id_str: "2", size: "0.0030" };

    await reconcileLighterAccountStreamMessage(
      "core", ACCOUNT_INDEX, tradesFrame([tradeA]), streamDeps(intent, fills).deps,
    );
    const frameReport = await reconcileLighterAccountStreamMessage(
      "core",
      ACCOUNT_INDEX,
      ordersFrame([filledOrder()]),
      orderFrameDeps(intent, fills, tradesReader([tradeA, tradeB])),
    );
    // B was observed and refused; the frame's own outcome is unaffected.
    expect(frameReport.fillsRecorded).toBe(0);
    expect([...rows.keys()]).toEqual(["lighter:core:42:0:1"]);

    const terminal = executionIntent({
      executionState: "filled",
      providerOutcomeSource: "inactive_order",
      providerOutcomeJson: { filledBaseAmount: "0.0050" },
    });
    const repairTrades = tradesReader([tradeA, tradeB]);
    const repairReport = await repairLighterOrderIntent(terminal, {
      client: {
        getNextNonce: vi.fn<RepairClient["getNextNonce"]>(async () => ({ code: 200, nonce: 10 })),
        getAccountActiveOrders: vi.fn<RepairClient["getAccountActiveOrders"]>(
          async () => ({ code: 200, orders: [] }),
        ),
        getAccountInactiveOrders: vi.fn<RepairClient["getAccountInactiveOrders"]>(
          async () => ({ code: 200, orders: [] }),
        ),
        getAccountTrades: repairTrades,
      },
      intents: {
        listUnresolved: vi.fn<RepairIntents["listUnresolved"]>(async () => [terminal]),
        findByIntentIdAnySession: vi.fn<RepairIntents["findByIntentIdAnySession"]>(async () => terminal),
        markRepairResolved: vi.fn<RepairIntents["markRepairResolved"]>(async () => terminal),
        markEvidenceConflict: vi.fn<RepairIntents["markEvidenceConflict"]>(async () => null),
      },
      nonceState: {
        find: vi.fn<RepairNonceState["find"]>(async () => null),
        releaseReservation: vi.fn<RepairNonceState["releaseReservation"]>(async () => null),
        recordExecutionObserved: vi.fn<RepairNonceState["recordExecutionObserved"]>(async () => null),
      },
      resolvePrivilegedAccountAuth: vi.fn(async () => ({ token: "read-token", accountIndex: ACCOUNT_INDEX })),
      fills,
      now: () => 1_788_863_960_000,
    });

    expect(repairReport.resolution).toBe("already_terminal");
    expect(repairTrades).toHaveBeenCalledTimes(1);
    expect([...rows.keys()].sort()).toEqual(["lighter:core:42:0:1", "lighter:core:42:0:2"]);
  });
});

describe("order repair: a terminal intent whose fills never reached the ledger", () => {
  function repairDeps(
    intent: LighterOrderExecutionIntentRow,
    fills: LighterFillObservationDeps,
    getAccountTrades: LighterOrderRepairDeps["client"]["getAccountTrades"],
  ): LighterOrderRepairDeps {
    return {
      client: {
        getNextNonce: vi.fn<LighterOrderRepairDeps["client"]["getNextNonce"]>(
          async () => ({ code: 200, nonce: 10 }),
        ),
        getAccountActiveOrders: vi.fn<LighterOrderRepairDeps["client"]["getAccountActiveOrders"]>(
          async () => ({ code: 200, orders: [] }),
        ),
        getAccountInactiveOrders: vi.fn<LighterOrderRepairDeps["client"]["getAccountInactiveOrders"]>(
          async () => ({ code: 200, orders: [] }),
        ),
        getAccountTrades,
      },
      intents: {
        listUnresolved: vi.fn(async () => [intent]),
        findByIntentIdAnySession: vi.fn(async () => intent),
        markRepairResolved: vi.fn(async () => intent),
        markEvidenceConflict: vi.fn(async () => null),
      },
      nonceState: {
        find: vi.fn(async () => null),
        releaseReservation: vi.fn(async () => null),
        recordExecutionObserved: vi.fn(async () => null),
      },
      resolvePrivilegedAccountAuth: vi.fn(async () => ({ token: "read-token", accountIndex: ACCOUNT_INDEX })),
      fills,
      now: () => 1_788_863_960_000,
    };
  }

  it("already_terminal with an EMPTY ledger reads the trades once and records the fill", async () => {
    const { rows, recordFill } = ledger();
    const intent = executionIntent({
      executionState: "filled",
      providerOutcomeSource: "inactive_order",
      providerOutcomeJson: { filledBaseAmount: "0.0050" },
    });
    const getAccountTrades = tradesReader([LIVE_TRADE]);

    const report = await repairLighterOrderIntent(
      intent, repairDeps(intent, fillDeps(recordFill), getAccountTrades),
    );

    expect(report.resolution).toBe("already_terminal");
    expect(report.stateAfter).toBe("filled");
    expect(getAccountTrades).toHaveBeenCalledTimes(1);
    expect([...rows.keys()]).toEqual(["lighter:core:42:0:491032980"]);
  });

  it("already_terminal with every reported fill already recorded reads nothing", async () => {
    const { recordFill } = ledger();
    const intent = executionIntent({
      executionState: "filled",
      providerOutcomeSource: "inactive_order",
      providerOutcomeJson: { filledBaseAmount: "0.0050" },
    });
    const getAccountTrades = tradesReader([LIVE_TRADE]);
    const fills = fillDeps(
      recordFill,
      vi.fn<LighterFillObservationDeps["recordedFillBaseSize"]>(async () => "0.0050"),
    );

    const report = await repairLighterOrderIntent(intent, repairDeps(intent, fills, getAccountTrades));

    expect(report.resolution).toBe("already_terminal");
    expect(getAccountTrades).not.toHaveBeenCalled();
    expect(recordFill).not.toHaveBeenCalled();
  });

  it("a terminal intent that moved no money is never read for", async () => {
    const { recordFill } = ledger();
    const intent = executionIntent({ executionState: "canceled" });
    const getAccountTrades = tradesReader([LIVE_TRADE]);

    await repairLighterOrderIntent(intent, repairDeps(intent, fillDeps(recordFill), getAccountTrades));

    expect(getAccountTrades).not.toHaveBeenCalled();
  });
});

describe("the follow-up read never changes the outcome that triggered it", () => {
  it("resolves to a report with the failure COUNTED when the provider read rejects", async () => {
    const { rows, recordFill } = ledger();

    const report = await observeLighterFillsFromAccountTrades({
      intent: {
        intentId: "lighter-order-follow-up",
        environment: "core",
        accountIndex: ACCOUNT_INDEX,
        marketIndex: 0,
        side: "buy",
        clientOrderIndex: CLIENT_ORDER_INDEX,
      },
      authorizedFees: null,
      deps: fillDeps(recordFill),
      read: {
        getAccountTrades: vi.fn<
          Parameters<typeof observeLighterFillsFromAccountTrades>[0]["read"]["getAccountTrades"]
        >(async () => {
          throw new Error("provider unreachable");
        }),
        auth: { token: "read-token", accountIndex: ACCOUNT_INDEX },
        submittedTxHash: "0xsubmitted",
      },
    });

    expect(report).toEqual({ observed: 0, recorded: 0, duplicates: 0, failed: 1 });
    expect(rows.size).toBe(0);
  });
});

describe("market assets: a perpetual names its instrument and its collateral, a spot market its two assets", () => {
  // Measured live on 2026-09-08: Lighter's orderBookDetails reports
  // base_asset_id 0 and quote_asset_id 0 for every perpetual on Core and on
  // Robinhood Chain, while a spot market carries real asset ids.
  const collateral: LighterAssetDetail = {
    asset_id: 3,
    symbol: "USDC",
    l1_decimals: 6,
    decimals: 6,
    min_transfer_amount: "0",
    l1_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  };
  const eth: LighterAssetDetail = {
    asset_id: 1, symbol: "ETH", l1_decimals: 18, decimals: 18, min_transfer_amount: "0", l1_address: "0x",
  };

  function marketDeps(
    detail: LighterMarketDetail,
    assets: readonly LighterAssetDetail[],
  ): LighterFillObservationDeps {
    resetLighterMarketAssetsCache();
    return {
      recordedFillBaseSize: vi.fn<LighterFillObservationDeps["recordedFillBaseSize"]>(async () => "0"),
      client: {
        getMarketDetails: vi.fn<FillClient["getMarketDetails"]>(async () => ({
          code: 200,
          order_book_details: detail.market_type === "perp" ? [detail] : [],
          spot_order_book_details: detail.market_type === "spot" ? [detail] : [],
        })),
        getAssetDetails: vi.fn<FillClient["getAssetDetails"]>(
          async () => ({ code: 200, asset_details: [...assets] }),
        ),
      },
      recordFill: vi.fn<LighterFillObservationDeps["recordFill"]>(),
      findFeeAuthorization: vi.fn<LighterFillObservationDeps["findFeeAuthorization"]>(async () => null),
    };
  }

  const perp: LighterMarketDetail = {
    symbol: "ETH", market_id: 0, market_type: "perp", base_asset_id: 0, quote_asset_id: 0, status: "active",
    taker_fee: "0", maker_fee: "0", liquidation_fee: "0", min_base_amount: "0", min_quote_amount: "0",
    supported_size_decimals: 4, supported_price_decimals: 2, supported_quote_decimals: 6, order_quote_limit: "0",
    is_maker_fee_enabled: true, is_taker_fee_enabled: true,
  };
  const spot: LighterMarketDetail = {
    ...perp, symbol: "ETH/USDC", market_id: 2048, market_type: "spot", base_asset_id: 1, quote_asset_id: 3,
  };

  it("resolves a perpetual with asset ids 0/0 to the instrument and the verified collateral", async () => {
    const market = await resolveLighterMarketAssets("core", 0, marketDeps(perp, [collateral, eth]));
    expect(market).toEqual({
      marketSymbol: "ETH",
      baseAsset: { venueAssetId: "lighter:core:perp:0", symbol: "ETH", decimals: 4 },
      quoteAsset: { venueAssetId: "lighter:core:asset:3", symbol: "USDC", decimals: 6 },
      spot: false,
      sizeDecimals: 4,
    });
  });

  it("resolves a spot market through its real asset ids", async () => {
    const market = await resolveLighterMarketAssets("core", 2048, marketDeps(spot, [collateral, eth]));
    expect(market).toEqual({
      marketSymbol: "ETH/USDC",
      baseAsset: { venueAssetId: "lighter:core:asset:1", symbol: "ETH", decimals: 18 },
      quoteAsset: { venueAssetId: "lighter:core:asset:3", symbol: "USDC", decimals: 6 },
      spot: true,
      sizeDecimals: 4,
    });
  });

  it("refuses a perpetual whose collateral row is not the deployment's verified asset", async () => {
    // The same row under the wrong id, and the right id with a foreign L1 address.
    const wrongId = { ...collateral, asset_id: 0 };
    await expect(resolveLighterMarketAssets("core", 0, marketDeps(perp, [wrongId, eth]))).rejects.toThrow(/verified core USDC collateral/);
    const wrongAddress = { ...collateral, l1_address: "0x0000000000000000000000000000000000000001" };
    await expect(resolveLighterMarketAssets("core", 0, marketDeps(perp, [wrongAddress, eth]))).rejects.toThrow(/verified core USDC collateral/);
  });
});

describe("observation counters: the report says what the ledger answered", () => {
  const intent = {
    intentId: "lighter-order-counters",
    environment: "core" as const,
    accountIndex: ACCOUNT_INDEX,
    marketIndex: 0,
    side: "buy" as const,
    clientOrderIndex: CLIENT_ORDER_INDEX,
  };

  it("counts a fill the ledger enriched as already held, never as a failure", async () => {
    // The ledger held the row without the account's own fields and this
    // observation supplied them: nothing was inserted and nothing failed. The
    // revision the ledger bumped is its own business and not a count here.
    const recordFill = vi.fn<LighterFillObservationDeps["recordFill"]>(async () => ({
      kind: "enriched" as const,
      fillId: 1,
      revision: 1,
    }));

    const report = await observeLighterFills({
      intent,
      trades: [trade()],
      authorizedFees: null,
      deps: fillDeps(recordFill),
    });

    expect(recordFill).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ observed: 1, recorded: 0, duplicates: 1, failed: 0 });
  });

  it("counts an identity conflict as a failure, because the second report contradicts the ledger", async () => {
    const recordFill = vi.fn<LighterFillObservationDeps["recordFill"]>(async () => ({
      kind: "conflict" as const,
      fillId: 1,
      fields: ["price"],
    }));

    const report = await observeLighterFills({
      intent,
      trades: [trade()],
      authorizedFees: null,
      deps: fillDeps(recordFill),
    });

    expect(report).toEqual({ observed: 1, recorded: 0, duplicates: 0, failed: 1 });
  });
});
