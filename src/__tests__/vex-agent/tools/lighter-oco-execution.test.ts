import { requireValue } from "../../helpers/require-value.js";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { buildLighterOcoPreview, buildLighterUnsignedOcoRequest } from "@tools/lighter/oco-order.js";
import type { LighterOrderPreview } from "@tools/lighter/order-preview.js";
import type { LighterAccountOrder, LighterAccountResponse, LighterMarketDetail } from "@tools/lighter/types.js";
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
