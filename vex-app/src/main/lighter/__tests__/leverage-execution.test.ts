/**
 * The user's leverage change, end to end through the real executor.
 *
 * The harness fakes exactly three boundaries: the provider client, the durable
 * repo transitions, and the signer. Everything else is the production module,
 * so the invariants below are proved on the code that ships:
 * persist-hash-before-send, one submission, ambiguous-never-failed,
 * reconciliation-only recovery, and a release only on proven non-submission.
 *
 * Deliberate absence assertions throughout: `sign` and `sendTx` call COUNTS are
 * the whole point of a money path, and "did not happen" is the assertion that
 * catches a regression a status check would miss.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LighterLeverageIntentRow } from "@vex-agent/db/repos/lighter-leverage-intents.js";
import type { LighterNonceStateRow } from "@vex-agent/db/repos/lighter-nonce-state.js";
import type { LighterUpdateLeverageSignerResult } from "@tools/lighter/signer-leverage.js";
import type {
  LighterAccount,
  LighterAccountResponse,
  LighterMarketDetail,
  LighterTxFromL1Response,
} from "@tools/lighter/types.js";
import {
  confirmLighterLeverage,
  installLighterLeverageService,
  proveLighterUpdateLeverageTransaction,
  reconcileLighterLeverage,
  type LighterLeverageExecutionDeps,
} from "../leverage-execution.js";
import type { LighterLeverageAccountSetup } from "../leverage-preparation.js";
import {
  activeCriticalOps,
  CRITICAL_OP,
  trackCriticalOp,
  __resetCriticalOpsForTests,
} from "../../updates/critical-ops.js";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const HASH = "cd".repeat(20);
const KEY = "ab".repeat(20);
const WALLET = `0x${"1".repeat(40)}`;
const INTENT_ID = "lighter-leverage-00000000-0000-4000-8000-000000000001";
const TX_EXPIRY = NOW + 240_000;

const market: LighterMarketDetail = {
  symbol: "BTC",
  market_id: 1,
  market_type: "perp",
  base_asset_id: 0,
  quote_asset_id: 1,
  status: "active",
  taker_fee: "0",
  maker_fee: "0",
  liquidation_fee: "0",
  min_base_amount: "0.0002",
  min_quote_amount: "10",
  supported_size_decimals: 5,
  supported_price_decimals: 1,
  supported_quote_decimals: 6,
  order_quote_limit: "0",
  is_maker_fee_enabled: true,
  is_taker_fee_enabled: true,
  default_initial_margin_fraction: 5000,
  min_initial_margin_fraction: 200,
};

function baseIntent(
  overrides: Partial<LighterLeverageIntentRow> = {},
): LighterLeverageIntentRow {
  return {
    intentId: INTENT_ID,
    environment: "rhc",
    walletAddress: WALLET.toLowerCase(),
    accountIndex: 24226,
    apiKeyIndex: 4,
    marketIndex: 1,
    requestedInitialMarginFraction: 400,
    requestedMarginMode: 0,
    observedBefore: {
      symbol: "BTC",
      currentInitialMarginFraction: 5000,
      currentMarginMode: 0,
      currentSource: "market_default",
      marketMinInitialMarginFraction: 200,
      openPositionSize: "0",
      openPositionSide: "none",
      publicKey: KEY,
      liquidationPrice: null,
      openOrderCount: 0,
    },
    executionState: "proposed",
    consentedAt: null,
    revalidation: null,
    nonceValue: null,
    txExpiryMs: null,
    signerTxHash: null,
    sendAttemptStartedAt: null,
    providerOutcome: null,
    failureReason: null,
    expiresAt: new Date(NOW + 120_000),
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

function accountResponse(fraction: number | null): LighterAccountResponse {
  return {
    code: 200,
    accounts: [
      {
        account_index: 24226,
        l1_address: WALLET,
        positions:
          fraction === null
            ? []
            : [
                {
                  market_id: 1,
                  symbol: "BTC",
                  initial_margin_fraction: (fraction / 100).toFixed(2),
                  open_order_count: 0,
                  pending_order_count: 0,
                  position_tied_order_count: 0,
                  sign: 1,
                  position: "0.0000",
                  avg_entry_price: "0",
                  position_value: "0",
                  unrealized_pnl: "0",
                  realized_pnl: "0",
                  liquidation_price: "0",
                  margin_mode: 0,
                  allocated_margin: "0",
                },
              ],
      },
    ],
  };
}

/**
 * The wallet's account row out of the fixture response. A fixture that lost its
 * account row must say so: a test built on a missing row would assert against
 * whatever `undefined` happens to do downstream.
 */
function accountRow(fraction: number | null): LighterAccount {
  const [account] = accountResponse(fraction).accounts;
  if (!account) {
    throw new Error("the account fixture must carry exactly the wallet's account row");
  }
  return account;
}

/** A durable nonce-state row as the repo returns it after an observation. */
function nonceStateRow(): LighterNonceStateRow {
  return {
    environment: "rhc",
    accountIndex: 24226,
    apiKeyIndex: 4,
    providerNonce: "7",
    publicKey: KEY,
    providerTransactionTime: null,
    status: "observed",
    reservedNonce: null,
    reservationId: null,
    source: "next_nonce",
    observedAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
}

function setup(
  options: {
    readonly intent?: Partial<LighterLeverageIntentRow>;
    readonly now?: number;
    readonly nextNonce?: number;
    readonly livePositionFraction?: number | null;
  } = {},
) {
  let current = baseIntent(options.intent);
  const events: string[] = [];
  const record = <T>(name: string, value: T): T => {
    events.push(name);
    return value;
  };
  const patch = (next: Partial<LighterLeverageIntentRow>): LighterLeverageIntentRow => {
    current = { ...current, ...next };
    return current;
  };
  /**
   * THE FAKES ENFORCE THE REAL GUARDS. Every repo transition is a guarded
   * `UPDATE` that returns `null` when the row does not satisfy its expected
   * states and row-level predicates, and migration 160's CHECKs make several of
   * those predicates mandatory rather than defensive. A fake that always
   * succeeded would prove the executor handles the happy path only, which is
   * exactly how a `submission_staged` row came back reported as `completed`.
   */
  const guarded = <T>(
    name: string,
    allowed: readonly LighterLeverageIntentRow["executionState"][],
    predicate: (row: LighterLeverageIntentRow) => boolean,
    apply: () => T,
  ): T | null => {
    if (!allowed.includes(current.executionState) || !predicate(current)) return null;
    return record(name, apply());
  };
  const POST_RESERVATION = [
    "signing",
    "signed",
    "submission_staged",
    "submitted",
    "ambiguous",
  ] as const;

  const setupResult: LighterLeverageAccountSetup = {
    environment: "rhc",
    walletAddress: WALLET.toLowerCase(),
    accountIndex: 24226,
    apiKeyIndex: 4,
    publicKey: KEY,
    account: accountRow(options.livePositionFraction ?? null),
  };

  const client: LighterLeverageExecutionDeps["client"] = {
    getNextNonce: vi.fn(async () => ({ code: 200, nonce: options.nextNonce ?? 7 })),
    sendTx: vi.fn(async () =>
      record("send", { code: 200, tx_hash: HASH, predicted_execution_time_ms: 0 }),
    ),
    getTx: vi.fn(async (): Promise<LighterTxFromL1Response> => {
      throw new Error("not visible yet");
    }),
    getAccount: vi.fn(async () => accountResponse(400)),
  };

  const deps: LighterLeverageExecutionDeps = {
    client,
    preparation: {} as LighterLeverageExecutionDeps["preparation"],
    readIntent: vi.fn(async () => current),
    readSetup: vi.fn(async () => setupResult),
    readMarket: vi.fn(async () => market),
    markExpired: vi.fn(async () =>
      guarded("expired", ["proposed"], (row) => row.consentedAt === null, () =>
        patch({ executionState: "expired" }),
      ),
    ),
    markRefused: vi.fn(async ({ failureReason }) =>
      guarded(
        "refused",
        ["proposed", "signing", "signed", "submission_staged"],
        (row) => row.signerTxHash === null && row.sendAttemptStartedAt === null,
        () =>
          patch({
            executionState: "refused_unsubmitted",
            // Consent is recorded even here: the person pressed Confirm and the
            // refusal came after, which is what the table's CHECK demands.
            consentedAt: current.consentedAt ?? new Date(NOW),
            failureReason,
          }),
      ),
    ),
    markSigned: vi.fn(async ({ signerTxHash }) =>
      guarded("signed", ["signing"], () => true, () =>
        patch({ executionState: "signed", signerTxHash }),
      ),
    ),
    markSubmissionStaged: vi.fn(async () =>
      guarded("staged", ["signed"], () => true, () =>
        patch({ executionState: "submission_staged" }),
      ),
    ),
    admitSend: vi.fn(async ({ signerTxHash }) => {
      // The latch's own predicates, including the CONSENT EXPIRY the SQL
      // carries: admission is the last gate before bytes leave.
      const row = current;
      if (
        row.executionState !== "submission_staged"
        || row.signerTxHash !== signerTxHash
        || row.sendAttemptStartedAt !== null
        || row.expiresAt.getTime() <= (options.now ?? NOW)
      ) {
        return false;
      }
      record("admit", patch({ sendAttemptStartedAt: new Date(NOW) }));
      return true;
    }),
    markSubmitted: vi.fn(async () =>
      guarded("submitted", ["submission_staged"], () => true, () =>
        patch({ executionState: "submitted" }),
      ),
    ),
    markCompleted: vi.fn(async () =>
      guarded("completed", POST_RESERVATION, (row) => row.signerTxHash !== null, () =>
        patch({ executionState: "completed" }),
      ),
    ),
    markAmbiguous: vi.fn(async ({ failureReason }) =>
      guarded("ambiguous", POST_RESERVATION, (row) => row.signerTxHash !== null, () =>
        patch({ executionState: "ambiguous", failureReason }),
      ),
    ),
    markRejected: vi.fn(async ({ failureReason }) =>
      guarded("rejected", POST_RESERVATION, (row) => row.signerTxHash !== null, () =>
        patch({ executionState: "rejected", failureReason }),
      ),
    ),
    markExpiredUnsubmitted: vi.fn(async ({ failureReason }) =>
      guarded(
        "expired_unsubmitted",
        ["signing", "signed", "submission_staged"],
        (row) => row.signerTxHash !== null && row.sendAttemptStartedAt === null,
        () => patch({ executionState: "expired_unsubmitted", failureReason }),
      ),
    ),
    // The production reservation records CONSENT, the revalidation, the nonce
    // and the wire expiry in one statement; the fake moves the same fields, so
    // a test can assert that consent never lands before this point.
    reserveSigning: vi.fn(async (_intent, expiry, revalidation) =>
      record(
        "reserve",
        patch({
          executionState: "signing",
          consentedAt: new Date(NOW),
          revalidation,
          nonceValue: "7",
          txExpiryMs: expiry,
        }),
      ),
    ),
    recordNonce: vi.fn(async () => nonceStateRow()),
    releaseNonce: vi.fn(async () => null),
    releaseUnsubmittedNonce: vi.fn(async () => null),
    sign: vi.fn(async () => {
      events.push("sign");
      // The critical op must be held for the whole signing window, which is
      // exactly where an updater restart would do the damage.
      events.push(`critical:${activeCriticalOps().includes("lighter_leverage_change")}`);
      return {
        kind: "lighter_update_leverage_signer_result",
        operation: "update_leverage",
        environment: "rhc",
        accountIndex: 24226,
        apiKeyIndex: 4,
        nonce: "7",
        expiredAt: String(current.txExpiryMs),
        txType: 20,
        txInfo: "{}",
        txHash: HASH,
      } satisfies LighterUpdateLeverageSignerResult;
    }),
    // The REAL wrapper, so the critical-op hold is proved on shipping code.
    track: (fn) => trackCriticalOp(CRITICAL_OP.lighterLeverageChange, fn)(),
    failedTxStatuses: [],
    now: vi.fn(() => options.now ?? NOW),
    sleep: vi.fn(async () => {}),
    attempts: 1,
  };
  return { deps, events, current: () => current, patch };
}

function executedTx(
  overrides: Partial<LighterTxFromL1Response> = {},
): LighterTxFromL1Response {
  return {
    code: 200,
    hash: HASH,
    type: 20,
    account_index: 24226,
    api_key_index: 4,
    nonce: 7,
    expire_at: TX_EXPIRY,
    status: 3,
    info: JSON.stringify({
      AccountIndex: 24226,
      ApiKeyIndex: 4,
      MarketIndex: 1,
      InitialMarginFraction: 400,
      MarginMode: 0,
      Nonce: 7,
      ExpiredAt: TX_EXPIRY,
    }),
    event_info: "",
    transaction_index: 0,
    l1_address: WALLET,
    block_height: 1,
    queued_at: 0,
    executed_at: 0,
    sequence_index: 0,
    parent_hash: "",
    transaction_time: 0,
    committed_at: 0,
    verified_at: 0,
    ...overrides,
  };
}

beforeEach(() => {
  __resetCriticalOpsForTests();
  installLighterLeverageService();
});

describe("confirmLighterLeverage", () => {
  it("reserves durably, signs once, stages, sends once and completes on proof", async () => {
    const h = setup();
    vi.mocked(h.deps.client.getTx).mockResolvedValue(executedTx());
    const result = await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);

    expect(result).toMatchObject({ status: "completed", intentId: INTENT_ID });
    expect(h.events).toEqual([
      "reserve",
      "sign",
      "critical:true",
      "signed",
      "staged",
      "admit",
      "send",
      "submitted",
      "completed",
    ]);
    expect(h.deps.sign).toHaveBeenCalledTimes(1);
    expect(h.deps.client.sendTx).toHaveBeenCalledTimes(1);
    expect(activeCriticalOps()).toEqual([]);
  });

  it("reports the live account as the observation, not as the proof", async () => {
    const h = setup();
    vi.mocked(h.deps.client.getTx).mockResolvedValue(executedTx());
    // Superseded after success: Lighter now says 20x, the proof still stands.
    vi.mocked(h.deps.client.getAccount).mockResolvedValue(accountResponse(500));

    const result = await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);

    expect(result).toEqual({
      status: "completed",
      intentId: INTENT_ID,
      observed: {
        initialMarginFraction: 500,
        leverageDisplay: "20.00",
        marginMode: "cross",
        source: "position_row",
      },
    });
    expect(h.current().executionState).toBe("completed");
  });

  it("persists the signed hash BEFORE any send is attempted", async () => {
    const h = setup();
    vi.mocked(h.deps.admitSend).mockImplementation(async () => {
      // At the moment send admission is decided, the hash is already durable.
      expect(h.current().signerTxHash).toBe(HASH);
      return true;
    });
    await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);
    expect(h.deps.markSigned).toHaveBeenCalledBefore(vi.mocked(h.deps.admitSend));
  });

  it("keeps the hash and never sends when consent expires during signing", async () => {
    const h = setup();
    let now = NOW;
    vi.mocked(h.deps.now).mockImplementation(() => now);
    vi.mocked(h.deps.sign).mockImplementation(async () => {
      now = NOW + 130_000; // past the consent window
      return {
        kind: "lighter_update_leverage_signer_result",
        operation: "update_leverage",
        environment: "rhc",
        accountIndex: 24226,
        apiKeyIndex: 4,
        nonce: "7",
        expiredAt: String(TX_EXPIRY),
        txType: 20,
        txInfo: "{}",
        txHash: HASH,
      } satisfies LighterUpdateLeverageSignerResult;
    });

    const result = await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);

    expect(result.status).toBe("refused");
    expect(h.current()).toMatchObject({
      signerTxHash: HASH,
      executionState: "expired_unsubmitted",
    });
    expect(h.deps.client.sendTx).not.toHaveBeenCalled();
    expect(h.deps.releaseUnsubmittedNonce).toHaveBeenCalledOnce();
  });

  it("does not send when the caller aborts after signing, and releases the nonce", async () => {
    const h = setup();
    const abort = new AbortController();
    vi.mocked(h.deps.sign).mockImplementation(async () => {
      abort.abort();
      return {
        kind: "lighter_update_leverage_signer_result",
        operation: "update_leverage",
        environment: "rhc",
        accountIndex: 24226,
        apiKeyIndex: 4,
        nonce: "7",
        expiredAt: String(TX_EXPIRY),
        txType: 20,
        txInfo: "{}",
        txHash: HASH,
      } satisfies LighterUpdateLeverageSignerResult;
    });

    const result = await confirmLighterLeverage(
      { proposalId: INTENT_ID },
      abort.signal,
      h.deps,
    );

    expect(result.status).toBe("refused");
    expect(h.deps.client.sendTx).not.toHaveBeenCalled();
    expect(h.deps.releaseUnsubmittedNonce).toHaveBeenCalledOnce();
    expect(h.current().executionState).toBe("expired_unsubmitted");
  });

  it("treats a hash mismatch in the send response as ambiguous, never failed", async () => {
    const h = setup();
    vi.mocked(h.deps.client.sendTx).mockResolvedValue({
      code: 200,
      tx_hash: "ff".repeat(20),
      predicted_execution_time_ms: 0,
    });

    const result = await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);

    expect(result.status).toBe("ambiguous");
    expect(h.current().failureReason).toBe("submission_response_unconfirmed");
    expect(h.deps.client.sendTx).toHaveBeenCalledTimes(1);
    expect(h.deps.releaseUnsubmittedNonce).not.toHaveBeenCalled();
    expect(h.deps.releaseNonce).not.toHaveBeenCalled();
  });

  it("treats a transport failure as ambiguous and never sends a second time", async () => {
    const h = setup();
    vi.mocked(h.deps.client.sendTx).mockRejectedValue(new Error("timeout"));

    const first = await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);
    const second = await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);

    expect(first.status).toBe("ambiguous");
    expect(second.status).toBe("ambiguous");
    expect(h.deps.sign).toHaveBeenCalledTimes(1);
    expect(h.deps.client.sendTx).toHaveBeenCalledTimes(1);
  });

  it("records consent with the reservation, in the same transaction", async () => {
    // Migration 156 refuses a `proposed` row that carries consent, so the
    // consent, the revalidation, the nonce and the wire expiry move together.
    // A separate consent write is the transition that failed every ordinary
    // confirmation against real PostgreSQL.
    const h = setup();
    vi.mocked(h.deps.client.getTx).mockResolvedValue(executedTx());
    vi.mocked(h.deps.reserveSigning).mockImplementation(async (intent) => {
      expect(intent.consentedAt).toBeNull();
      expect(intent.executionState).toBe("proposed");
      return h.patch({
        executionState: "signing",
        consentedAt: new Date(NOW),
        nonceValue: "7",
        txExpiryMs: TX_EXPIRY,
      });
    });

    await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);

    expect(h.deps.reserveSigning).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: INTENT_ID }),
      NOW + 4 * 60_000,
      expect.objectContaining({ symbol: "BTC", currentInitialMarginFraction: 5000 }),
    );
  });

  it("does not submit when the consent window closes while send admission is in flight", async () => {
    const h = setup();
    let now = NOW;
    vi.mocked(h.deps.now).mockImplementation(() => now);
    vi.mocked(h.deps.admitSend).mockImplementation(async () => {
      // The latch round trip is where consent can lapse: the caller's last
      // clock read happened before it.
      now = NOW + 130_000;
      h.patch({ sendAttemptStartedAt: new Date(now) });
      return true;
    });

    const result = await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);

    expect(h.deps.client.sendTx).not.toHaveBeenCalled();
    expect(result.status).toBe("ambiguous");
  });

  it("does not submit when the caller aborts while send admission is in flight", async () => {
    const h = setup();
    const abort = new AbortController();
    vi.mocked(h.deps.admitSend).mockImplementation(async () => {
      abort.abort();
      h.patch({ sendAttemptStartedAt: new Date(NOW) });
      return true;
    });

    const result = await confirmLighterLeverage({ proposalId: INTENT_ID }, abort.signal, h.deps);

    expect(h.deps.client.sendTx).not.toHaveBeenCalled();
    expect(result.status).toBe("ambiguous");
  });

  it("does not submit when the send-admission latch refuses", async () => {
    const h = setup();
    vi.mocked(h.deps.admitSend).mockResolvedValue(false);

    const result = await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);

    expect(h.deps.client.sendTx).not.toHaveBeenCalled();
    expect(result.status).toBe("refused");
    expect(h.current().executionState).toBe("expired_unsubmitted");
    expect(h.deps.releaseUnsubmittedNonce).toHaveBeenCalledOnce();
  });

  it("closes an interrupted signing that produced no hash as refused, never as ambiguous", async () => {
    // `ambiguous` claims a transaction with a known hash may exist. With no
    // hash there is nothing to reconcile against, and the row would sit
    // unresolved holding a nonce the table would refuse to let it claim.
    const h = setup();
    // The signer child is PROVEN quiescent, which is what makes "nothing was
    // signed" a fact rather than a guess.
    vi.mocked(h.deps.sign).mockRejectedValue(
      Object.assign(new Error("signer failed"), { lighterSignerChildState: "exited" }),
    );

    const result = await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);

    expect(result.status).toBe("refused");
    expect(h.current()).toMatchObject({
      executionState: "refused_unsubmitted",
      signerTxHash: null,
    });
    expect(h.deps.markAmbiguous).not.toHaveBeenCalled();
    expect(h.deps.client.sendTx).not.toHaveBeenCalled();
    expect(h.deps.releaseUnsubmittedNonce).toHaveBeenCalledOnce();
  });

  it("reports an unresolved outcome when the signed hash could not be persisted", async () => {
    // With no durable hash, `ambiguous` is a claim the row cannot carry either,
    // so the honest answer is "not resolved", never a state that never landed.
    const h = setup();
    vi.mocked(h.deps.markSigned).mockResolvedValue(null);

    const result = await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);

    expect(result.status).toBe("ambiguous");
    expect(h.current().executionState).toBe("signing");
    expect(h.deps.client.sendTx).not.toHaveBeenCalled();
  });

  it("refuses when the leverage the user saw drifted, before anything is reserved", async () => {
    const h = setup({ livePositionFraction: 1000 });

    const result = await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);

    expect(result.status).toBe("refused");
    expect(result).toMatchObject({ reason: expect.stringContaining("changed after you confirmed") });
    expect(h.deps.reserveSigning).not.toHaveBeenCalled();
    expect(h.deps.sign).not.toHaveBeenCalled();
    expect(h.current().executionState).toBe("refused_unsubmitted");
  });

  it("refuses when the registered trading key is no longer the bound key", async () => {
    const h = setup();
    vi.mocked(h.deps.readSetup).mockResolvedValue({
      environment: "rhc",
      walletAddress: WALLET.toLowerCase(),
      accountIndex: 24226,
      apiKeyIndex: 4,
      publicKey: "99".repeat(20),
      account: accountRow(null),
    });

    const result = await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);

    expect(result.status).toBe("refused");
    expect(h.deps.sign).not.toHaveBeenCalled();
    expect(h.deps.reserveSigning).not.toHaveBeenCalled();
  });

  it("fails closed while another Lighter transaction owns the next nonce", async () => {
    const h = setup();
    vi.mocked(h.deps.recordNonce).mockResolvedValue(null);

    const result = await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);

    expect(result).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("unresolved"),
    });
    expect(h.deps.reserveSigning).not.toHaveBeenCalled();
    expect(h.deps.sign).not.toHaveBeenCalled();
    expect(h.current().executionState).toBe("refused_unsubmitted");
  });

  it("persists the wire expiry with the reservation, in the same call", async () => {
    const h = setup();
    await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);
    expect(h.deps.reserveSigning).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: INTENT_ID }),
      NOW + 4 * 60_000,
      expect.any(Object),
    );
  });

  it("expires a proposal whose confirmation window closed, signing nothing", async () => {
    const h = setup({ now: NOW + 200_000 });

    const result = await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);

    expect(result.status).toBe("expired");
    expect(h.deps.readSetup).not.toHaveBeenCalled();
    expect(h.deps.sign).not.toHaveBeenCalled();
  });

  it("refuses an unknown proposal id", async () => {
    const h = setup();
    vi.mocked(h.deps.readIntent).mockResolvedValue(null);
    await expect(
      confirmLighterLeverage({ proposalId: "nope" }, undefined, h.deps),
    ).rejects.toThrow("not on record");
  });

  it("reconciles instead of signing again when the same proposal is confirmed twice", async () => {
    const h = setup({ intent: { executionState: "submitted", nonceValue: "7", txExpiryMs: TX_EXPIRY, signerTxHash: HASH, consentedAt: new Date(NOW), sendAttemptStartedAt: new Date(NOW) } });
    vi.mocked(h.deps.client.getTx).mockResolvedValue(executedTx());

    const result = await confirmLighterLeverage({ proposalId: INTENT_ID }, undefined, h.deps);

    expect(result.status).toBe("completed");
    expect(h.deps.sign).not.toHaveBeenCalled();
    expect(h.deps.client.sendTx).not.toHaveBeenCalled();
  });
});

describe("reconcileLighterLeverage", () => {
  const unresolved = (state: LighterLeverageIntentRow["executionState"]) =>
    setup({
      intent: {
        executionState: state,
        consentedAt: new Date(NOW),
        nonceValue: "7",
        txExpiryMs: TX_EXPIRY,
        signerTxHash: state === "signing" ? null : HASH,
        sendAttemptStartedAt:
          state === "submitted" || state === "ambiguous" ? new Date(NOW) : null,
      },
    });

  for (const state of [
    "signing",
    "signed",
    "submission_staged",
    "submitted",
    "ambiguous",
  ] as const) {
    it(`recovers from ${state} without ever signing again`, async () => {
      const h = unresolved(state);
      const result = await reconcileLighterLeverage({ proposalId: INTENT_ID }, h.deps);
      expect(["ambiguous", "completed", "refused", "rejected"]).toContain(result.status);
      expect(h.deps.sign).not.toHaveBeenCalled();
      expect(h.deps.client.sendTx).not.toHaveBeenCalled();
    });
  }

  it("stays pending while the proof is not visible yet, holding the reservation", async () => {
    const h = unresolved("submitted");
    const result = await reconcileLighterLeverage({ proposalId: INTENT_ID }, h.deps);
    expect(result.status).toBe("ambiguous");
    expect(h.deps.releaseNonce).not.toHaveBeenCalled();
    expect(h.deps.releaseUnsubmittedNonce).not.toHaveBeenCalled();
  });

  it("completes on an exact proof and frees the nonce state", async () => {
    const h = unresolved("ambiguous");
    vi.mocked(h.deps.client.getTx).mockResolvedValue(executedTx());
    const result = await reconcileLighterLeverage({ proposalId: INTENT_ID }, h.deps);
    expect(result.status).toBe("completed");
    expect(h.deps.recordNonce).toHaveBeenCalled();
  });

  it("rejects only on a status the failed set names, with the raw status reported", async () => {
    const h = unresolved("submitted");
    const deps = { ...h.deps, failedTxStatuses: [9] };
    vi.mocked(h.deps.client.getTx).mockResolvedValue(executedTx({ status: 9 }));

    const result = await reconcileLighterLeverage({ proposalId: INTENT_ID }, deps);

    expect(result).toMatchObject({ status: "rejected", providerStatus: 9 });
    expect(h.deps.sign).not.toHaveBeenCalled();
  });

  it("keeps an unnamed non-executed status pending rather than calling it a rejection", async () => {
    const h = unresolved("submitted");
    vi.mocked(h.deps.client.getTx).mockResolvedValue(executedTx({ status: 9 }));
    const result = await reconcileLighterLeverage({ proposalId: INTENT_ID }, h.deps);
    expect(result.status).toBe("ambiguous");
  });

  it("releases the reservation after expiry plus safety when the nonce was never consumed", async () => {
    const h = setup({
      now: TX_EXPIRY + 60_001,
      intent: {
        executionState: "signed",
        consentedAt: new Date(NOW),
        nonceValue: "7",
        txExpiryMs: TX_EXPIRY,
        signerTxHash: HASH,
      },
    });

    const result = await reconcileLighterLeverage({ proposalId: INTENT_ID }, h.deps);

    expect(result.status).toBe("refused");
    expect(h.deps.releaseUnsubmittedNonce).toHaveBeenCalledOnce();
    expect(h.current().executionState).toBe("expired_unsubmitted");
  });

  it("does not release before the safety margin has passed", async () => {
    const h = setup({
      now: TX_EXPIRY + 1_000,
      intent: {
        executionState: "signed",
        consentedAt: new Date(NOW),
        nonceValue: "7",
        txExpiryMs: TX_EXPIRY,
        signerTxHash: HASH,
      },
    });

    await reconcileLighterLeverage({ proposalId: INTENT_ID }, h.deps);

    expect(h.deps.releaseUnsubmittedNonce).not.toHaveBeenCalled();
    expect(h.deps.releaseNonce).not.toHaveBeenCalled();
  });

  it("keeps the outcome unresolved when the nonce moved past the reserved one with no proof", async () => {
    // The reserved slot was consumed by SOMETHING. That frees this account's
    // nonce ownership; it is not evidence about this transaction. Reporting
    // "rejected" here told the person their leverage was unchanged and invited
    // another change, which could be false.
    const h = setup({
      now: TX_EXPIRY + 60_001,
      nextNonce: 8,
      intent: {
        executionState: "submitted",
        consentedAt: new Date(NOW),
        nonceValue: "7",
        txExpiryMs: TX_EXPIRY,
        signerTxHash: HASH,
        sendAttemptStartedAt: new Date(NOW),
      },
    });

    const result = await reconcileLighterLeverage({ proposalId: INTENT_ID }, h.deps);

    expect(result).toMatchObject({ status: "ambiguous", intentId: INTENT_ID });
    expect(result).not.toMatchObject({ status: "rejected" });
    expect(h.current().executionState).toBe("ambiguous");
    expect(h.deps.markRejected).not.toHaveBeenCalled();
    // Nonce OWNERSHIP is released through the observed provider nonce, so other
    // Lighter work is not blocked behind an intent nobody can resolve.
    expect(h.deps.recordNonce).toHaveBeenCalled();
    expect(h.deps.releaseUnsubmittedNonce).not.toHaveBeenCalled();
  });

  it("rejects on the wire expiry only while the reserved nonce is provably unconsumed", async () => {
    // The one rejection with no provider status: the wire expiry plus the
    // safety margin passed and the reserved nonce is STILL the provider's next,
    // so no transaction carrying it can ever execute.
    const h = setup({
      now: TX_EXPIRY + 60_001,
      nextNonce: 7,
      intent: {
        executionState: "submitted",
        consentedAt: new Date(NOW),
        nonceValue: "7",
        txExpiryMs: TX_EXPIRY,
        signerTxHash: HASH,
        sendAttemptStartedAt: new Date(NOW),
      },
    });

    const result = await reconcileLighterLeverage({ proposalId: INTENT_ID }, h.deps);

    expect(result).toMatchObject({ status: "rejected", providerStatus: null });
    expect(h.deps.releaseNonce).toHaveBeenCalledOnce();
  });

  it("keeps a proven outcome when the account read afterwards fails", async () => {
    const h = unresolved("submitted");
    vi.mocked(h.deps.client.getTx).mockResolvedValue(executedTx());
    vi.mocked(h.deps.client.getAccount).mockRejectedValue(new Error("provider unavailable"));

    const result = await reconcileLighterLeverage({ proposalId: INTENT_ID }, h.deps);

    // The transaction proof is the authority; the account read never was.
    expect(result).toMatchObject({ status: "completed", observed: null });
    expect(result).toMatchObject({ note: expect.stringContaining("could not read the account") });
    expect(h.current().executionState).toBe("completed");
  });

  it("reports a refused transition as unresolved, never as completed", async () => {
    // The crash case finding 7 named: exact proof exists, but the row moved
    // under this attempt so `completed` never applied. Returning "completed"
    // for a write that did not happen is the defect.
    const h = unresolved("submission_staged");
    vi.mocked(h.deps.client.getTx).mockResolvedValue(executedTx());
    vi.mocked(h.deps.markCompleted).mockResolvedValue(null);

    const result = await reconcileLighterLeverage({ proposalId: INTENT_ID }, h.deps);

    expect(result.status).toBe("ambiguous");
    expect(result).toMatchObject({ reason: expect.stringContaining("Reconcile") });
    expect(h.current().executionState).toBe("submission_staged");
  });
});

describe("proveLighterUpdateLeverageTransaction", () => {
  const intent = baseIntent({
    executionState: "submitted",
    consentedAt: new Date(NOW),
    nonceValue: "7",
    txExpiryMs: TX_EXPIRY,
    signerTxHash: HASH,
  });

  it("accepts an exact match and reports the executed status", () => {
    expect(
      proveLighterUpdateLeverageTransaction({ tx: executedTx(), intent }),
    ).toMatchObject({ executed: true, status: 3, initialMarginFraction: 400 });
  });

  it("refuses a transaction of another type", () => {
    expect(() =>
      proveLighterUpdateLeverageTransaction({ tx: executedTx({ type: 15 }), intent }),
    ).toThrow("does not match");
  });

  it("refuses info that does not preserve the confirmed margin fraction", () => {
    const tx = executedTx({
      info: JSON.stringify({
        AccountIndex: 24226,
        ApiKeyIndex: 4,
        MarketIndex: 1,
        InitialMarginFraction: 5000,
        MarginMode: 0,
        Nonce: 7,
        ExpiredAt: TX_EXPIRY,
      }),
    });
    expect(() =>
      proveLighterUpdateLeverageTransaction({ tx, intent }),
    ).toThrow("does not preserve");
  });

  it("refuses info that names a field twice", () => {
    const tx = executedTx({
      info: '{"AccountIndex":24226,"ApiKeyIndex":4,"MarketIndex":1,"InitialMarginFraction":400,"InitialMarginFraction":400,"MarginMode":0,"Nonce":7,"ExpiredAt":'
        + `${TX_EXPIRY}}`,
    });
    expect(() =>
      proveLighterUpdateLeverageTransaction({ tx, intent }),
    ).toThrow("exactly one integer");
  });
});
