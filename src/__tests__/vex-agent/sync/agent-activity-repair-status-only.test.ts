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

const mockListPendingOlderThan = vi.fn();
const mockConfirmActivityEvent = vi.fn();
const mockConfirmActivityEventStatusOnly = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockTouchLastChecked = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  listPendingOlderThan: (...args: unknown[]) => mockListPendingOlderThan(...args),
  confirmActivityEvent: (...args: unknown[]) => mockConfirmActivityEvent(...args),
  confirmActivityEventStatusOnly: (...args: unknown[]) => mockConfirmActivityEventStatusOnly(...args),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
  touchLastChecked: (...args: unknown[]) => mockTouchLastChecked(...args),
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
    ...over,
  } as AgentActivityEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfirmActivityEventStatusOnly.mockResolvedValue({ applied: true, row: candidate({ status: "confirmed" }) });
  mockFailActivityEvent.mockResolvedValue({ applied: true, row: candidate({ status: "definitively_failed" }) });
});

describe("repairPendingActivity — status-only confirm", () => {
  it("confirms a mined-success row through the status-only finalizer, with no amounts", async () => {
    mockListPendingOlderThan.mockResolvedValueOnce([candidate()]);

    const result = await repairPendingActivity({
      checkReceiptByHash: vi.fn().mockResolvedValueOnce({ status: "success" }),
    });

    expect(mockConfirmActivityEventStatusOnly).toHaveBeenCalledWith(1);
    expect(mockConfirmActivityEvent).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, confirmed: 1, failed: 0, stillPending: 0 });
  });

  it("keeps the candidate window: 90s minimum age, batch of 25, EVM rows only", async () => {
    mockListPendingOlderThan.mockResolvedValueOnce([]);
    await repairPendingActivity({ checkReceiptByHash: vi.fn() });
    expect(REPAIR_CANDIDATE_AGE_MS).toBe(90_000);
    expect(mockListPendingOlderThan).toHaveBeenCalledWith(90_000, REPAIR_BATCH_LIMIT, "eip155");
  });

  it("still terminalizes a mined revert, and only that", async () => {
    mockListPendingOlderThan.mockResolvedValueOnce([candidate()]);

    const result = await repairPendingActivity({
      checkReceiptByHash: vi.fn().mockResolvedValueOnce({ status: "reverted" }),
    });

    expect(mockFailActivityEvent).toHaveBeenCalledWith(1, expect.objectContaining({ failureCode: "mined_revert" }));
    expect(result.failed).toBe(1);
  });

  it("never terminalizes ambiguity — a missing receipt only touches last_checked_at", async () => {
    mockListPendingOlderThan.mockResolvedValueOnce([candidate()]);

    const result = await repairPendingActivity({
      checkReceiptByHash: vi.fn().mockResolvedValueOnce(null),
    });

    expect(mockTouchLastChecked).toHaveBeenCalledWith(1, "receipt_not_found");
    expect(mockConfirmActivityEventStatusOnly).not.toHaveBeenCalled();
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, confirmed: 0, failed: 0, stillPending: 1 });
  });

  it("an unreadable receipt status never terminalizes — the row is touched and stays pending", async () => {
    mockListPendingOlderThan.mockResolvedValueOnce([candidate()]);

    // `checkReceiptByHash` collapses an unreadable status to `null` (see the
    // production dep's own test); the sweep must then behave exactly like a
    // not-yet-mined receipt.
    const result = await repairPendingActivity({
      checkReceiptByHash: vi.fn().mockResolvedValueOnce(null),
    });

    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(mockTouchLastChecked).toHaveBeenCalledWith(1, "receipt_not_found");
    expect(result).toEqual({ checked: 1, confirmed: 0, failed: 0, stillPending: 1 });
  });

  it("rotates the row when the receipt LOOKUP THROWS, so the batch window does not stall", async () => {
    // Parity with the Solana sweep's fairness contract: `listPendingOlderThan`
    // orders by `last_checked_at` under a LIMIT, so a row whose lookup keeps
    // throwing must move to the back of the queue rather than pinning the
    // window. Nothing is learned and nothing is terminalized.
    mockListPendingOlderThan.mockResolvedValueOnce([candidate()]);

    const result = await repairPendingActivity({
      checkReceiptByHash: vi.fn().mockRejectedValueOnce(new Error("transport timeout")),
    });

    expect(mockTouchLastChecked).toHaveBeenCalledWith(1, "lookup_error");
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(mockConfirmActivityEventStatusOnly).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, confirmed: 0, failed: 0, stillPending: 1 });
  });

  it("logs a duplicate CAS miss instead of double-counting a concurrent confirm", async () => {
    mockListPendingOlderThan.mockResolvedValueOnce([candidate()]);
    mockConfirmActivityEventStatusOnly.mockResolvedValueOnce({
      applied: false,
      row: candidate({ status: "confirmed" }),
    });

    const result = await repairPendingActivity({
      checkReceiptByHash: vi.fn().mockResolvedValueOnce({ status: "success" }),
    });

    expect(logger.info).toHaveBeenCalledWith(
      "agent_activity.repair.duplicate_cas_miss",
      { id: 1, attempted: "confirm" },
    );
    expect(result).toEqual({ checked: 1, confirmed: 0, failed: 0, stillPending: 0 });
  });
});
