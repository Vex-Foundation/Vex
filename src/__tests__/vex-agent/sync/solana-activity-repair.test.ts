/**
 * `solana-activity-repair` — the STATUS-ONLY Solana sweep (owner decree
 * 2026-07-30), pure orchestration over the injected `SolanaActivitySweepDeps`
 * port. Mocked-DB unit test (mock the whole
 * `@vex-agent/db/repos/agent-activity.js` module; inject fake RPC deps).
 *
 * Pins the terminality table, which is the whole product now:
 *   - `confirmed`/`finalized` + `err == null`  → `confirmed`, status-only, NO
 *     amounts and NO transaction-body fetch (there is nothing left to learn);
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

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import type {
  SolanaActivitySweepDeps,
  SolanaSignatureStatusValue,
} from "@vex-agent/sync/solana-activity-repair.js";

const mockListSolanaStagedPending = vi.fn();
const mockConfirmActivityEventStatusOnly = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockTouchLastChecked = vi.fn();
const mockClearVerificationStall = vi.fn();
const mockRecoverStaleHashlessIntents = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  listSolanaStagedPending: (...args: unknown[]) => mockListSolanaStagedPending(...args),
  confirmActivityEvent: vi.fn(),
  confirmActivityEventStatusOnly: (...args: unknown[]) => mockConfirmActivityEventStatusOnly(...args),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
  touchLastChecked: (...args: unknown[]) => mockTouchLastChecked(...args),
  clearVerificationStall: (...args: unknown[]) => mockClearVerificationStall(...args),
  recoverStaleHashlessIntents: (...args: unknown[]) => mockRecoverStaleHashlessIntents(...args),
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

function candidateEvent(overrides: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
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
    createdAt: "2026-07-24T09:59:00.000Z",
    updatedAt: "2026-07-24T10:00:01.000Z",
    ...overrides,
  };
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

      expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(1);
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

    expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(1);
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

    expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(1);
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
