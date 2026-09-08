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
import { describe, it, expect, vi } from "vitest";

import type {
  LighterAccountAllOrdersStreamMessage,
  LighterAccountAllTradesStreamMessage,
  LighterAccountOrder,
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
  observeLighterFillsFromAccountTrades,
  resetLighterMarketAssetsCache,
  resolveLighterMarketAssets,
  type LighterFillObservationDeps,
} from "@vex-agent/tools/protocols/lighter/fill-observation.js";

const ACCOUNT_INDEX = 42;
const CLIENT_ORDER_INDEX = "700";

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

function tradesFrame(trades: LighterTrade[]): LighterAccountAllTradesStreamMessage {
  return {
    type: "update/account_all_trades",
    trades,
  } as unknown as LighterAccountAllTradesStreamMessage;
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
  } as LighterOrderExecutionIntentRow;
}

/** A recording ledger: the same identity map `lighter_fills` enforces in SQL. */
function ledger(options: { readonly failFirst?: boolean } = {}) {
  const rows = new Map<string, LighterFillRecord>();
  let failuresLeft = options.failFirst === true ? 1 : 0;
  const recordFill = vi.fn(async (record: LighterFillRecord) => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error("ledger write interrupted");
    }
    const existing = rows.get(record.canonicalIdentity);
    if (existing !== undefined) {
      return { kind: "duplicate" as const, fillId: 1 };
    }
    rows.set(record.canonicalIdentity, record);
    return { kind: "recorded" as const, fillId: rows.size };
  });
  return { rows, recordFill };
}

function fillDeps(
  recordFill: ReturnType<typeof ledger>["recordFill"],
  hasFillForIntent: LighterFillObservationDeps["hasFillForIntent"] =
    vi.fn<LighterFillObservationDeps["hasFillForIntent"]>(async () => false),
): LighterFillObservationDeps {
  resetLighterMarketAssetsCache();
  return {
    hasFillForIntent,
    client: {
      getMarketDetails: vi.fn(async () => ({
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
      getAssetDetails: vi.fn(async () => ({
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
    } as unknown as LighterFillObservationDeps["client"],
    recordFill: recordFill as unknown as LighterFillObservationDeps["recordFill"],
    findFeeAuthorization: vi.fn(async () => null) as unknown as LighterFillObservationDeps["findFeeAuthorization"],
  };
}

function streamDeps(
  intent: LighterOrderExecutionIntentRow,
  fills: LighterFillObservationDeps,
  markStreamOutcome = vi.fn(async () => intent),
): { deps: LighterAccountStreamReconciliationDeps; markStreamOutcome: ReturnType<typeof vi.fn> } {
  const deps = {
    client: { getNextNonce: vi.fn(async () => ({ nonce: 10 })) },
    orderIntents: {
      listStreamWatchable: vi.fn(async () => [intent]),
      markStreamOutcome,
      markEvidenceConflict: vi.fn(async () => null),
    },
    lifecycleIntents: {
      listStreamWatchable: vi.fn(async () => []),
      markStreamEvidence: vi.fn(async () => null),
    },
    nonceState: { find: vi.fn(async () => null), recordExecutionObserved: vi.fn(async () => undefined) },
    fills,
  } as unknown as LighterAccountStreamReconciliationDeps;
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
    const recordFill = vi.fn(async () => {
      throw new Error("ledger unavailable");
    });
    const intent = executionIntent();
    const { deps, markStreamOutcome } = streamDeps(
      intent,
      fillDeps(recordFill as unknown as ReturnType<typeof ledger>["recordFill"]),
    );

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
    const deps = {
      client: {
        getNextNonce: vi.fn(async () => ({ nonce: 10 })),
        getAccountActiveOrders: vi.fn(async () => ({
          orders: [{
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
        getAccountInactiveOrders: vi.fn(async () => ({ orders: [] })),
        getAccountTrades: vi.fn(async () => ({ trades: [trade()] })),
      },
      intents: {
        listUnresolved: vi.fn(async () => [intent]),
        findByIntentIdAnySession: vi.fn(async () => intent),
        markRepairResolved: vi.fn(async () => resolved),
        markEvidenceConflict: vi.fn(async () => null),
      },
      nonceState: {
        find: vi.fn(async () => null),
        releaseReservation: vi.fn(async () => true),
        recordExecutionObserved: vi.fn(async () => undefined),
      },
      resolvePrivilegedAccountAuth: vi.fn(async () => ({ token: "read-token", accountIndex: ACCOUNT_INDEX })),
      fills: fillDeps(recordFill),
      now: () => 1_760_000_000_000,
    } as unknown as LighterOrderRepairDeps;

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

type StreamClient = LighterAccountStreamReconciliationDeps["client"];

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
    const { rows, recordFill } = ledger();
    const intent = executionIntent();
    const held = new Set<string>();
    const fills = fillDeps(
      recordFill,
      vi.fn<LighterFillObservationDeps["hasFillForIntent"]>(async (intentId) => held.has(intentId)),
    );
    const getAccountTrades = tradesReader([LIVE_TRADE]);

    await reconcileLighterAccountStreamMessage(
      "core", ACCOUNT_INDEX, ordersFrame([filledOrder()]), orderFrameDeps(intent, fills, getAccountTrades),
    );
    held.add(intent.intentId);

    const second = await reconcileLighterAccountStreamMessage(
      "core", ACCOUNT_INDEX, tradesFrame([LIVE_TRADE]), streamDeps(intent, fills).deps,
    );

    expect(second.fillsObserved).toBe(1);
    // Observed again, recorded once: the ledger dedupes on canonical identity.
    expect(second.fillsRecorded).toBe(0);
    expect([...rows.keys()]).toEqual(["lighter:core:42:0:491032980"]);
  });

  it("spends no provider request when the ledger already holds a fill for the intent", async () => {
    const { recordFill } = ledger();
    const getAccountTrades = tradesReader([LIVE_TRADE]);
    const fills = fillDeps(
      recordFill,
      vi.fn<LighterFillObservationDeps["hasFillForIntent"]>(async () => true),
    );

    await reconcileLighterAccountStreamMessage(
      "core", ACCOUNT_INDEX, ordersFrame([filledOrder()]),
      orderFrameDeps(executionIntent(), fills, getAccountTrades),
    );

    expect(getAccountTrades).not.toHaveBeenCalled();
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
    const intent = executionIntent({ executionState: "filled", providerOutcomeSource: "inactive_order" });
    const getAccountTrades = tradesReader([LIVE_TRADE]);

    const report = await repairLighterOrderIntent(
      intent, repairDeps(intent, fillDeps(recordFill), getAccountTrades),
    );

    expect(report.resolution).toBe("already_terminal");
    expect(report.stateAfter).toBe("filled");
    expect(getAccountTrades).toHaveBeenCalledTimes(1);
    expect([...rows.keys()]).toEqual(["lighter:core:42:0:491032980"]);
  });

  it("already_terminal with the row already present reads nothing", async () => {
    const { recordFill } = ledger();
    const intent = executionIntent({ executionState: "filled", providerOutcomeSource: "inactive_order" });
    const getAccountTrades = tradesReader([LIVE_TRADE]);
    const fills = fillDeps(
      recordFill,
      vi.fn<LighterFillObservationDeps["hasFillForIntent"]>(async () => true),
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
  const collateral = {
    asset_id: 3,
    symbol: "USDC",
    l1_decimals: 6,
    decimals: 6,
    min_transfer_amount: "0",
    l1_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  };
  const eth = { asset_id: 1, symbol: "ETH", l1_decimals: 18, decimals: 18, min_transfer_amount: "0", l1_address: "0x" };

  function marketDeps(detail: Record<string, unknown>, assets: readonly Record<string, unknown>[]): LighterFillObservationDeps {
    resetLighterMarketAssetsCache();
    return {
      hasFillForIntent: vi.fn(async () => false),
      client: {
        getMarketDetails: vi.fn(async () => ({
          code: 200,
          order_book_details: detail["market_type"] === "perp" ? [detail] : [],
          spot_order_book_details: detail["market_type"] === "spot" ? [detail] : [],
        })),
        getAssetDetails: vi.fn(async () => ({ code: 200, asset_details: assets })),
      } as unknown as LighterFillObservationDeps["client"],
      recordFill: vi.fn() as unknown as LighterFillObservationDeps["recordFill"],
      findFeeAuthorization: vi.fn(async () => null) as unknown as LighterFillObservationDeps["findFeeAuthorization"],
    };
  }

  const perp = {
    symbol: "ETH", market_id: 0, market_type: "perp", base_asset_id: 0, quote_asset_id: 0, status: "active",
    taker_fee: "0", maker_fee: "0", liquidation_fee: "0", min_base_amount: "0", min_quote_amount: "0",
    supported_size_decimals: 4, supported_price_decimals: 2, supported_quote_decimals: 6, order_quote_limit: "0",
    is_maker_fee_enabled: true, is_taker_fee_enabled: true,
  };
  const spot = { ...perp, symbol: "ETH/USDC", market_id: 2048, market_type: "spot", base_asset_id: 1, quote_asset_id: 3 };

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
