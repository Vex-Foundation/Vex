/**
 * The ONE behavioral change the Solana activity sweep gained for P1: a Jupiter
 * prediction sell/close whose own transaction landed clean but whose payout
 * decoder DECLINED now gets a second, keeper-side proof attempt
 * (`solana-prediction-fill-settlement.ts`) before it is logged as stuck.
 *
 * Everything else about the decline path is unchanged, and that is what this
 * file pins: which rows reach the lane, which rows must never reach it, and
 * that a lane decline still leaves the row pending with its `last_checked_at`
 * touched exactly as before. The sweep's own contracts (expiry gate, mined
 * failure, backoff, settlement decoding) are covered by the untouched
 * `solana-activity-repair.test.ts`.
 *
 * The lane itself is mocked here — its proof rules are covered end-to-end
 * against real captures in `solana-prediction-fill-settlement.test.ts`. This
 * file is about the WIRING.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import type { SolanaActivitySweepDeps } from "@vex-agent/sync/solana-activity-repair.js";

const mockListSolanaStagedPending = vi.fn();
const mockConfirmActivityEvent = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockTouchLastChecked = vi.fn();
const mockRecoverStaleHashlessIntents = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  listSolanaStagedPending: (...args: unknown[]) => mockListSolanaStagedPending(...args),
  confirmActivityEvent: (...args: unknown[]) => mockConfirmActivityEvent(...args),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
  touchLastChecked: (...args: unknown[]) => mockTouchLastChecked(...args),
  recoverStaleHashlessIntents: (...args: unknown[]) => mockRecoverStaleHashlessIntents(...args),
  HASHLESS_INTENT_RECOVERY_LEASE_MS: 15 * 60 * 1000,
}));

const mockSettlePredictionFill = vi.fn();

vi.mock("@vex-agent/sync/solana-prediction-fill-settlement.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@vex-agent/sync/solana-prediction-fill-settlement.js")
  >();
  return {
    ...actual,
    settlePredictionFillIfProven: (...args: unknown[]) => mockSettlePredictionFill(...args),
  };
});

const { repairPendingSolanaActivity } = await import("@vex-agent/sync/solana-activity-repair.js");

const JUPUSD_MINT = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";
const WALLET = "AeyBYFtgm85BrsZMKrAWdc2qGQqYvwfkt88dZdfYEndS";

/** A landed transaction the prediction payout decoder DECLINES: JupUSD present, wallet balance unchanged (the real stuck shape). */
function landedZeroMovementTransaction(): unknown {
  return {
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1_000_000_000, 0],
      postBalances: [1_000_000_000, 0],
      preTokenBalances: [{ owner: WALLET, mint: JUPUSD_MINT, uiTokenAmount: { amount: "271024" } }],
      postTokenBalances: [{ owner: WALLET, mint: JUPUSD_MINT, uiTokenAmount: { amount: "271024" } }],
      innerInstructions: [],
    },
    transaction: { message: { accountKeys: [{ pubkey: WALLET }, { pubkey: JUPUSD_MINT }], instructions: [] } },
  };
}

function predictionRow(overrides: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    id: 42,
    protocolExecutionId: 7,
    eventIndex: 0,
    eventRole: "predict_sell",
    recordVersion: 1,
    kind: "prediction",
    protocol: "jupiter",
    chainId: 20011000000,
    chainSlug: "solana",
    status: "pending",
    failureCode: null,
    failureReason: null,
    tokenInAddress: null,
    tokenInSymbol: null,
    tokenInDecimals: null,
    amountInHuman: null,
    amountInRaw: null,
    tokenOutAddress: JUPUSD_MINT,
    tokenOutSymbol: "JupUSD",
    tokenOutDecimals: 6,
    amountOutHuman: null,
    amountOutRaw: null,
    executedAmountInHuman: null,
    executedAmountInRaw: null,
    executedAmountOutHuman: null,
    executedAmountOutRaw: null,
    usdInEst: null,
    usdOutEst: null,
    usdFeeEst: null,
    usdNetworkGasEst: null,
    usdVenueFeeEst: null,
    usdDestinationPrepayEst: null,
    usdVexFeeEst: null,
    vexFeeTokenAddress: null,
    vexFeeTokenSymbol: null,
    vexFeeTokenDecimals: null,
    vexFeeAmountRaw: null,
    vexFeeAmountHuman: null,
    usdSource: null,
    txHash: "5AChd2vmZtjVFJ2wTgBssFwn6oAgJktHUBQkqU8oAwXJ7fJoZNUN6J7jbkmgAHkfEHXLWrSfCeKgvE5626tiFGsx",
    fromAddress: WALLET,
    nonce: null,
    walletAddress: WALLET,
    sessionId: "00000000-0000-4000-8000-000000000001",
    routeProvenance: null,
    fromChainId: null,
    fromChainSlug: null,
    toChainId: null,
    toChainSlug: null,
    chainFamily: "solana",
    providerOrderId: null,
    normalizedRoute: null,
    providerStatus: null,
    evidenceSource: null,
    observedAt: null,
    lastAttemptedAt: null,
    submitAttemptedAt: new Date(Date.now() - 120_000).toISOString(),
    recentBlockhash: "11111111111111111111111111111112",
    lastValidBlockHeight: 12345,
    broadcastAt: new Date(Date.now() - 119_000).toISOString(),
    confirmedAt: null,
    lastCheckedAt: null,
    createdAt: new Date(Date.now() - 121_000).toISOString(),
    updatedAt: new Date(Date.now() - 119_000).toISOString(),
    ...overrides,
  };
}

function landedDeps(overrides: Partial<SolanaActivitySweepDeps> = {}): SolanaActivitySweepDeps {
  return {
    getSignatureStatus: vi
      .fn()
      .mockResolvedValue({ outcome: "found", value: { err: null, confirmationStatus: "finalized" } }),
    getFinalizedTransaction: vi.fn().mockResolvedValue({ outcome: "found", value: landedZeroMovementTransaction() }),
    getCurrentBlockHeight: vi.fn().mockResolvedValue({ outcome: "unavailable" }),
    getSignaturesForAddress: vi.fn().mockResolvedValue({ outcome: "found", value: [] }),
    getPredictionOrderHistory: vi.fn().mockResolvedValue({ outcome: "unavailable" }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRecoverStaleHashlessIntents.mockResolvedValue([]);
  mockListSolanaStagedPending.mockResolvedValue([]);
  mockTouchLastChecked.mockResolvedValue(undefined);
  mockSettlePredictionFill.mockResolvedValue("pending");
});

describe("prediction fill-settlement hook — who reaches the lane", () => {
  it("routes a landed, undecodable predict_sell into the lane with the sweep's own deps", async () => {
    const event = predictionRow();
    mockListSolanaStagedPending.mockResolvedValueOnce([event]);
    mockSettlePredictionFill.mockResolvedValue("confirmed");
    const deps = landedDeps();

    const result = await repairPendingSolanaActivity(deps);

    expect(mockSettlePredictionFill).toHaveBeenCalledTimes(1);
    const [call] = mockSettlePredictionFill.mock.calls[0]!;
    expect(call).toMatchObject({ event: { id: 42 }, deps });
    expect(call.historyCache).toBeDefined();
    expect(result.confirmed).toBe(1);
    expect(mockConfirmActivityEvent).not.toHaveBeenCalled();
  });

  it("routes a predict_close the same way", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([predictionRow({ id: 47, eventRole: "predict_close" })]);
    mockSettlePredictionFill.mockResolvedValue("confirmed");

    await repairPendingSolanaActivity(landedDeps());

    expect(mockSettlePredictionFill).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["predict_claim (its settlement shape has never been proven live)", { eventRole: "predict_claim" as const }],
    ["a non-Jupiter prediction row", { protocol: "polymarket" }],
    ["a swap row", { eventRole: "swap" as const, kind: "swap" as const }],
    [
      "a lend row",
      {
        eventRole: "lend_deposit" as const,
        kind: "lend" as const,
        // an SPL mint this transaction never touched, so the generic decoder
        // declines and the row takes the same "undecodable" branch the lane
        // hook sits in (deliberately not the SOL sentinel, whose decode falls
        // back to native lamports and would prove a delta here)
        tokenOutAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
    ],
  ])("never routes %s into the lane", async (_label, overrides) => {
    mockListSolanaStagedPending.mockResolvedValueOnce([predictionRow(overrides as Partial<AgentActivityEvent>)]);

    const result = await repairPendingSolanaActivity(landedDeps());

    expect(mockSettlePredictionFill).not.toHaveBeenCalled();
    // unchanged decline behavior: pending, and the row's clock is touched
    expect(result.stillPending).toBe(1);
    expect(mockTouchLastChecked).toHaveBeenCalledWith(42);
  });
});

describe("prediction fill-settlement hook — what a lane outcome does", () => {
  it("leaves the row pending and touches its clock when the lane cannot prove a payout", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([predictionRow()]);
    mockSettlePredictionFill.mockResolvedValue("pending");

    const result = await repairPendingSolanaActivity(landedDeps());

    expect(result.stillPending).toBe(1);
    expect(result.confirmed).toBe(0);
    expect(mockTouchLastChecked).toHaveBeenCalledWith(42);
  });

  it("counts a duplicate CAS miss as neither confirmed nor pending", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([predictionRow()]);
    mockSettlePredictionFill.mockResolvedValue("duplicate");

    const result = await repairPendingSolanaActivity(landedDeps());

    expect(result.confirmed).toBe(0);
    expect(result.stillPending).toBe(0);
    expect(result.checked).toBe(1);
  });

  it("never terminalizes a row through this path", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([predictionRow()]);
    mockSettlePredictionFill.mockResolvedValue("pending");

    await repairPendingSolanaActivity(landedDeps());

    expect(mockFailActivityEvent).not.toHaveBeenCalled();
  });

  it("shares ONE history cache across every candidate in a run, and a fresh one per run", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([predictionRow(), predictionRow({ id: 43 })]);

    await repairPendingSolanaActivity(landedDeps());
    const firstRunCache = mockSettlePredictionFill.mock.calls[0]![0].historyCache;
    expect(mockSettlePredictionFill.mock.calls[1]![0].historyCache).toBe(firstRunCache);

    mockListSolanaStagedPending.mockResolvedValueOnce([predictionRow()]);
    await repairPendingSolanaActivity(landedDeps());
    expect(mockSettlePredictionFill.mock.calls[2]![0].historyCache).not.toBe(firstRunCache);
  });

  it("does not reach the lane at all when the decoder PROVED a payout (the normal path is untouched)", async () => {
    const event = predictionRow();
    mockListSolanaStagedPending.mockResolvedValueOnce([event]);
    mockConfirmActivityEvent.mockResolvedValue({ applied: true, row: event });
    const credited = landedZeroMovementTransaction() as {
      meta: { postTokenBalances: Array<{ uiTokenAmount: { amount: string } }> };
    };
    credited.meta.postTokenBalances[0]!.uiTokenAmount.amount = "4816884";

    const result = await repairPendingSolanaActivity(
      landedDeps({ getFinalizedTransaction: vi.fn().mockResolvedValue({ outcome: "found", value: credited }) }),
    );

    expect(mockSettlePredictionFill).not.toHaveBeenCalled();
    expect(mockConfirmActivityEvent).toHaveBeenCalledWith(42, {
      executedAmountOutRaw: "4545860",
      executedAmountOutHuman: "4.54586",
    });
    expect(result.confirmed).toBe(1);
  });
});
