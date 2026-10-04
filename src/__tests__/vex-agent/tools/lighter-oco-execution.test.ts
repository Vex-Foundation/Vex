import { requireValue } from "../../helpers/require-value.js";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { buildLighterOcoPreview, buildLighterUnsignedOcoRequest } from "@tools/lighter/oco-order.js";
import type { LighterOrderPreview } from "@tools/lighter/order-preview.js";
import type {
  LighterAccountOrder,
  LighterAccountResponse,
  LighterAssetDetail,
  LighterMarketDetail,
  LighterTrade,
} from "@tools/lighter/types.js";
import type { LighterFillRecord } from "@vex-agent/tools/protocols/lighter/agentscan-activity.js";
import {
  resetLighterMarketAssetsCache,
  type LighterFillObservationDeps,
} from "@vex-agent/tools/protocols/lighter/fill-observation.js";
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
    positions: [{
      market_id: 0, symbol: "ETH", sign: 1, position: "1", avg_entry_price: "3000",
      initial_margin_fraction: "5", open_order_count: 0, pending_order_count: 0,
      position_tied_order_count: 0, position_value: "3000", unrealized_pnl: "0",
      realized_pnl: "0", liquidation_price: "2000", margin_mode: 0, allocated_margin: "0",
    }],
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
  expiresAt: new Date(NOW + 3_600_000).toISOString(),
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

function active(index: 0 | 1): LighterAccountOrder {
  return {
    order_index: index + 1, client_order_index: Number(GROUP.orders[index].clientOrderIndex),
    order_id: String(index + 1), client_order_id: GROUP.orders[index].clientOrderIndex,
    market_index: 0, owner_account_index: 42, initial_base_amount: PREVIEW.preview.baseAmount.display,
    remaining_base_amount: PREVIEW.preview.baseAmount.display, filled_base_amount: "0", filled_quote_amount: "0",
    price: (index === 0 ? PREVIEW.stopLoss : PREVIEW.takeProfit).preview.price.display, status: "open",
  };
}

function ocoDeps(): LighterOcoExecutionDeps {
    const sendTx = vi.fn(async () => ({ code: 200, tx_hash: TX_HASH, predicted_execution_time_ms: 1 }));
    const getActive = vi.fn()
      .mockResolvedValueOnce({ code: 200, orders: [] })
      .mockResolvedValueOnce({ code: 200, orders: [active(0), active(1)] });
    return {
      secretReader: { readTradingApiPrivateKey: vi.fn(async () => `0x${"1".repeat(80)}`) },
      authSigner: { source: "official_lighter_signer", createAccountAuth: vi.fn<LighterOcoExecutionDeps["authSigner"]["createAccountAuth"]>(async (input) => ({
        kind: "lighter_account_auth_signer_result", environment: input.environment,
        accountIndex: input.accountIndex, apiKeyIndex: input.apiKeyIndex,
        deadlineUnixSeconds: input.deadlineUnixSeconds,
        authToken: `${input.deadlineUnixSeconds}:42:7:${"a".repeat(128)}`,
        publicKey: PUBLIC_KEY,
      })), signCreateOrder: vi.fn() },
      groupedSigner: { source: "official_lighter_signer", signCreateGroupedOrders: vi.fn<LighterOcoExecutionDeps["groupedSigner"]["signCreateGroupedOrders"]>(async (input) => ({
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
      markSendAttemptStarted: vi.fn(async () => true),
      markExpiredUnsubmitted: vi.fn(async () => true),
      markUnsubmittedRefused: vi.fn(async () => true),
        markPreSubmitRevalidated: vi.fn(async () => ({})),
        attachNonceReservationWith: vi.fn(async () => ({})),
        markSigned: vi.fn(async () => ({})), markSubmitted: vi.fn(async () => ({})),
        markApiAccepted: vi.fn(async () => ({})), markSequencerPending: vi.fn(async () => ({})),
        markProviderOutcome: vi.fn(async () => ({})), markAmbiguous: vi.fn(async () => ({})),
      },
      previews: { findFreshById: vi.fn(async (_session, _environment, id) => id === PREVIEW.stopLoss.previewId ? row(PREVIEW.stopLoss) : row(PREVIEW.takeProfit)) },
      nonceState: {
      releaseUnsubmittedReservation: vi.fn(async () => null),
        recordExecutionObserved: vi.fn(async () => ({})),
        reserveObservedWith: vi.fn(async () => ({ reservationId: `lighter-oco:${PLAN.intentId}`, reservedNonce: "0" })),
      },
      transaction: vi.fn(async (fn) => fn({} as PoolClient)), now: () => NOW, wait: vi.fn(async () => undefined),
    };
}

import {
  createLighterGroupedOrderSignerBinaryAdapter,
  type LighterSignerBinaryRunner,
} from "@tools/lighter/signer-binary-adapter.js";
import {
  signerRunnerEmitting,
  signerRunnerExitingWithoutOutput,
  signerRunnerNeverClosing,
  signerRunnerRejectingWithoutEvidence,
} from "../../helpers/lighter-scripted-signer.js";

describe("approved Lighter native OCO execution", () => {
  it("revalidates both legs, submits exactly once, and proves both children before active", async () => {
    const dependencies = ocoDeps();
    const result = await executeApprovedLighterOco({ plan: PLAN, group: GROUP, deps: dependencies });
    expect(result.status).toBe("active");
    expect(dependencies.client.sendTx).toHaveBeenCalledTimes(1);
    expect(dependencies.client.sendTx).toHaveBeenCalledWith("rhc", expect.objectContaining({ txType: 28 }));
  });
});

describe("OCO authority races", () => {
  for (const kind of ["expiry", "cancellation"] as const) {
    it.each(["reservation", "signing", "staging", "send-admission"] as const)(`${kind} at %s refuses both children`, async (phase) => {
      const d = ocoDeps(), controller = new AbortController();
      let nowMs = NOW, entered!: () => void, finish!: () => void;
      Object.assign(d, { now: () => nowMs });
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      const pause = async () => { entered(); await pending; };
      if (phase === "reservation") {
        const original = requireValue(vi.mocked(d.transaction).getMockImplementation());
        vi.mocked(d.transaction).mockImplementation(async (...args) => { const reserved = await original(...args); await pause(); return reserved; });
      } else if (phase === "signing") {
        const original = requireValue(vi.mocked(d.groupedSigner.signCreateGroupedOrders).getMockImplementation());
        vi.mocked(d.groupedSigner.signCreateGroupedOrders).mockImplementation(async (...args) => { const signed = await original(...args); await pause(); return signed; });
      } else if (phase === "staging") {
        const original = requireValue(vi.mocked(d.intents.markSubmitted).getMockImplementation());
        vi.mocked(d.intents.markSubmitted).mockImplementation(async (...args) => { const row = await original(...args); await pause(); return row; });
      } else {
        vi.mocked(d.intents.markSendAttemptStarted).mockImplementation(async () => { await pause(); return true; });
      }
      const execution = executeApprovedLighterOco({ plan: PLAN, group: GROUP, deps: d, abortSignal: controller.signal });
      const rejected = expect(execution).rejects.toMatchObject({ reason: expect.stringMatching(kind === "expiry" ? /^consent_expired_/ : /^cancelled_/) });
      await reached;
      if (kind === "expiry") nowMs = Date.parse(PLAN.expiresAt); else controller.abort("lock");
      finish(); await rejected;
      expect(d.client.sendTx).not.toHaveBeenCalled();
      expect(d.groupedSigner.signCreateGroupedOrders).toHaveBeenCalledTimes(phase === "reservation" ? 0 : 1);
      if (phase !== "reservation") expect(d.intents.markSigned).toHaveBeenCalledOnce();
      if (phase === "send-admission") expect(d.nonceState.releaseUnsubmittedReservation).not.toHaveBeenCalled();
      else expect(d.nonceState.releaseUnsubmittedReservation).toHaveBeenCalledOnce();
    });
  }
});


/**
 * THE SIGNER SETTLEMENT CONTRACT for grouped orders, proved in composition
 * (round-1 fix F2): the real adapter projects a real child run into the
 * executor, which decides the reservation's fate on that evidence alone.
 */
describe("Lighter OCO signer settlement contract", () => {
  const GROUPED_DOCUMENT = { ok: true, txType: 28, txInfo: "{\"signed\":true}", txHash: TX_HASH };

  function compositionDeps(signRunner: LighterSignerBinaryRunner): LighterOcoExecutionDeps {
    const d = ocoDeps();
    return {
      ...d,
      groupedSigner: createLighterGroupedOrderSignerBinaryAdapter({
        binaryPath: "/tmp/vex-lighter-signer-test",
        // Small enough that a child which never closes is killed inside the test.
        timeoutMs: 5,
        runner: signRunner,
      }),
    };
  }

  it("retires an OCO signed before consent expiry and releases its nonce", async () => {
    let nowMs = NOW;
    const d = compositionDeps(signerRunnerEmitting(() => {
      nowMs = Date.parse(PLAN.expiresAt);
      return GROUPED_DOCUMENT;
    }));
    Object.assign(d, { now: () => nowMs });

    await expect(executeApprovedLighterOco({ plan: PLAN, group: GROUP, deps: d }))
      .rejects.toMatchObject({ reason: expect.stringMatching(/^consent_expired_/) });

    expect(d.intents.markExpiredUnsubmitted).toHaveBeenCalledWith(expect.objectContaining({
      signerTxHash: TX_HASH,
    }));
    expect(d.nonceState.releaseUnsubmittedReservation).toHaveBeenCalledOnce();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("releases the nonce when the signer child provably exited without signing", async () => {
    const d = compositionDeps(signerRunnerExitingWithoutOutput());

    await expect(executeApprovedLighterOco({ plan: PLAN, group: GROUP, deps: d })).rejects.toThrow();

    expect(d.intents.markUnsubmittedRefused).toHaveBeenCalledWith(expect.objectContaining({
      reason: "pre_sign_refused",
    }));
    expect(d.nonceState.releaseUnsubmittedReservation).toHaveBeenCalledOnce();
    expect(d.intents.markAmbiguous).not.toHaveBeenCalled();
  });

  it.each([
    ["a child that never closed", signerRunnerNeverClosing],
    ["a failure that never reached the child", signerRunnerRejectingWithoutEvidence],
  ])("keeps the nonce reserved after %s", async (_name, runner) => {
    const d = compositionDeps(runner());

    await expect(executeApprovedLighterOco({ plan: PLAN, group: GROUP, deps: d })).rejects.toThrow();

    expect(d.intents.markAmbiguous).toHaveBeenCalledOnce();
    expect(d.nonceState.releaseUnsubmittedReservation).not.toHaveBeenCalled();
    expect(d.intents.markUnsubmittedRefused).not.toHaveBeenCalled();
  });
});

/**
 * A TRIGGERED OCO LEG IS A FILL, and until the observation boundary was wired
 * into this executor none of them reached `lighter_fills`: the classification
 * decides the group's state from ORDER rows wherever it can and returns, so a
 * leg confirmed from an inactive order carried its fill away with it. The
 * ledger row belongs to the OCO EXECUTION INTENT that authorized the group.
 */
describe("OCO fills reach the ledger", () => {
  const RHC_COLLATERAL: LighterAssetDetail = {
    asset_id: 3, symbol: "USDG", l1_decimals: 6, decimals: 6, min_transfer_amount: "0",
    l1_address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  };

  function ledger() {
    const rows = new Map<string, LighterFillRecord>();
    const recordFill = vi.fn<LighterFillObservationDeps["recordFill"]>(async (record: LighterFillRecord) => {
      if (rows.has(record.canonicalIdentity)) return { kind: "duplicate" as const, fillId: 1 };
      rows.set(record.canonicalIdentity, record);
      return { kind: "recorded" as const, fillId: rows.size };
    });
    return { rows, recordFill };
  }

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
        getMarketDetails: vi.fn<LighterFillObservationDeps["client"]["getMarketDetails"]>(async () => ({
          code: 200, order_book_details: [MARKET], spot_order_book_details: [],
        })),
        getAssetDetails: vi.fn<LighterFillObservationDeps["client"]["getAssetDetails"]>(async () => ({
          code: 200, asset_details: [RHC_COLLATERAL],
        })),
      },
    };
  }

  /** The account is the ASK on a sell leg, and the child client order id is the only admissible match. */
  function legTrade(index: 0 | 1, overrides: Partial<LighterTrade> = {}): LighterTrade {
    return {
      trade_id: 900 + index, trade_id_str: String(900 + index), tx_hash: TX_HASH, type: "trade",
      market_id: 0, size: "1.0000", price: "2850", usd_amount: "2850.000000",
      ask_id: index + 1, ask_id_str: String(index + 1), bid_id: 77, bid_id_str: "77",
      ask_account_id: 42, bid_account_id: 99, is_maker_ask: false,
      block_height: 5150, timestamp: NOW, transaction_time: NOW * 1000,
      ask_client_id_str: GROUP.orders[index].clientOrderIndex, taker_fee: 350,
      ...overrides,
    };
  }

  function inactive(index: 0 | 1, status: string, filled: string): LighterAccountOrder {
    return { ...active(index), status, filled_base_amount: filled, remaining_base_amount: "0", filled_quote_amount: "2850" };
  }

  it("records the fill of a leg that TRIGGERED from the trade page the classification read", async () => {
    const { rows, recordFill } = ledger();
    const dependencies = ocoDeps();
    Object.assign(dependencies, { fills: fillDeps(recordFill) });
    // The pre-submission preflight must see NO child; the reconciliation after
    // submission sees the triggered leg and its trade.
    let submitted = false;
    Object.assign(dependencies.client, {
      sendTx: vi.fn(async () => {
        submitted = true;
        return { code: 200, tx_hash: TX_HASH, predicted_execution_time_ms: 1 };
      }),
      getAccountActiveOrders: vi.fn(async () => ({ code: 200, orders: [] })),
      getAccountInactiveOrders: vi.fn(async () => ({
        code: 200,
        orders: submitted ? [inactive(0, "filled", "1.0000"), inactive(1, "canceled", "0")] : [],
      })),
      getAccountTrades: vi.fn(async () => ({ code: 200, trades: submitted ? [legTrade(0)] : [] })),
    });

    const result = await executeApprovedLighterOco({ plan: PLAN, group: GROUP, deps: dependencies });

    expect(result.status).toBe("resolved");
    const recorded = rows.get("lighter:rhc:42:0:900");
    expect(recorded).toBeDefined();
    expect(recorded?.executionIntentId).toBe(PLAN.intentId);
    expect(recorded?.clientOrderId).toBe(GROUP.orders[0].clientOrderIndex);
    expect(recorded?.baseSize).toBe("1.0000");
    // The canceled sibling moved no money and must never produce a row.
    expect(rows.size).toBe(1);
  });

  it("reads once for a leg still ACTIVE with a partial fill, and not again once the ledger is level", async () => {
    const { rows, recordFill } = ledger();
    const partial: LighterAccountOrder = {
      ...active(0), filled_base_amount: "0.5000", remaining_base_amount: "0.5000", filled_quote_amount: "1425",
    };
    let submitted = false;
    const getAccountTrades = vi.fn(async () => ({
      code: 200,
      trades: submitted ? [legTrade(0, { size: "0.5000", usd_amount: "1425.000000" })] : [],
    }));
    const dependencies = ocoDeps();
    Object.assign(dependencies, { fills: fillDeps(recordFill) });
    Object.assign(dependencies.client, {
      sendTx: vi.fn(async () => {
        submitted = true;
        return { code: 200, tx_hash: TX_HASH, predicted_execution_time_ms: 1 };
      }),
      getAccountActiveOrders: vi.fn(async () => ({
        code: 200, orders: submitted ? [partial, active(1)] : [],
      })),
      getAccountTrades,
    });

    const result = await executeApprovedLighterOco({ plan: PLAN, group: GROUP, deps: dependencies });

    // The group is still protecting the position; the partial fill is real money and is recorded.
    expect(result.status).toBe("active");
    // Two reads in total: the pre-submission preflight, and ONE bounded
    // follow-up behind the partial fill.
    expect(getAccountTrades).toHaveBeenCalledTimes(2);
    expect(rows.get("lighter:rhc:42:0:900")?.baseSize).toBe("0.5000");

    // A second execution over the same evidence, with the ledger now level
    // with what the order row reports, spends no provider request at all.
    let resubmitted = false;
    const levelTrades = vi.fn(async () => ({ code: 200, trades: [] }));
    const again = ocoDeps();
    Object.assign(again, {
      fills: fillDeps(
        recordFill,
        vi.fn<LighterFillObservationDeps["recordedFillBaseSize"]>(async () => "0.5000"),
      ),
    });
    Object.assign(again.client, {
      sendTx: vi.fn(async () => {
        resubmitted = true;
        return { code: 200, tx_hash: TX_HASH, predicted_execution_time_ms: 1 };
      }),
      getAccountActiveOrders: vi.fn(async () => ({
        code: 200, orders: resubmitted ? [partial, active(1)] : [],
      })),
      getAccountTrades: levelTrades,
    });

    await executeApprovedLighterOco({ plan: PLAN, group: GROUP, deps: again });

    // The preflight read stands; the follow-up is not made at all.
    expect(levelTrades).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// LIGHTER_LIFECYCLE_PARALLEL_READS for OCO: the credential read runs beside
// revalidation. OFF is today's order; ON must refuse, write, sign and send
// exactly what OFF does.
// ---------------------------------------------------------------------------

import { ErrorCodes, VexError } from "../../../errors.js";
import logger from "@utils/logger.js";
import { LighterIntentRefusal } from "@vex-agent/tools/protocols/lighter/intent-expiry.js";

const OCO_OFFLINE = (message: string) => new VexError(ErrorCodes.LIGHTER_TIMEOUT, message);

function ocoRejectNow(error: unknown): () => Promise<never> {
  return async () => { throw error; };
}

function ocoRejectAfter(error: unknown, delayMs: number): () => Promise<never> {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    throw error;
  };
}

function ocoDepsWith(change: (d: LighterOcoExecutionDeps) => void): () => LighterOcoExecutionDeps {
  return () => {
    const d = ocoDeps();
    change(d);
    return d;
  };
}

const OCO_CASES: readonly {
  readonly label: string;
  readonly build: () => LighterOcoExecutionDeps;
  /** The OFF outcome, so each case provably exercises what it names. */
  readonly expected: RegExp;
}[] = [
  { label: "the group is submitted", build: ocoDeps, expected: /"status":"active"/ },
  {
    label: "a child preview is no longer fresh", expected: /no longer fresh/,
    build: ocoDepsWith((d) => { Object.assign(d.previews, { findFreshById: vi.fn(async () => null) }); }),
  },
  {
    label: "the market read fails", expected: /evidence is unavailable for OCO revalidation/,
    build: ocoDepsWith((d) => { Object.assign(d.client, { getMarketDetails: vi.fn(ocoRejectNow(new Error("market down"))) }); }),
  },
  {
    label: "Lighter is unreachable during revalidation", expected: /couldn't reach Lighter before sending/,
    build: ocoDepsWith((d) => { Object.assign(d.client, { getOrderBookOrders: vi.fn(ocoRejectNow(OCO_OFFLINE("book timed out"))) }); }),
  },
  {
    label: "revalidation evidence cannot persist", expected: /could not be persisted/,
    build: ocoDepsWith((d) => { Object.assign(d.intents, { markPreSubmitRevalidated: vi.fn(async () => null) }); }),
  },
  {
    label: "the next nonce is unavailable", expected: /API-key identity or next nonce is unavailable/,
    build: ocoDepsWith((d) => { Object.assign(d.client, { getNextNonce: vi.fn(ocoRejectNow(new Error("nonce down"))) }); }),
  },
  {
    label: "the key is not registered", expected: /exact registered Lighter API key is unavailable/,
    build: ocoDepsWith((d) => { Object.assign(d.client, { getApiKeys: vi.fn(async () => ({ code: 200, api_keys: [] })) }); }),
  },
  {
    label: "Lighter is unreachable during the credential read", expected: /couldn't reach Lighter before sending/,
    build: ocoDepsWith((d) => { Object.assign(d.client, { getApiKeys: vi.fn(ocoRejectNow(OCO_OFFLINE("keys timed out"))) }); }),
  },
  {
    label: "both fail, the credential first: the revalidation refusal wins", expected: /evidence is unavailable for OCO revalidation/,
    build: ocoDepsWith((d) => {
      Object.assign(d.client, {
        getMarketDetails: vi.fn(ocoRejectAfter(new Error("market down"), 5)),
        getNextNonce: vi.fn(ocoRejectNow(new Error("nonce down"))),
      });
    }),
  },
  {
    label: "both fail: an unreachable revalidation wins over a credential refusal", expected: /market timed out/,
    build: ocoDepsWith((d) => {
      Object.assign(d.client, {
        getMarketDetails: vi.fn(ocoRejectAfter(OCO_OFFLINE("market timed out"), 5)),
        getApiKeys: vi.fn(async () => ({ code: 200, api_keys: [] })),
      });
    }),
  },
  {
    label: "both fail: a revalidation refusal wins over an unreachable credential read", expected: /could not be persisted/,
    build: ocoDepsWith((d) => {
      Object.assign(d.intents, { markPreSubmitRevalidated: vi.fn(async () => null) });
      Object.assign(d.client, { getNextNonce: vi.fn(ocoRejectNow(OCO_OFFLINE("nonce timed out"))) });
    }),
  },
  {
    label: "the local key does not match the registered key", expected: /does not match the registered account key/,
    build: ocoDepsWith((d) => {
      Object.assign(d.client, { getApiKeys: vi.fn(async () => ({
        code: 200, api_keys: [{ account_index: 42, api_key_index: 7, nonce: 0, public_key: "c".repeat(80), transaction_time: 1 }],
      })) });
    }),
  },
  {
    label: "a child client order id already exists", expected: /already exists before OCO submission/,
    build: ocoDepsWith((d) => {
      Object.assign(d.client, { getAccountInactiveOrders: vi.fn(async () => ({ code: 200, orders: [{ ...active(0), status: "canceled" }] })) });
    }),
  },
  {
    label: "an earlier action still holds the nonce", expected: /Vex clears the blocking reservation automatically/,
    build: ocoDepsWith((d) => {
      Object.assign(d.nonceState, { recordExecutionObserved: vi.fn(async () => null) });
      Object.assign(d, { recoverNonce: vi.fn(async () => ({})) });
    }),
  },
  {
    label: "the send is ambiguous", expected: /"status":"ambiguous"/,
    build: ocoDepsWith((d) => { Object.assign(d.client, { sendTx: vi.fn(ocoRejectNow(new Error("socket hang up"))) }); }),
  },
];

function describeOcoFailure(error: unknown): Record<string, unknown> {
  if (error instanceof VexError) {
    return {
      name: error.name, code: error.code, message: error.message, hint: error.hint, retryable: error.retryable,
      ...(error instanceof LighterIntentRefusal ? { reason: error.reason } : {}),
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

async function observeOco(built: LighterOcoExecutionDeps, lifecycleParallelReads: boolean | "constant") {
  const { lifecycleParallelReads: _pinned, ...unpinned } = built;
  const d: LighterOcoExecutionDeps = lifecycleParallelReads === "constant" ? unpinned : { ...unpinned, lifecycleParallelReads };
  let outcome: Record<string, unknown>;
  try {
    outcome = { resolved: await executeApprovedLighterOco({ plan: PLAN, group: GROUP, deps: d }) };
  } catch (error) {
    outcome = { rejected: describeOcoFailure(error) };
  }
  return {
    outcome,
    effects: {
      findFreshById: vi.mocked(d.previews.findFreshById).mock.calls,
      markPreSubmitRevalidated: vi.mocked(d.intents.markPreSubmitRevalidated).mock.calls,
      readTradingApiPrivateKey: vi.mocked(d.secretReader.readTradingApiPrivateKey).mock.calls,
      createAccountAuth: vi.mocked(d.authSigner.createAccountAuth).mock.calls.length,
      accountActiveOrders: vi.mocked(d.client.getAccountActiveOrders).mock.calls,
      accountInactiveOrders: vi.mocked(d.client.getAccountInactiveOrders).mock.calls,
      accountTrades: vi.mocked(d.client.getAccountTrades).mock.calls,
      recordExecutionObserved: vi.mocked(d.nonceState.recordExecutionObserved).mock.calls,
      reserveObservedWith: vi.mocked(d.nonceState.reserveObservedWith).mock.calls.map((call) => call[1]),
      attachNonceReservationWith: vi.mocked(d.intents.attachNonceReservationWith).mock.calls.map((call) => call[1]),
      signCreateGroupedOrders: vi.mocked(d.groupedSigner.signCreateGroupedOrders).mock.calls,
      markSigned: vi.mocked(d.intents.markSigned).mock.calls,
      markSubmitted: vi.mocked(d.intents.markSubmitted).mock.calls,
      markSendAttemptStarted: vi.mocked(d.intents.markSendAttemptStarted).mock.calls,
      sendTx: vi.mocked(d.client.sendTx).mock.calls,
      markApiAccepted: vi.mocked(d.intents.markApiAccepted).mock.calls,
      markSequencerPending: vi.mocked(d.intents.markSequencerPending).mock.calls,
      markProviderOutcome: vi.mocked(d.intents.markProviderOutcome).mock.calls,
      markAmbiguous: vi.mocked(d.intents.markAmbiguous).mock.calls,
      markUnsubmittedRefused: vi.mocked(d.intents.markUnsubmittedRefused).mock.calls,
      markExpiredUnsubmitted: vi.mocked(d.intents.markExpiredUnsubmitted).mock.calls,
      releaseUnsubmittedReservation: vi.mocked(d.nonceState.releaseUnsubmittedReservation).mock.calls,
    },
  };
}

describe("LIGHTER_LIFECYCLE_PARALLEL_READS for OCO", () => {
  it.each(OCO_CASES)("refuses, writes, signs and sends exactly what OFF does when $label", async ({ build, expected }) => {
    const off = await observeOco(build(), false);
    const absent = await observeOco(build(), "constant");
    const on = await observeOco(build(), true);

    expect(JSON.stringify(off.outcome)).toMatch(expected);
    expect(absent).toEqual(off);
    expect(on).toEqual(off);
  });

  it("overlaps the credential read with revalidation and loads the key only after both", async () => {
    const info = vi.spyOn(logger, "info");
    let releaseRevalidation: () => void = () => undefined;
    let releaseCredential: () => void = () => undefined;
    const revalidationGate = new Promise<void>((resolve) => { releaseRevalidation = resolve; });
    const credentialGate = new Promise<void>((resolve) => { releaseCredential = resolve; });
    const d = ocoDeps();
    Object.assign(d.intents, { markPreSubmitRevalidated: vi.fn(async () => { await revalidationGate; return {}; }) });
    Object.assign(d.client, { getNextNonce: vi.fn(async () => { await credentialGate; return { code: 200, nonce: 0 }; }) });

    const execution = executeApprovedLighterOco({ plan: PLAN, group: GROUP, deps: { ...d, lifecycleParallelReads: true } });

    await vi.waitFor(() => {
      expect(d.intents.markPreSubmitRevalidated).toHaveBeenCalledTimes(1);
      expect(d.client.getNextNonce).toHaveBeenCalledTimes(1);
    });
    releaseCredential();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.authSigner.createAccountAuth).not.toHaveBeenCalled();

    releaseRevalidation();
    await expect(execution).resolves.toMatchObject({ status: "active" });
    expect(d.secretReader.readTradingApiPrivateKey).toHaveBeenCalledTimes(1);
    const line = info.mock.calls.map((call) => Array.from<unknown>(call)).find((args) => args[0] === "[lighter-lifecycle-timing]")?.[1];
    expect(line).toMatchObject({ action: "oco", intentId: PLAN.intentId, parallelReads: 1, apiAccepted: 1 });
    expect(Object.keys(requireValue(line))).toEqual(expect.arrayContaining([
      "readsMs", "revalidationMs", "credentialMs", "secretMs", "authMs", "childCheckMs", "nonceReserveMs", "signMs", "sendMs", "totalMs",
    ]));
    info.mockRestore();
  });

  it("OFF reads the credential only after revalidation", async () => {
    let releaseRevalidation: () => void = () => undefined;
    const revalidationGate = new Promise<void>((resolve) => { releaseRevalidation = resolve; });
    const d = ocoDeps();
    Object.assign(d.intents, { markPreSubmitRevalidated: vi.fn(async () => { await revalidationGate; return {}; }) });

    const execution = executeApprovedLighterOco({ plan: PLAN, group: GROUP, deps: { ...d, lifecycleParallelReads: false } });

    await vi.waitFor(() => expect(d.intents.markPreSubmitRevalidated).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(d.client.getNextNonce).not.toHaveBeenCalled();
    expect(d.client.getApiKeys).not.toHaveBeenCalled();
    releaseRevalidation();
    await expect(execution).resolves.toMatchObject({ status: "active" });
  });

  it("never loads the key when revalidation fails after the credential read succeeded", async () => {
    const d = ocoDeps();
    Object.assign(d.client, { getMarketDetails: vi.fn(ocoRejectAfter(new Error("market down"), 5)) });

    await expect(executeApprovedLighterOco({ plan: PLAN, group: GROUP, deps: { ...d, lifecycleParallelReads: true } }))
      .rejects.toThrow("evidence is unavailable for OCO revalidation");
    expect(d.client.getNextNonce).toHaveBeenCalledTimes(1);
    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.nonceState.recordExecutionObserved).not.toHaveBeenCalled();
    expect(d.nonceState.reserveObservedWith).not.toHaveBeenCalled();
  });
});
