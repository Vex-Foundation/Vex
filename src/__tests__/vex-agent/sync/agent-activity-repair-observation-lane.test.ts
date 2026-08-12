/**
 * THE PENDING-FALLBACK LANE'S PER-ROW POLICY — what one observation is allowed
 * to write, and under whose claim.
 *
 * Three contracts are pinned here, and each one has a concrete failure it
 * prevents:
 *
 * 1. **EVERY POST-RPC WRITE CARRIES THE CLAIM TOKEN.** The lane's writes happen
 *    AFTER the claim transaction committed and its row lock was released, so a
 *    worker whose lease expired mid-observation could otherwise stamp a stale
 *    observation over a fresher one. The fence is the token, and the R1 boundary
 *    adjudication is explicit that the claim resolver ALWAYS passes
 *    `{kind:"claim", claimToken}` to `notePendingReason` — `handler_return` must
 *    never carry the token predicate. R1's own tests pin the WRITER side; these
 *    pin the CALL side, which is the half a writer test cannot see.
 *
 * 2. **OBSERVE-ONLY INSIDE THE 90 s MONEY GATE.** The lane now looks from age
 *    ZERO, which is the whole point of a 5 s cadence — but inside the handler
 *    window the owning handler may still be decoding its own receipt, and a
 *    status-only confirm that wins that CAS forfeits the executed amounts
 *    permanently. So inside the window the lane records what it saw and runs NO
 *    status CAS at all.
 *
 * 3. **A CONCLUSIVE OBSERVATION IS NOT A FAILED CHECK.** `in_mempool` resets the
 *    stall counter (we looked and learned something definite) and clears the A6
 *    non-inclusion clock; only "we could not conclude" increments.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import type { EvmObservation } from "@vex-agent/sync/agent-activity-repair/observation.js";

const mockConfirmStatusOnly = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockTouchLastChecked = vi.fn();
const mockClearVerificationStall = vi.fn();
const mockNotePendingReason = vi.fn();
const mockNoteNonInclusion = vi.fn();
const mockClearNonInclusionClock = vi.fn();
const mockMarkSuperseded = vi.fn();
const mockReleaseClaim = vi.fn();
const mockClaim = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  confirmActivityEventStatusOnly: (...a: unknown[]) => mockConfirmStatusOnly(...a),
  failActivityEvent: (...a: unknown[]) => mockFailActivityEvent(...a),
  touchLastChecked: (...a: unknown[]) => mockTouchLastChecked(...a),
  clearVerificationStall: (...a: unknown[]) => mockClearVerificationStall(...a),
  notePendingReason: (...a: unknown[]) => mockNotePendingReason(...a),
  noteNonInclusionObserved: (...a: unknown[]) => mockNoteNonInclusion(...a),
  clearNonInclusionClock: (...a: unknown[]) => mockClearNonInclusionClock(...a),
  markSupersededUnproven: (...a: unknown[]) => mockMarkSuperseded(...a),
  releaseEvmClaim: (...a: unknown[]) => mockReleaseClaim(...a),
  claimDuePendingEvm: (...a: unknown[]) => mockClaim(...a),
  nextEvmCheckInMs: () => 5_000,
  EVM_CLAIM_LIMIT: 25,
  EVM_CLAIM_LEASE_MS: 30_000,
  NONINCLUSION_TERMINALIZE_AFTER_MS: 600_000,
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { resolveEvmPendingRow, repairPendingActivity } = await import(
  "@vex-agent/sync/agent-activity-repair.js",
);

const CLAIM_TOKEN = "7f1c2e3a-0000-4000-8000-000000000001";

function row(over: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    id: 42,
    eventRole: "swap",
    protocol: "kyberswap",
    chainId: 4663,
    status: "pending",
    txHash: "0x24501ef985a280e3c1a81526264dac1cb950ba437a83d9143c25dc55aab83415",
    fromAddress: "0x1111111111111111111111111111111111111111",
    nonce: 7,
    ...over,
  } as AgentActivityEvent;
}

/** A dep whose single look returns exactly the observation under test. */
function depsReturning(observation: EvmObservation) {
  return { observeTransaction: vi.fn().mockResolvedValue(observation) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfirmStatusOnly.mockResolvedValue({ applied: true, row: row({ status: "confirmed" }) });
  mockFailActivityEvent.mockResolvedValue({ applied: true, row: row({ status: "definitively_failed" }) });
  mockNotePendingReason.mockResolvedValue({ applied: true });
  mockMarkSuperseded.mockResolvedValue({ applied: false, row: row(), reason: "window_not_elapsed" });
});

describe("the lane's post-RPC writes are all fenced by the claim token", () => {
  it("passes {kind:'claim', claimToken} to notePendingReason — never handler_return", async () => {
    await resolveEvmPendingRow(row(), depsReturning({ kind: "in_mempool" }), {
      claimToken: CLAIM_TOKEN,
      allowTerminalize: true,
    });

    expect(mockNotePendingReason).toHaveBeenCalledWith(42, "in_mempool", {
      kind: "claim",
      claimToken: CLAIM_TOKEN,
    });
  });

  it("passes the token to the bookkeeping writers and to the release", async () => {
    await resolveEvmPendingRow(row(), depsReturning({ kind: "rpc_error", reason: "scrubbed" }), {
      claimToken: CLAIM_TOKEN,
      allowTerminalize: true,
    });

    expect(mockTouchLastChecked).toHaveBeenCalledWith(42, "rpc_error", CLAIM_TOKEN);
    expect(mockReleaseClaim).toHaveBeenCalledWith(42, CLAIM_TOKEN);
  });
});

describe("the 90 s money gate — observe-only inside the window", () => {
  it("does NOT confirm a mined-success row inside the window", async () => {
    const outcome = await resolveEvmPendingRow(row(), depsReturning({ kind: "mined", status: "success", blockTimeIso: null }), {
      claimToken: CLAIM_TOKEN,
      allowTerminalize: false,
    });

    expect(mockConfirmStatusOnly).not.toHaveBeenCalled();
    expect(outcome).toBe("pending");
  });

  it("does NOT fail a mined-revert row inside the window", async () => {
    await resolveEvmPendingRow(row(), depsReturning({ kind: "mined", status: "reverted", blockTimeIso: null }), {
      claimToken: CLAIM_TOKEN,
      allowTerminalize: false,
    });

    expect(mockFailActivityEvent).not.toHaveBeenCalled();
  });

  it("confirms once the window has passed", async () => {
    const outcome = await resolveEvmPendingRow(row(), depsReturning({ kind: "mined", status: "success", blockTimeIso: null }), {
      claimToken: CLAIM_TOKEN,
      allowTerminalize: true,
    });

    // Fenced, like every other post-RPC write — pinned in full below.
    expect(mockConfirmStatusOnly).toHaveBeenCalledWith(42, "receipt_status_only_evm", {
      kind: "claim",
      claimToken: CLAIM_TOKEN,
    });
    expect(outcome).toBe("confirmed");
  });

  it("never attempts the A6 terminalization inside the window", async () => {
    await resolveEvmPendingRow(row(), depsReturning({ kind: "nonce_superseded" }), {
      claimToken: CLAIM_TOKEN,
      allowTerminalize: false,
    });

    expect(mockMarkSuperseded).not.toHaveBeenCalled();
  });
});

describe("a conclusive observation is not a failed check", () => {
  it("in_mempool resets the stall counter and clears the A6 clock", async () => {
    await resolveEvmPendingRow(row(), depsReturning({ kind: "in_mempool" }), {
      claimToken: CLAIM_TOKEN,
      allowTerminalize: true,
    });

    expect(mockClearVerificationStall).toHaveBeenCalledWith(42, CLAIM_TOKEN);
    expect(mockClearNonInclusionClock).toHaveBeenCalledWith(42, CLAIM_TOKEN);
    expect(mockTouchLastChecked).not.toHaveBeenCalled();
  });

  it("tx_unknown_to_node is INCONCLUSIVE — it increments and starts the A6 clock", async () => {
    await resolveEvmPendingRow(row(), depsReturning({ kind: "unknown_to_node" }), {
      claimToken: CLAIM_TOKEN,
      allowTerminalize: true,
    });

    expect(mockTouchLastChecked).toHaveBeenCalledWith(42, "tx_unknown_to_node", CLAIM_TOKEN);
    expect(mockNoteNonInclusion).toHaveBeenCalledWith(42, CLAIM_TOKEN);
    expect(mockClearVerificationStall).not.toHaveBeenCalled();
  });

  it("an unreadable receipt is a CONTRARY observation — the A6 clock is cleared, and it is never a revert", async () => {
    await resolveEvmPendingRow(row(), depsReturning({ kind: "unreadable_receipt" }), {
      claimToken: CLAIM_TOKEN,
      allowTerminalize: true,
    });

    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(mockTouchLastChecked).toHaveBeenCalledWith(42, "unreadable_receipt_status", CLAIM_TOKEN);
    expect(mockClearNonInclusionClock).toHaveBeenCalledWith(42, CLAIM_TOKEN);
  });
});

describe("the A6 terminalization", () => {
  it("records the evidence and attempts the CAS once the window is open", async () => {
    mockMarkSuperseded.mockResolvedValue({ applied: true, row: row({ status: "superseded_unproven" }) });

    const outcome = await resolveEvmPendingRow(row(), depsReturning({ kind: "nonce_superseded" }), {
      claimToken: CLAIM_TOKEN,
      allowTerminalize: true,
    });

    expect(mockNotePendingReason).toHaveBeenCalledWith(42, "nonce_superseded", {
      kind: "claim",
      claimToken: CLAIM_TOKEN,
    });
    expect(mockMarkSuperseded).toHaveBeenCalledWith(
      42,
      { claimToken: CLAIM_TOKEN, reason: "nonce_superseded" },
      expect.any(Number),
    );
    expect(outcome).toBe("superseded");
  });

  it("a refused CAS leaves the row pending — never a failure, never a retry loop", async () => {
    const outcome = await resolveEvmPendingRow(row(), depsReturning({ kind: "nonce_superseded" }), {
      claimToken: CLAIM_TOKEN,
      allowTerminalize: true,
    });

    expect(outcome).toBe("pending");
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
  });

  it("a terminalized row is NOT released — the CAS already cleared the claim", async () => {
    mockMarkSuperseded.mockResolvedValue({ applied: true, row: row({ status: "superseded_unproven" }) });

    await resolveEvmPendingRow(row(), depsReturning({ kind: "nonce_superseded" }), {
      claimToken: CLAIM_TOKEN,
      allowTerminalize: true,
    });

    expect(mockReleaseClaim).not.toHaveBeenCalled();
  });
});

describe("supersession is never inferred", () => {
  it("passes the row's OWN persisted from/nonce to the observation, nulls included", async () => {
    const deps = depsReturning({ kind: "unknown_to_node" });
    await resolveEvmPendingRow(row({ fromAddress: null, nonce: null }), deps, {
      claimToken: CLAIM_TOKEN,
      allowTerminalize: true,
    });

    expect(deps.observeTransaction).toHaveBeenCalledWith({
      chainId: 4663,
      txHash: row().txHash,
      fromAddress: null,
      nonce: null,
    });
  });
});

describe("the MINED paths are fenced too — the adjudicated counterexample", () => {
  /**
   * The exact race the fence exists for, on the arm that matters most: a worker
   * whose lease expired mid-RPC returns holding a STALE token while a second
   * worker has legitimately re-claimed the row. If the terminal CAS runs
   * unfenced, the stale worker wins the once-only `WHERE status='pending'`
   * transition with a STATUS-ONLY confirm — locking out the strict
   * confirm-with-amounts the live holder was about to write, and recreating the
   * `confirmed + estimated + executedAmount* null` row this whole wave exists to
   * fix. The 90 s gate does not cover it: by then the window is long past.
   */
  it("passes the claim context to the status-only confirm on mined success", async () => {
    await resolveEvmPendingRow(row(), depsReturning({ kind: "mined", status: "success", blockTimeIso: null }), {
      claimToken: CLAIM_TOKEN,
      allowTerminalize: true,
    });

    expect(mockConfirmStatusOnly).toHaveBeenCalledWith(42, "receipt_status_only_evm", {
      kind: "claim",
      claimToken: CLAIM_TOKEN,
    });
  });

  it("passes the claim context to the failure CAS on mined revert", async () => {
    await resolveEvmPendingRow(row(), depsReturning({ kind: "mined", status: "reverted", blockTimeIso: null }), {
      claimToken: CLAIM_TOKEN,
      allowTerminalize: true,
    });

    expect(mockFailActivityEvent).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ failureCode: "mined_revert" }),
      { kind: "claim", claimToken: CLAIM_TOKEN },
    );
  });

  it("a LOST claim on the confirm arm is surfaced, never retried blind", async () => {
    mockConfirmStatusOnly.mockResolvedValue({
      applied: false,
      row: row({ status: "pending" }),
      reason: "claim_lost",
    });

    const outcome = await resolveEvmPendingRow(
      row(),
      depsReturning({ kind: "mined", status: "success", blockTimeIso: null }),
      { claimToken: CLAIM_TOKEN, allowTerminalize: true },
    );

    // NOT "confirmed": this worker wrote nothing. The row stays pending for the
    // holder that actually owns it, and nothing here re-attempts the CAS.
    expect(outcome).toBe("claim_lost");
    expect(mockConfirmStatusOnly).toHaveBeenCalledTimes(1);
  });

  it("a LOST claim on the revert arm is surfaced, never retried blind", async () => {
    mockFailActivityEvent.mockResolvedValue({
      applied: false,
      row: row({ status: "pending" }),
      reason: "claim_lost",
    });

    const outcome = await resolveEvmPendingRow(
      row(),
      depsReturning({ kind: "mined", status: "reverted", blockTimeIso: null }),
      { claimToken: CLAIM_TOKEN, allowTerminalize: true },
    );

    expect(outcome).toBe("claim_lost");
    expect(mockFailActivityEvent).toHaveBeenCalledTimes(1);
  });
});

describe("a lost claim is reported ONCE", () => {
  /**
   * One lost claim was producing three `sync.evm_claim.lost` events: the writer's
   * own `terminalMiss` (which observes the zero-row result and is the right
   * owner), this resolver re-reporting it, and then a release that could not
   * succeed either — because we do not hold the claim, which is the whole point.
   *
   * Three events for one fact makes the log read like three problems, and the
   * release is not merely noisy: it is a pointless write on every lost claim.
   */
  it("does not re-log, and does not attempt a release it cannot win", async () => {
    const logger = (await import("@utils/logger.js")).default;
    mockConfirmStatusOnly.mockResolvedValue({
      applied: false,
      row: row({ status: "pending" }),
      reason: "claim_lost",
    });

    const outcome = await resolveEvmPendingRow(
      row(),
      depsReturning({ kind: "mined", status: "success", blockTimeIso: null }),
      { claimToken: CLAIM_TOKEN, allowTerminalize: true },
    );

    expect(outcome).toBe("claim_lost");
    // The writer already said it; this layer adds nothing.
    const lostLogs = vi.mocked(logger.debug).mock.calls.filter(
      (call: readonly unknown[]) => call[0] === "sync.evm_claim.lost",
    );
    expect(lostLogs).toHaveLength(0);
    expect(mockReleaseClaim).not.toHaveBeenCalled();
  });

  it("still counts as a pending row for the sweep's accounting", async () => {
    mockClaim.mockResolvedValue({
      claimed: [{ row: row(), claimToken: CLAIM_TOKEN }],
      overflowDue: 0,
      oldestUnclaimedWaitMs: null,
    });
    mockConfirmStatusOnly.mockResolvedValue({
      applied: false,
      row: row({ status: "pending" }),
      reason: "claim_lost",
    });

    const result = await repairPendingActivity(
      depsReturning({ kind: "mined", status: "success", blockTimeIso: null }),
    );

    expect(result).toMatchObject({ checked: 1, confirmed: 0, failed: 0, stillPending: 1 });
  });
});

describe("the A6 arm preserves a lost claim too", () => {
  /**
   * The last place `claim_lost` was still collapsed into `pending`. The A6 CAS
   * is claim-fenced like every other post-RPC write, so a stale worker's
   * terminalization attempt writes zero rows — and reporting that as `pending`
   * put the row straight back through the redundant release and the second log
   * the `claim_lost` member exists to prevent.
   *
   * Same semantics as the mined arms: no release, no retry, one event.
   */
  it("reports claim_lost when a stale token attempts the A6 terminalization", async () => {
    const logger = (await import("@utils/logger.js")).default;
    mockMarkSuperseded.mockResolvedValue({
      applied: false,
      row: row({ status: "pending" }),
      reason: "claim_lost",
    });

    const outcome = await resolveEvmPendingRow(
      row(),
      depsReturning({ kind: "nonce_superseded" }),
      { claimToken: CLAIM_TOKEN, allowTerminalize: true },
    );

    expect(outcome).toBe("claim_lost");
    expect(mockReleaseClaim).not.toHaveBeenCalled();
    // The CAS itself already emitted the event; this layer adds nothing.
    const lostLogs = vi.mocked(logger.debug).mock.calls.filter(
      (call: readonly unknown[]) => call[0] === "sync.evm_claim.lost",
    );
    expect(lostLogs).toHaveLength(0);
  });

  it("still reports a WINDOW refusal as pending — that row is genuinely ours and still in flight", async () => {
    mockMarkSuperseded.mockResolvedValue({
      applied: false,
      row: row({ status: "pending" }),
      reason: "window_not_elapsed",
    });

    const outcome = await resolveEvmPendingRow(
      row(),
      depsReturning({ kind: "nonce_superseded" }),
      { claimToken: CLAIM_TOKEN, allowTerminalize: true },
    );

    // We DO hold this claim, so the release must happen exactly as before.
    expect(outcome).toBe("pending");
    expect(mockReleaseClaim).toHaveBeenCalledWith(42, CLAIM_TOKEN);
  });
});
