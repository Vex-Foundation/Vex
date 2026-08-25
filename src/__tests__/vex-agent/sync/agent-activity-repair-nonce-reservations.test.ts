/**
 * The periodic EVM observer also owns migration 091's staged legacy nonce
 * reservations. This proves observation mapping, token-fenced outcomes and the
 * shared concurrency bound without introducing a signer or submit capability.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EvmObservation,
  EvmObservationInput,
} from "@vex-agent/sync/agent-activity-repair/observation.js";

const mockClaimActivities = vi.fn(async () => ({
  claimed: [],
  overflowDue: 0,
  oldestUnclaimedWaitMs: null,
}));
const mockClaimReservations = vi.fn();
const mockTerminalizeReservation = vi.fn(async (id: number) => id !== 3);
const mockRotateReservation = vi.fn(async (id: number) => id !== 5);

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  EVM_CLAIM_LEASE_MS: 30_000,
  claimDuePendingEvm: mockClaimActivities,
  claimDueEvmNonceReservations: mockClaimReservations,
  terminalizeClaimedEvmNonceReservation: mockTerminalizeReservation,
  rotateInconclusiveEvmNonceReservation: mockRotateReservation,
}));

vi.mock("@vex-agent/db/repos/wallet-intents.js", () => ({
  listLegacyReviewCandidates: vi.fn(async () => []),
}));

vi.mock("@utils/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { EVM_LANE_MAX_CONCURRENCY, repairPendingActivity } = await import(
  "@vex-agent/sync/agent-activity-repair.js"
);

beforeEach(() => {
  vi.clearAllMocks();
});

function reservation(id: number) {
  return {
    id,
    chainId: 8453,
    fromAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
    nonce: id,
    txHash: `0x${id.toString(16).padStart(64, "0")}`,
    status: "staged" as const,
    claimToken: `00000000-0000-4000-8000-${id.toString().padStart(12, "0")}`,
  };
}

describe("EVM nonce reservation repair wiring", () => {
  it("maps conclusive and inconclusive observations without retry or rebroadcast", async () => {
    mockClaimReservations.mockResolvedValueOnce({
      claimed: [1, 2, 3, 4, 5].map(reservation),
      overflowDue: 2,
    });
    let active = 0;
    let maxActive = 0;
    const observeTransaction = vi.fn(async (
      input: EvmObservationInput,
    ): Promise<EvmObservation> => {
      if (input.nonce === null) throw new Error("reservation fixture has no nonce");
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active--;
      if (input.nonce === 1) {
        return { kind: "mined" as const, status: "success" as const, blockTimeIso: null };
      }
      if (input.nonce === 2) {
        return { kind: "mined" as const, status: "reverted" as const, blockTimeIso: null };
      }
      if (input.nonce === 3) return { kind: "nonce_superseded" as const };
      if (input.nonce === 4) return { kind: "in_mempool" as const };
      return { kind: "rpc_error" as const, reason: "scrubbed" };
    });

    const result = await repairPendingActivity(
      { observeTransaction },
      { includeAuxiliaryState: true },
    );

    expect(result).toEqual({
      checked: 0,
      confirmed: 0,
      failed: 0,
      stillPending: 0,
      nonceReservations: {
        checked: 5,
        terminalized: 2,
        inconclusive: 1,
        claimLost: 2,
        overflowDue: 2,
      },
    });
    expect(maxActive).toBeLessThanOrEqual(EVM_LANE_MAX_CONCURRENCY);
    expect(mockTerminalizeReservation.mock.calls).toEqual([
      [1, reservation(1).claimToken, "mined_success"],
      [2, reservation(2).claimToken, "mined_revert"],
      [3, reservation(3).claimToken, "nonce_superseded"],
    ]);
    expect(mockRotateReservation.mock.calls).toEqual([
      [4, reservation(4).claimToken, "in_mempool"],
      [5, reservation(5).claimToken, "rpc_error"],
    ]);
    expect(observeTransaction).toHaveBeenCalledTimes(5);
  });

  it("fast-lane/default passes do not touch auxiliary reservation state", async () => {
    const observeTransaction = vi.fn();
    const result = await repairPendingActivity({ observeTransaction });
    expect(result).toEqual({ checked: 0, confirmed: 0, failed: 0, stillPending: 0 });
    expect(mockClaimReservations).not.toHaveBeenCalled();
    expect(observeTransaction).not.toHaveBeenCalled();
  });
});
