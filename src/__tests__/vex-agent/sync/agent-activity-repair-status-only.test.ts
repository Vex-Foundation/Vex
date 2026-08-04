/**
 * The EVM repair sweep is a STATUS-ONLY resolver (owner decree 2026-07-30).
 *
 * It answers exactly one question per pending row — did this tx hash succeed or
 * revert on its chain? — and writes the status alone. No settlement decoder, no
 * protocol knowledge, no amounts. The trigger case was a KyberSwap CAT→native
 * ETH swap on Robinhood Chain (4663) that was mined `success` on-chain but sat
 * `pending` forever because the per-protocol decoder declined that receipt
 * shape; a status-only sweep has nothing to decline.
 *
 * Unchanged and re-pinned here: a mined revert is still the ONE definitive
 * failure path, and ambiguity (no receipt / lookup error) NEVER terminalizes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import logger from "@utils/logger.js";
import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

const mockClaimDuePendingEvm = vi.fn();
const mockConfirmActivityEvent = vi.fn();
const mockConfirmActivityEventStatusOnly = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockTouchLastChecked = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  claimDuePendingEvm: (...args: unknown[]) => mockClaimDuePendingEvm(...args),
  confirmActivityEvent: (...args: unknown[]) => mockConfirmActivityEvent(...args),
  confirmActivityEventStatusOnly: (...args: unknown[]) => mockConfirmActivityEventStatusOnly(...args),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
  touchLastChecked: (...args: unknown[]) => mockTouchLastChecked(...args),
  clearVerificationStall: vi.fn(),
  notePendingReason: vi.fn(),
  noteNonInclusionObserved: vi.fn(),
  clearNonInclusionClock: vi.fn(),
  markSupersededUnproven: vi.fn().mockResolvedValue({ applied: false, row: {}, reason: "window_not_elapsed" }),
  releaseEvmClaim: vi.fn(),
  EVM_CLAIM_LIMIT: 25,
  nextEvmCheckInMs: () => 5_000,
  EVM_CLAIM_LEASE_MS: 30_000,
  NONINCLUSION_TERMINALIZE_AFTER_MS: 600_000,
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { repairPendingActivity, REPAIR_CANDIDATE_AGE_MS, REPAIR_BATCH_LIMIT } = await import(
  "@vex-agent/sync/agent-activity-repair.js"
);

function candidate(over: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    id: 1,
    eventRole: "swap",
    protocol: "kyberswap",
    chainId: 4663,
    status: "pending",
    txHash: "0x24501ef985a280e3c1a81526264dac1cb950ba437a83d9143c25dc55aab83415",
    fromAddress: "0x1111111111111111111111111111111111111111",
    nonce: 7,
    // Past the 90 s handler window, so terminalization is permitted — the gate
    // itself is pinned in `agent-activity-repair-observation-lane.test.ts`.
    submitAttemptedAt: new Date(Date.now() - 600_000).toISOString(),
    ...over,
  } as AgentActivityEvent;
}

const TOKEN = "3b9a0000-0000-4000-8000-000000000009";

/** Deps whose single look always returns the observation under test. */
function observing(observation: unknown) {
  return { observeTransaction: vi.fn().mockResolvedValue(observation) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfirmActivityEventStatusOnly.mockResolvedValue({ applied: true, row: candidate({ status: "confirmed" }) });
  mockFailActivityEvent.mockResolvedValue({ applied: true, row: candidate({ status: "definitively_failed" }) });
});

describe("repairPendingActivity — status-only confirm", () => {
  it("confirms a mined-success row through the status-only finalizer, with no amounts", async () => {
  mockClaimDuePendingEvm.mockResolvedValueOnce({
    claimed: [{ row: candidate(), claimToken: TOKEN }],
    overflowDue: 0,
    oldestUnclaimedWaitMs: null,
  });

    const result = await repairPendingActivity(observing({ kind: "mined", status: "success" }));

    // FENCED: the mined paths are post-RPC writes like every other, so they
    // carry the claim token. An unfenced confirm here is the adjudicated
    // counterexample — a stale worker locking out the live holder's strict
    // confirm-with-amounts.
    expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(
      1,
      "receipt_status_only_evm",
      { kind: "claim", claimToken: TOKEN },
    );
    expect(mockConfirmActivityEvent).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, confirmed: 1, failed: 0, stillPending: 0 });
  });

  it("claims through the ONE phase-aware claimant, bounded by the 25-row SLA", async () => {
    mockClaimDuePendingEvm.mockResolvedValueOnce({ claimed: [], overflowDue: 0, oldestUnclaimedWaitMs: null });

    await repairPendingActivity(observing({ kind: "unknown_to_node" }));

    // The 90 s age is no longer a CANDIDACY filter — it gates terminalization
    // instead, so a fresh row is observable at 5 s while the money gate stands.
    expect(REPAIR_CANDIDATE_AGE_MS).toBe(90_000);
    expect(mockClaimDuePendingEvm).toHaveBeenCalledWith(REPAIR_BATCH_LIMIT);
  });

  it("still terminalizes a mined revert, and only that", async () => {
  mockClaimDuePendingEvm.mockResolvedValueOnce({
    claimed: [{ row: candidate(), claimToken: TOKEN }],
    overflowDue: 0,
    oldestUnclaimedWaitMs: null,
  });

    const result = await repairPendingActivity(observing({ kind: "mined", status: "reverted" }));

    expect(mockFailActivityEvent).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ failureCode: "mined_revert" }),
      { kind: "claim", claimToken: TOKEN },
    );
    expect(result.failed).toBe(1);
  });

  it("never terminalizes ambiguity — a hash no node knows only touches last_checked_at", async () => {
  mockClaimDuePendingEvm.mockResolvedValueOnce({
    claimed: [{ row: candidate(), claimToken: TOKEN }],
    overflowDue: 0,
    oldestUnclaimedWaitMs: null,
  });

    const result = await repairPendingActivity(observing({ kind: "unknown_to_node" }));

    expect(mockTouchLastChecked).toHaveBeenCalledWith(1, "tx_unknown_to_node", TOKEN);
    expect(mockConfirmActivityEventStatusOnly).not.toHaveBeenCalled();
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, confirmed: 0, failed: 0, stillPending: 1 });
  });

  it("an unreadable receipt status never terminalizes — the row is touched and stays pending", async () => {
  mockClaimDuePendingEvm.mockResolvedValueOnce({
    claimed: [{ row: candidate(), claimToken: TOKEN }],
    overflowDue: 0,
    oldestUnclaimedWaitMs: null,
  });

    // A receipt EXISTS but its status is a value we cannot read. Reporting that
    // as a revert would be an irreversible claim beyond the evidence.
    const result = await repairPendingActivity(observing({ kind: "unreadable_receipt" }));

    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(mockTouchLastChecked).toHaveBeenCalledWith(1, "unreadable_receipt_status", TOKEN);
    expect(result).toEqual({ checked: 1, confirmed: 0, failed: 0, stillPending: 1 });
  });

  it("rotates the row when the lookup could not conclude, so the batch window does not stall", async () => {
    // Fairness contract: the claim orders by `last_checked_at` under a LIMIT, so
    // a row we keep failing to observe must move to the back of the queue rather
    // than pinning the window. Nothing is learned and nothing is terminalized.
  mockClaimDuePendingEvm.mockResolvedValueOnce({
    claimed: [{ row: candidate(), claimToken: TOKEN }],
    overflowDue: 0,
    oldestUnclaimedWaitMs: null,
  });

    const result = await repairPendingActivity(observing({ kind: "rpc_error", reason: "scrubbed" }));

    expect(mockTouchLastChecked).toHaveBeenCalledWith(1, "rpc_error", TOKEN);
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(mockConfirmActivityEventStatusOnly).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, confirmed: 0, failed: 0, stillPending: 1 });
  });

  it("logs a duplicate CAS miss instead of double-counting a concurrent confirm", async () => {
  mockClaimDuePendingEvm.mockResolvedValueOnce({
    claimed: [{ row: candidate(), claimToken: TOKEN }],
    overflowDue: 0,
    oldestUnclaimedWaitMs: null,
  });
    mockConfirmActivityEventStatusOnly.mockResolvedValueOnce({
      applied: false,
      row: candidate({ status: "confirmed" }),
    });

    const result = await repairPendingActivity(observing({ kind: "mined", status: "success" }));

    expect(logger.info).toHaveBeenCalledWith(
      "agent_activity.repair.duplicate_cas_miss",
      { id: 1, attempted: "confirm" },
    );
    expect(result).toEqual({ checked: 1, confirmed: 0, failed: 0, stillPending: 0 });
  });
});
