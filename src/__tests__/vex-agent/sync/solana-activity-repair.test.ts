/**
 * `solana-activity-repair` - the Solana sweep, pure orchestration over the
 * injected `SolanaActivitySweepDeps` port. Mocked-DB unit test (mock the whole
 * `@vex-agent/db/repos/agent-activity.js` module; inject fake RPC deps).
 *
 * Pins the terminality table:
 *   - `confirmed`/`finalized` + `err == null`  → `confirmed`; status-only, with
 *     NO transaction-body fetch, for every row the amount lane finds ineligible
 *     (see the executed-amounts block at the bottom for the eligible ones);
 *   - `confirmed`/`finalized` + `err != null`  → `definitively_failed`;
 *   - `processed`/unknown commitment           → stays `pending` in BOTH
 *     directions — a processed transaction can still be dropped with its fork,
 *     so neither its success nor its failure is proven;
 *   - RPC unavailable                          → stays `pending`;
 *   - signature not found                      → `getTransaction` cross-check,
 *     read for `meta.err` PRESENCE only, never decoded for amounts;
 *   - both miss                                → the expiry gate's literal AND,
 *     and an evidence-less (grandfathered) row can never expire.
 *
 * Plus the mechanics the 30s cadence introduced: a flat due gate (due at 30s,
 * not before), and ONE batched `getSignatureStatuses` call per sweep run rather
 * than one per row.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import type {
  SolanaActivitySweepDeps,
  SolanaSignatureStatusValue,
} from "@vex-agent/sync/solana-activity-repair.js";

const mockListSolanaStagedPending = vi.fn();
const mockConfirmActivityEvent = vi.fn();
const mockConfirmActivityEventStatusOnly = vi.fn();
const mockNoteSettlementDeclined = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockTouchLastChecked = vi.fn();
const mockClearVerificationStall = vi.fn();
const mockRecoverStaleHashlessIntents = vi.fn();
const mockNoteSettledBlockTime = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  listSolanaStagedPending: (...args: unknown[]) => mockListSolanaStagedPending(...args),
  confirmActivityEvent: (...args: unknown[]) => mockConfirmActivityEvent(...args),
  confirmActivityEventStatusOnly: (...args: unknown[]) => mockConfirmActivityEventStatusOnly(...args),
  noteSettlementDeclined: (...args: unknown[]) => mockNoteSettlementDeclined(...args),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
  touchLastChecked: (...args: unknown[]) => mockTouchLastChecked(...args),
  clearVerificationStall: (...args: unknown[]) => mockClearVerificationStall(...args),
  recoverStaleHashlessIntents: (...args: unknown[]) => mockRecoverStaleHashlessIntents(...args),
  noteSettledBlockTime: (...args: unknown[]) => mockNoteSettledBlockTime(...args),
  HASHLESS_INTENT_RECOVERY_LEASE_MS: 15 * 60 * 1000,
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const {
  repairPendingSolanaActivity,
  isSolanaSweepCandidateDue,
  isSolanaSweepEscalated,
  SOLANA_SWEEP_DUE_INTERVAL_MS,
  SOLANA_HASHLESS_RECOVERY_BATCH_LIMIT,
  SOLANA_SWEEP_BATCH_LIMIT,
} = await import("@vex-agent/sync/solana-activity-repair.js");

const { SOLANA_SWEEP_AMOUNT_BODY_FETCH_LIMIT } = await import(
  "@vex-agent/sync/solana-activity-repair/amount-decode-lane.js"
);

function candidateEvent(overrides: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  const base: AgentActivityEvent = {
    id: 1,
    protocolExecutionId: 42,
    eventIndex: 0,
    eventRole: "swap",
    recordVersion: 1,
    kind: "swap",
    protocol: "jupiter",
    chainId: 20011000000,
    chainSlug: "solana",
    status: "pending",
    failureCode: null,
    failureReason: null,
    tokenInAddress: "USDCmint1111111111111111111111111111111111",
    tokenInSymbol: "USDC",
    tokenInDecimals: 6,
    amountInHuman: "10",
    amountInRaw: "10000000",
    tokenOutAddress: "So11111111111111111111111111111111111111112",
    tokenOutSymbol: "SOL",
    tokenOutDecimals: 9,
    amountOutHuman: null,
    amountOutRaw: null,
    executedAmountInHuman: null,
    executedAmountInRaw: null,
    executedAmountOutHuman: null,
    executedAmountOutRaw: null,
    usdInEst: null,
    usdOutEst: null,
    usdFeeEst: null,
    usdSource: null,
    txHash: "5SoLSigBase58aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    fromAddress: "SoLFromAddr1111111111111111111111111111111",
    nonce: null,
    walletAddress: "SoLFromAddr1111111111111111111111111111111",
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
    submitAttemptedAt: "2026-07-24T10:00:00.000Z",
    recentBlockhash: "11111111111111111111111111111112",
    lastValidBlockHeight: 100,
    broadcastAt: "2026-07-24T10:00:01.000Z",
    confirmedAt: null,
    lastCheckedAt: null,
    settledBlockTime: null,
    createdAt: "2026-07-24T09:59:00.000Z",
    updatedAt: "2026-07-24T10:00:01.000Z",
    // Columns the live contract requires that this fixture never exercises.
    tokenIn2Address: null,
    tokenIn2Symbol: null,
    tokenIn2Decimals: null,
    amountIn2Human: null,
    amountIn2Raw: null,
    executedAmountIn2Human: null,
    executedAmountIn2Raw: null,
    tokenOut2Address: null,
    tokenOut2Symbol: null,
    tokenOut2Decimals: null,
    amountOut2Human: null,
    amountOut2Raw: null,
    executedAmountOut2Human: null,
    executedAmountOut2Raw: null,
    usdNetworkGasEst: null,
    usdVenueFeeEst: null,
    usdDestinationPrepayEst: null,
    usdVexFeeEst: null,
    vexFeeTokenAddress: null,
    vexFeeTokenSymbol: null,
    vexFeeTokenDecimals: null,
    vexFeeAmountRaw: null,
    vexFeeAmountHuman: null,
    verificationAttempts: 0,
    lastVerificationReason: null,
  confirmationSource: null,
  settlementSource: null,
  pendingReason: null,
  providerStatusObservedAt: null,
  // The pending-fallback lane's own state (migration 068) — untouched by
  // this fixture's row, which is exactly what NULL says.
  evmClaimLeaseUntil: null,
  evmClaimToken: null,
  lastVerificationIncrementAt: null,
  firstNonInclusionObservedAt: null,
  settlementDecodeVersion: null,
  };
  // `Object.assign`, not a spread: spreading a `Partial<…>` into an
  // index-free literal widens every required field to `| undefined`.
  return Object.assign(base, overrides);
}

function statusesFound(
  ...values: ReadonlyArray<SolanaSignatureStatusValue | null>
): Awaited<ReturnType<SolanaActivitySweepDeps["getSignatureStatuses"]>> {
  return { outcome: "found", value: values };
}

function deps(overrides: Partial<SolanaActivitySweepDeps> = {}): SolanaActivitySweepDeps {
  return {
    getSignatureStatuses: vi.fn(async () => ({ outcome: "unavailable" as const })),
    getFinalizedTransaction: vi.fn(async () => ({ outcome: "unavailable" as const })),
    getCurrentBlockHeight: vi.fn(async () => ({ outcome: "unavailable" as const })),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRecoverStaleHashlessIntents.mockResolvedValue([]);
  mockListSolanaStagedPending.mockResolvedValue([]);
  mockConfirmActivityEventStatusOnly.mockResolvedValue({
    applied: true,
    row: candidateEvent({ status: "confirmed" }),
  });
  mockNoteSettlementDeclined.mockResolvedValue({ applied: true });
  mockConfirmActivityEvent.mockResolvedValue({
    applied: true,
    row: candidateEvent({ status: "confirmed" }),
  });
  mockFailActivityEvent.mockResolvedValue({
    applied: true,
    row: candidateEvent({ status: "definitively_failed" }),
  });
});

describe("repairPendingSolanaActivity — landed status terminality", () => {
  it("a terminal-commitment entry with NO err property is malformed evidence — the row stays pending", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([candidateEvent()]);

    const result = await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () =>
          statusesFound({ confirmationStatus: "finalized" } as never),
        ),
      }),
    );

    expect(mockConfirmActivityEventStatusOnly).not.toHaveBeenCalled();
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stillPending: 1 });
  });

  it.each(["confirmed", "finalized"])(
    "%s + no error confirms status-only, without fetching the transaction body",
    async (confirmationStatus) => {
      mockListSolanaStagedPending.mockResolvedValueOnce([candidateEvent()]);
      const port = deps({
        getSignatureStatuses: vi.fn(async () => statusesFound({ err: null, confirmationStatus })),
      });

      const result = await repairPendingSolanaActivity(port);

      expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(1, "receipt_status_only_solana");
      expect(port.getFinalizedTransaction).not.toHaveBeenCalled();
      expect(result).toMatchObject({ checked: 1, confirmed: 1, failed: 0, stillPending: 0 });
    },
  );

  it.each(["confirmed", "finalized"])("%s + an on-chain error fails the row with mined_revert", async (confirmationStatus) => {
    mockListSolanaStagedPending.mockResolvedValueOnce([candidateEvent()]);

    const result = await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () =>
          statusesFound({ err: { InstructionError: [3, "ProgramFailedToComplete"] }, confirmationStatus }),
        ),
      }),
    );

    expect(mockFailActivityEvent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ failureCode: "mined_revert" }),
    );
    // The chain's OWN error is quoted, never discarded.
    expect(mockFailActivityEvent.mock.calls[0]![1].failureReason).toContain("InstructionError");
    expect(result).toMatchObject({ failed: 1 });
  });

  it.each([null, { InstructionError: [0, "Custom"] }])(
    "a 'processed'-only commitment stays pending in BOTH directions (err = %j)",
    async (err) => {
      mockListSolanaStagedPending.mockResolvedValueOnce([candidateEvent()]);

      const result = await repairPendingSolanaActivity(
        deps({
          getSignatureStatuses: vi.fn(async () => statusesFound({ err, confirmationStatus: "processed" })),
        }),
      );

      expect(mockConfirmActivityEventStatusOnly).not.toHaveBeenCalled();
      expect(mockFailActivityEvent).not.toHaveBeenCalled();
      // The RPC ANSWERED — we know exactly where this row stands, so the stall
      // counter is CLEARED rather than incremented. Counting a healthy,
      // successfully-observed transaction toward "verification stalled" would
      // make the flag a lie about our own knowledge.
      expect(mockClearVerificationStall).toHaveBeenCalledWith(1);
      expect(mockTouchLastChecked).not.toHaveBeenCalled();
      expect(result).toMatchObject({ checked: 1, stillPending: 1 });
    },
  );

  it("an unavailable BATCH lookup never terminalizes, but still rotates EVERY due row", async () => {
    // The batched adapter declines the WHOLE call when any entry is malformed,
    // so without this every such tick would reselect the same oldest 25 rows
    // and starve everything behind them — a permanent outage disguised as a
    // retry. Fail-closed is untouched: no row changes terminal state.
    mockListSolanaStagedPending.mockResolvedValueOnce([
      candidateEvent({ id: 1, txHash: "sigA" }),
      candidateEvent({ id: 2, txHash: "sigB" }),
    ]);

    const result = await repairPendingSolanaActivity(deps());

    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(mockConfirmActivityEventStatusOnly).not.toHaveBeenCalled();
    expect(mockTouchLastChecked).toHaveBeenCalledWith(1, "signature_status_unavailable");
    expect(mockTouchLastChecked).toHaveBeenCalledWith(2, "signature_status_unavailable");
    expect(result).toMatchObject({ stillPending: 2 });
  });
});

describe("repairPendingSolanaActivity — not-found signature fallback", () => {
  it("reads the finalized transaction for meta.err PRESENCE only: null err → status-only confirm", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([candidateEvent()]);

    await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () => statusesFound(null)),
        getFinalizedTransaction: vi.fn(async () => ({
          outcome: "found" as const,
          // A real body carries balances the sweep must NOT read.
          value: { meta: { err: null, preTokenBalances: [], postTokenBalances: [] } },
        })),
      }),
    );

    expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(1, "receipt_status_only_solana");
  });

  it("a non-null meta.err fails the row", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([candidateEvent()]);

    await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () => statusesFound(null)),
        getFinalizedTransaction: vi.fn(async () => ({
          outcome: "found" as const,
          value: { meta: { err: { InstructionError: [1, "Custom"] } } },
        })),
      }),
    );

    expect(mockFailActivityEvent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ failureCode: "mined_revert" }),
    );
  });

  // ABSENT IS NOT NULL. A body with no readable `err` PROPERTY is malformed
  // evidence, not proof of success — coercing it to `err === null` would
  // status-confirm a transaction we never actually read the outcome of.
  it.each([
    ["no meta at all", { noMeta: true }],
    ["a meta object with no err property", { meta: {} }],
    ["a non-object meta", { meta: "oops" }],
    ["a null body", null],
  ])("treats %s as ambiguity, not success — the row stays pending", async (_label, value) => {
    mockListSolanaStagedPending.mockResolvedValueOnce([candidateEvent()]);

    const result = await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () => statusesFound(null)),
        getFinalizedTransaction: vi.fn(async () => ({ outcome: "found" as const, value })),
      }),
    );

    expect(mockConfirmActivityEventStatusOnly).not.toHaveBeenCalled();
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stillPending: 1 });
  });

  it("touches last_checked_at when the getTransaction fallback is UNAVAILABLE, so the batch window rotates", async () => {
    // The candidate query orders by `last_checked_at` and takes 25 rows. A row
    // whose fallback keeps failing must still move to the back of the queue, or
    // it pins the window and starves every newer pending row behind it.
    mockListSolanaStagedPending.mockResolvedValueOnce([candidateEvent()]);

    const result = await repairPendingSolanaActivity(
      deps({ getSignatureStatuses: vi.fn(async () => statusesFound(null)) }),
    );

    expect(mockTouchLastChecked).toHaveBeenCalledWith(1, "get_transaction_unavailable");
    expect(result).toMatchObject({ stillPending: 1 });
  });
});

describe("repairPendingSolanaActivity — expiry gate (the only absence-of-proof terminalization)", () => {
  it("expires only when BOTH lookups miss AND the persisted block height is passed", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([candidateEvent({ lastValidBlockHeight: 100 })]);

    await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () => statusesFound(null)),
        getFinalizedTransaction: vi.fn(async () => ({ outcome: "not_found" as const })),
        getCurrentBlockHeight: vi.fn(async () => ({ outcome: "found" as const, value: 101 })),
      }),
    );

    expect(mockFailActivityEvent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ failureCode: "solana_signature_expired" }),
    );
  });

  it("never expires a row with no persisted blockhash evidence", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([candidateEvent({ lastValidBlockHeight: null })]);

    const result = await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () => statusesFound(null)),
        getFinalizedTransaction: vi.fn(async () => ({ outcome: "not_found" as const })),
        getCurrentBlockHeight: vi.fn(async () => ({ outcome: "found" as const, value: 999_999 })),
      }),
    );

    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stillPending: 1 });
  });

  it("never expires on an unavailable block-height lookup, and still rotates the row", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([candidateEvent()]);

    await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () => statusesFound(null)),
        getFinalizedTransaction: vi.fn(async () => ({ outcome: "not_found" as const })),
      }),
    );

    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(mockTouchLastChecked).toHaveBeenCalledWith(1, "block_height_unavailable");
  });
});

describe("repairPendingSolanaActivity — cadence and batching", () => {
  it("issues ONE batched getSignatureStatuses call for the whole due batch", async () => {
    const a = candidateEvent({ id: 1, txHash: "sigA" });
    const b = candidateEvent({ id: 2, txHash: "sigB" });
    mockListSolanaStagedPending.mockResolvedValueOnce([a, b]);
    const getSignatureStatuses = vi.fn(async () =>
      statusesFound({ err: null, confirmationStatus: "finalized" }, { err: null, confirmationStatus: "finalized" }),
    );

    const result = await repairPendingSolanaActivity(deps({ getSignatureStatuses }));

    expect(getSignatureStatuses).toHaveBeenCalledTimes(1);
    expect(getSignatureStatuses).toHaveBeenCalledWith(["sigA", "sigB"]);
    expect(result.confirmed).toBe(2);
  });

  it("aligns batched entries with their rows by index", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([
      candidateEvent({ id: 1, txHash: "sigA" }),
      candidateEvent({ id: 2, txHash: "sigB" }),
    ]);

    await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () =>
          statusesFound(
            { err: null, confirmationStatus: "finalized" },
            { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "finalized" },
          ),
        ),
      }),
    );

    expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(1, "receipt_status_only_solana");
    expect(mockFailActivityEvent).toHaveBeenCalledWith(2, expect.objectContaining({ failureCode: "mined_revert" }));
  });

  it("skips a not-yet-due row without spending an RPC call on it", async () => {
    const now = Date.parse("2026-07-24T10:05:00.000Z");
    vi.setSystemTime(now);
    mockListSolanaStagedPending.mockResolvedValueOnce([
      candidateEvent({ lastCheckedAt: new Date(now - 1_000).toISOString() }),
    ]);
    const getSignatureStatuses = vi.fn();

    const result = await repairPendingSolanaActivity(deps({ getSignatureStatuses }));

    expect(getSignatureStatuses).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 0, stillPending: 1 });
    vi.useRealTimers();
  });

  it("recovers stale hashless intents on every tick, bounded", async () => {
    await repairPendingSolanaActivity(deps());
    expect(mockRecoverStaleHashlessIntents).toHaveBeenCalledWith(
      15 * 60 * 1000,
      SOLANA_HASHLESS_RECOVERY_BATCH_LIMIT,
    );
    expect(mockListSolanaStagedPending).toHaveBeenCalledWith(SOLANA_SWEEP_BATCH_LIMIT);
  });
});

describe("repairPendingSolanaActivity - executed amounts from SPL balance deltas", () => {
  const WALLET = "AeyBYFtgm85BrsZMKrAWdc2qGQqYvwfkt88dZdfYEndS";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const JUP_USD = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";
  const WSOL = "So11111111111111111111111111111111111111112";

  function body(name: string): unknown {
    const path = fileURLToPath(new URL(`./fixtures/jupiter-settlement/${name}.json`, import.meta.url));
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  }

  /** A row whose persisted settlement profile names the two mints the decode is bounded by. */
  function profiledRow(
    inputMint: string,
    outputMint: string,
    overrides: Partial<AgentActivityEvent> = {},
  ): AgentActivityEvent {
    return candidateEvent({
      walletAddress: WALLET,
      routeProvenance: {
        settlement: {
          v: 1,
          kind: "jupiter_fee_swap_exact_in",
          inputMint,
          outputMint,
          inputAmountRaw: "4584000",
          tipRecipient: null,
          tipLamports: 0,
          wrapAndUnwrapSol: inputMint === WSOL || outputMint === WSOL,
        },
      },
      ...overrides,
    });
  }

  const landed = { err: null, confirmationStatus: "finalized" } as const;

  it("confirms a fully-SPL swap WITH both executed legs, from one transaction body", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([profiledRow(JUP_USD, USDC)]);
    const getFinalizedTransaction = vi.fn(async () => ({
      outcome: "found" as const,
      value: body("swap-jupusd-to-usdc-3g3NAiBJ"),
    }));

    const result = await repairPendingSolanaActivity(
      deps({ getSignatureStatuses: vi.fn(async () => statusesFound(landed)), getFinalizedTransaction }),
    );

    expect(getFinalizedTransaction).toHaveBeenCalledTimes(1);
    expect(mockConfirmActivityEvent).toHaveBeenCalledWith(1, {
      executedAmountInRaw: "4584000",
      executedAmountInHuman: "4.584",
      executedAmountOutRaw: "4572791",
      executedAmountOutHuman: "4.572791",
    });
    // The same body carries the settling block's time (result.blockTime,
    // seconds); the sweep records it so the AgentScan report can state the
    // chain's own confirmation time instead of nothing.
    expect(mockNoteSettledBlockTime).toHaveBeenCalledWith(1, "2026-07-26T17:10:52.000Z");
    expect(mockConfirmActivityEventStatusOnly).not.toHaveBeenCalled();
    expect(result).toMatchObject({ confirmed: 1 });
  });

  it("confirms a wrapped-SOL swap with BOTH legs: the wrap principal and the SPL credit", async () => {
    // The wSOL account is created and closed inside the transaction, so the
    // native leg has no balance entry; it is proven from the instructions, and
    // never from the fee payer's lamport delta or the close payout.
    mockListSolanaStagedPending.mockResolvedValueOnce([profiledRow(WSOL, USDC)]);

    const result = await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () => statusesFound(landed)),
        getFinalizedTransaction: vi.fn(async () => ({
          outcome: "found" as const,
          value: body("swap-sol-to-usdc-3SC5Mi5L"),
        })),
      }),
    );

    expect(mockConfirmActivityEvent).toHaveBeenCalledWith(1, {
      executedAmountInRaw: "15000000",
      executedAmountInHuman: "0.015",
      executedAmountOutRaw: "1103883",
      executedAmountOutHuman: "1.103883",
    });
    expect(mockNoteSettlementDeclined).not.toHaveBeenCalled();
    expect(result).toMatchObject({ confirmed: 1 });
  });

  it("stamps the settlement decline after a body-read refusal, so the outbox stops holding the row", async () => {
    // The profile names a mint this transaction never moved for us: the body was
    // READ and refused, which is a conclusion about the amounts, not a deferral.
    mockListSolanaStagedPending.mockResolvedValueOnce([
      profiledRow("MintNobodyMovedHere111111111111111111111111", USDC),
    ]);
    // ORDER IS THE CONTRACT: `noteSettlementDeclined` only writes on a row that
    // is already `confirmed`, so it must run after the status-only confirm.
    mockNoteSettlementDeclined.mockImplementationOnce(async () => {
      expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalled();
      return { applied: true };
    });

    await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () => statusesFound(landed)),
        getFinalizedTransaction: vi.fn(async () => ({
          outcome: "found" as const,
          value: body("swap-jupusd-to-usdc-3g3NAiBJ"),
        })),
      }),
    );

    expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(1, "receipt_status_only_solana");
    expect(mockNoteSettlementDeclined).toHaveBeenCalledWith(1, "amounts_undecodable");
  });

  it("stamps NOTHING when the body was never read - a deferral is not a refusal", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([profiledRow(JUP_USD, USDC)]);

    await repairPendingSolanaActivity(
      deps({ getSignatureStatuses: vi.fn(async () => statusesFound(landed)) }),
    );

    expect(mockNoteSettlementDeclined).not.toHaveBeenCalled();
    expect(mockConfirmActivityEventStatusOnly).not.toHaveBeenCalled();
  });

  it("stamps NOTHING on a row the lane never had a reason to decode", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([candidateEvent({ routeProvenance: null })]);

    await repairPendingSolanaActivity(
      deps({ getSignatureStatuses: vi.fn(async () => statusesFound(landed)) }),
    );

    expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(1, "receipt_status_only_solana");
    expect(mockNoteSettlementDeclined).not.toHaveBeenCalled();
  });

  it("spends NO transaction body on a row without a settlement profile", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([candidateEvent({ routeProvenance: null })]);
    const getFinalizedTransaction = vi.fn();

    await repairPendingSolanaActivity(
      deps({ getSignatureStatuses: vi.fn(async () => statusesFound(landed)), getFinalizedTransaction }),
    );

    expect(getFinalizedTransaction).not.toHaveBeenCalled();
    expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(1, "receipt_status_only_solana");
  });

  it("spends no transaction body on a MINED FAILURE - a reverted transaction moved nothing", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([profiledRow(JUP_USD, USDC)]);
    const getFinalizedTransaction = vi.fn();

    await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () =>
          statusesFound({ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "finalized" }),
        ),
        getFinalizedTransaction,
      }),
    );

    expect(getFinalizedTransaction).not.toHaveBeenCalled();
    expect(mockFailActivityEvent).toHaveBeenCalledWith(1, expect.objectContaining({ failureCode: "mined_revert" }));
  });

  it("leaves an eligible row PENDING when its body could not be read - the confirm is one-shot", async () => {
    // Confirming status-only here would burn the row's single terminal write and
    // lose amounts that were there to be read. Nothing was checked either, so
    // `last_checked_at` is deliberately not rotated: this row goes first again.
    mockListSolanaStagedPending.mockResolvedValueOnce([profiledRow(JUP_USD, USDC)]);

    const result = await repairPendingSolanaActivity(
      deps({ getSignatureStatuses: vi.fn(async () => statusesFound(landed)) }),
    );

    expect(mockConfirmActivityEvent).not.toHaveBeenCalled();
    expect(mockConfirmActivityEventStatusOnly).not.toHaveBeenCalled();
    expect(mockTouchLastChecked).not.toHaveBeenCalled();
    expect(result).toMatchObject({ confirmed: 0, stillPending: 1 });
  });

  it("bounds body fetches per run: rows past the limit wait for the next tick", async () => {
    const rows = Array.from({ length: SOLANA_SWEEP_AMOUNT_BODY_FETCH_LIMIT + 2 }, (_unused, index) =>
      profiledRow(JUP_USD, USDC, { id: index + 1, txHash: `sig${index}` }),
    );
    mockListSolanaStagedPending.mockResolvedValueOnce(rows);
    const getFinalizedTransaction = vi.fn(async () => ({
      outcome: "found" as const,
      value: body("swap-jupusd-to-usdc-3g3NAiBJ"),
    }));

    const result = await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () => statusesFound(...rows.map(() => landed))),
        getFinalizedTransaction,
      }),
    );

    expect(getFinalizedTransaction).toHaveBeenCalledTimes(SOLANA_SWEEP_AMOUNT_BODY_FETCH_LIMIT);
    expect(mockConfirmActivityEvent).toHaveBeenCalledTimes(SOLANA_SWEEP_AMOUNT_BODY_FETCH_LIMIT);
    expect(result).toMatchObject({ confirmed: SOLANA_SWEEP_AMOUNT_BODY_FETCH_LIMIT, stillPending: 2 });
  });

  it("reuses the not-found fallback's body instead of fetching a second one", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([profiledRow(JUP_USD, USDC)]);
    const getFinalizedTransaction = vi.fn(async () => ({
      outcome: "found" as const,
      value: body("swap-jupusd-to-usdc-3g3NAiBJ"),
    }));

    await repairPendingSolanaActivity(
      deps({ getSignatureStatuses: vi.fn(async () => statusesFound(null)), getFinalizedTransaction }),
    );

    expect(getFinalizedTransaction).toHaveBeenCalledTimes(1);
    expect(mockConfirmActivityEvent).toHaveBeenCalledWith(1, expect.objectContaining({ executedAmountInRaw: "4584000" }));
  });

  /**
   * lend/prediction rows carry no settlement profile, so their mints come from
   * the token columns the row itself declared at intent time. The bodies are the
   * same real mainnet captures: the decode is bounded by owner and mint, so what
   * makes a case lend-shaped or prediction-shaped is the ROW, not the body.
   */
  function declaredRow(overrides: Partial<AgentActivityEvent>): AgentActivityEvent {
    return candidateEvent({
      walletAddress: WALLET,
      routeProvenance: null,
      tokenInAddress: JUP_USD,
      tokenOutAddress: USDC,
      ...overrides,
    });
  }

  it.each([
    ["lend_deposit", "lend"],
    ["predict_buy", "prediction"],
  ])("confirms a %s row with the legs its declared mints prove", async (eventRole, kind) => {
    mockListSolanaStagedPending.mockResolvedValueOnce([
      declaredRow({ eventRole: eventRole as AgentActivityEvent["eventRole"], kind: kind as AgentActivityEvent["kind"] }),
    ]);

    await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () => statusesFound(landed)),
        getFinalizedTransaction: vi.fn(async () => ({
          outcome: "found" as const,
          value: body("swap-jupusd-to-usdc-3g3NAiBJ"),
        })),
      }),
    );

    expect(mockConfirmActivityEvent).toHaveBeenCalledWith(1, {
      executedAmountInRaw: "4584000",
      executedAmountInHuman: "4.584",
      executedAmountOutRaw: "4572791",
      executedAmountOutHuman: "4.572791",
    });
  });

  it("stamps the ONE leg a prediction claim proves, and invents nothing for the side it never declared", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([
      declaredRow({ eventRole: "predict_claim", kind: "prediction", tokenInAddress: null, tokenOutAddress: USDC }),
    ]);

    await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () => statusesFound(landed)),
        getFinalizedTransaction: vi.fn(async () => ({
          outcome: "found" as const,
          value: body("swap-jupusd-to-usdc-3g3NAiBJ"),
        })),
      }),
    );

    expect(mockConfirmActivityEvent).toHaveBeenCalledWith(1, {
      executedAmountOutRaw: "4572791",
      executedAmountOutHuman: "4.572791",
    });
  });

  it("falls back to a status-only confirm when the per-role leg guard rejects the proven legs", async () => {
    // The repo's confirm guard is the authority on which legs a role may be
    // confirmed with. A rejection must not abort the sweep tick, and must not be
    // worked around from here - the row confirms without amounts instead.
    mockConfirmActivityEvent.mockRejectedValueOnce(new Error("event_role 'lend_withdraw' requires more"));
    mockListSolanaStagedPending.mockResolvedValueOnce([
      declaredRow({ eventRole: "lend_withdraw", kind: "lend", tokenInAddress: null }),
    ]);

    const result = await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () => statusesFound(landed)),
        getFinalizedTransaction: vi.fn(async () => ({
          outcome: "found" as const,
          value: body("swap-jupusd-to-usdc-3g3NAiBJ"),
        })),
      }),
    );

    expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(1, "receipt_status_only_solana");
    expect(result).toMatchObject({ confirmed: 1 });
  });

  it("confirms status-only when no declared leg is provable", async () => {
    // The row declares a wSOL input this body has no wallet-owned entry for, and
    // no output at all. Nothing proven means nothing written.
    mockListSolanaStagedPending.mockResolvedValueOnce([
      declaredRow({ eventRole: "lend_deposit", kind: "lend", tokenInAddress: WSOL, tokenOutAddress: null }),
    ]);

    await repairPendingSolanaActivity(
      deps({
        getSignatureStatuses: vi.fn(async () => statusesFound(landed)),
        getFinalizedTransaction: vi.fn(async () => ({
          outcome: "found" as const,
          value: body("swap-jupusd-to-usdc-3g3NAiBJ"),
        })),
      }),
    );

    expect(mockConfirmActivityEvent).not.toHaveBeenCalled();
    expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(1, "receipt_status_only_solana");
  });

  it("spends no transaction body on a lend row whose token columns name no Solana mint", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([
      declaredRow({
        eventRole: "lend_deposit",
        kind: "lend",
        tokenInAddress: null,
        tokenOutAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      }),
    ]);
    const getFinalizedTransaction = vi.fn();

    await repairPendingSolanaActivity(
      deps({ getSignatureStatuses: vi.fn(async () => statusesFound(landed)), getFinalizedTransaction }),
    );

    expect(getFinalizedTransaction).not.toHaveBeenCalled();
    expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(1, "receipt_status_only_solana");
  });

  it("writes no amounts on a kind this lane has no declared-mint rule for", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([
      declaredRow({ eventRole: "bridge_deposit", kind: "bridge" }),
    ]);
    const getFinalizedTransaction = vi.fn();

    await repairPendingSolanaActivity(
      deps({ getSignatureStatuses: vi.fn(async () => statusesFound(landed)), getFinalizedTransaction }),
    );

    expect(getFinalizedTransaction).not.toHaveBeenCalled();
    expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(1, "receipt_status_only_solana");
  });

  it("ignores a settlement profile whose shape this build does not recognise", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([
      candidateEvent({ walletAddress: WALLET, routeProvenance: { settlement: { v: 99, inputMint: JUP_USD } } }),
    ]);
    const getFinalizedTransaction = vi.fn();

    await repairPendingSolanaActivity(
      deps({ getSignatureStatuses: vi.fn(async () => statusesFound(landed)), getFinalizedTransaction }),
    );

    expect(getFinalizedTransaction).not.toHaveBeenCalled();
    expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(1, "receipt_status_only_solana");
  });
});

describe("isSolanaSweepCandidateDue — flat 30s gate (replaces the escalating backoff)", () => {
  const now = Date.parse("2026-07-24T12:00:00.000Z");
  const submitAttemptedAt = "2026-07-24T10:00:00.000Z";

  it("is due when never checked", () => {
    expect(isSolanaSweepCandidateDue({ submitAttemptedAt, lastCheckedAt: null }, now)).toBe(true);
  });

  it("is due at exactly the interval, and not one millisecond before", () => {
    expect(SOLANA_SWEEP_DUE_INTERVAL_MS).toBe(30_000);
    const at = (ms: number): boolean =>
      isSolanaSweepCandidateDue(
        { submitAttemptedAt, lastCheckedAt: new Date(now - ms).toISOString() },
        now,
      );
    expect(at(30_000)).toBe(true);
    expect(at(29_999)).toBe(false);
  });

  it("does NOT back off for an old row — a 4-hour-old row is still due every 30s", () => {
    expect(
      isSolanaSweepCandidateDue(
        {
          submitAttemptedAt: new Date(now - 5 * 3_600_000).toISOString(),
          lastCheckedAt: new Date(now - 31_000).toISOString(),
        },
        now,
      ),
    ).toBe(true);
  });

  it("is never due without a submit attempt", () => {
    expect(isSolanaSweepCandidateDue({ submitAttemptedAt: null, lastCheckedAt: null }, now)).toBe(false);
  });
});

describe("isSolanaSweepEscalated", () => {
  const now = Date.parse("2026-07-24T12:00:00.000Z");

  it("escalates (logs only) past four hours, never terminalizes", () => {
    expect(isSolanaSweepEscalated({ submitAttemptedAt: new Date(now - 5 * 3_600_000).toISOString() }, now)).toBe(true);
    expect(isSolanaSweepEscalated({ submitAttemptedAt: new Date(now - 60_000).toISOString() }, now)).toBe(false);
  });
});
