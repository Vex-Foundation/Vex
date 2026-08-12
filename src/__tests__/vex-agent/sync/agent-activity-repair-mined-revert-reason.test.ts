/**
 * The EVM repair sweep's mined-revert reason must be true for the row it
 * finalizes.
 *
 * `repairPendingActivity` finalizes ANY pending `eip155` row whose receipt came
 * back reverted — a swap, an approve, a bridge deposit, a Vex fee transfer. It
 * recorded the same `"mined revert (repair sweep receipt lookup)"` for all of
 * them: a sentence that names the code path which noticed rather than what
 * happened, and one an agent cannot act on.
 *
 * Unlike the venue handlers, this sweep is not holding a swap plan — it has
 * only the row. So it says the swap-specific thing ONLY for a `swap` row, and
 * for everything else stays deliberately role-NEUTRAL: gas was spent, the
 * operation did not take effect, no decoded reason. Naming an approval remedy
 * for a `bridge_deposit` row would be the same defect in the other direction.
 *
 * Mocked-dependency unit test (no DB, no signer) — the DB-level behavior of the
 * sweep is covered by `src/__tests__/integration/agent-scan/repair-sweep.int.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

const mockClaimDuePendingEvm = vi.fn();
const mockFailActivityEvent = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  claimDuePendingEvm: (...args: unknown[]) => mockClaimDuePendingEvm(...args),
  confirmActivityEvent: vi.fn(),
  confirmActivityEventStatusOnly: vi.fn(),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
  touchLastChecked: vi.fn(),
  clearVerificationStall: vi.fn(),
  notePendingReason: vi.fn(),
  noteNonInclusionObserved: vi.fn(),
  clearNonInclusionClock: vi.fn(),
  markSupersededUnproven: vi.fn(),
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

const { repairPendingActivity } = await import("@vex-agent/sync/agent-activity-repair.js");

function pendingRow(eventRole: AgentActivityEvent["eventRole"]): AgentActivityEvent {
  return {
    id: 1, protocolExecutionId: 42, eventIndex: 0, eventRole, recordVersion: 1,
    kind: "swap", protocol: "kyberswap", chainId: 8453, chainSlug: "base",
    status: "pending", failureCode: null, failureReason: null,
    tokenInAddress: "0xIN", tokenInSymbol: "USDC", tokenInDecimals: 6,
    amountInHuman: "10", amountInRaw: "10000000",
    tokenOutAddress: "0xOUT", tokenOutSymbol: "WETH", tokenOutDecimals: 18,
    amountOutHuman: null, amountOutRaw: null,
    executedAmountInHuman: null, executedAmountInRaw: null,
    executedAmountOutHuman: null, executedAmountOutRaw: null,
    // Second-leg columns (migration 053): absent on a single-leg swap, but
    // required by the live contract, so they are stated rather than omitted.
    tokenIn2Address: null, tokenIn2Symbol: null, tokenIn2Decimals: null,
    amountIn2Human: null, amountIn2Raw: null,
    executedAmountIn2Human: null, executedAmountIn2Raw: null,
    tokenOut2Address: null, tokenOut2Symbol: null, tokenOut2Decimals: null,
    amountOut2Human: null, amountOut2Raw: null,
    executedAmountOut2Human: null, executedAmountOut2Raw: null,
    usdInEst: null, usdOutEst: null, usdFeeEst: null, usdSource: null,
    usdNetworkGasEst: null, usdVenueFeeEst: null, usdDestinationPrepayEst: null, usdVexFeeEst: null,
    vexFeeTokenAddress: null, vexFeeTokenSymbol: null, vexFeeTokenDecimals: null,
    vexFeeAmountRaw: null, vexFeeAmountHuman: null,
    txHash: "0xHASH", fromAddress: "0xFROM", nonce: 1,
    walletAddress: "0xWALLET", sessionId: "00000000-0000-4000-8000-000000000001",
    routeProvenance: null,
    fromChainId: null, fromChainSlug: null, toChainId: null, toChainSlug: null,
    chainFamily: "eip155", providerOrderId: null, normalizedRoute: null,
    providerStatus: null, evidenceSource: null, observedAt: null, lastAttemptedAt: null,
    submitAttemptedAt: "2026-07-23T09:00:00.000Z",
    recentBlockhash: null, lastValidBlockHeight: null,
    broadcastAt: "2026-07-23T09:00:01.000Z",
    confirmedAt: null, settledBlockTime: null, lastCheckedAt: null,
    createdAt: "2026-07-23T09:00:00.000Z", updatedAt: "2026-07-23T09:00:01.000Z",
    // Columns the live contract requires that this fixture never exercises.
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
}

/** Run one sweep over a single reverted row of the given role, return its reason. */
async function sweepReasonFor(eventRole: AgentActivityEvent["eventRole"]): Promise<string> {
  mockClaimDuePendingEvm.mockResolvedValueOnce({
    claimed: [{ row: pendingRow(eventRole), claimToken: "3b9a0000-0000-4000-8000-000000000009" }],
    overflowDue: 0,
    oldestUnclaimedWaitMs: null,
  });
  const result = await repairPendingActivity({
    observeTransaction: vi.fn().mockResolvedValue({ kind: "mined", status: "reverted" }),
  });
  expect(result.failed).toBe(1);
  const call = mockFailActivityEvent.mock.calls.at(-1);
  if (!call) throw new Error("failActivityEvent was not called");
  return (call[1] as { failureReason: string }).failureReason;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFailActivityEvent.mockResolvedValue({ applied: true, row: {} });
});

describe("agent-activity repair sweep — the mined-revert reason it persists", () => {
  it("a swap row gets the price-guard remedy, named by parameter", async () => {
    const reason = await sweepReasonFor("swap");

    expect(reason).toContain("mined revert: the transaction was included on-chain and reverted");
    expect(reason).toContain("gas was spent and nothing was swapped");
    expect(reason).toContain("re-quote and retry with a higher slippageBps");
    expect(reason).toContain("The node returned no decoded reason.");
  });

  it("an allowance row gets a role-NEUTRAL reason — the sweep never claims a swap remedy", async () => {
    const reason = await sweepReasonFor("allowance");

    expect(reason).toContain("mined revert: the transaction was included on-chain and reverted");
    expect(reason).toContain("the operation did not take effect");
    expect(reason).toContain("the node returned no decoded reason");
    expect(reason).not.toContain("slippageBps");
    expect(reason).not.toContain("nothing was swapped");
  });

  it("a bridge_deposit row gets the same neutral reason — no approval story either", async () => {
    const reason = await sweepReasonFor("bridge_deposit");

    expect(reason).toContain("the operation did not take effect");
    expect(reason).not.toContain("slippageBps");
    expect(reason).not.toContain("approval");
  });

  it("a bridge_fee row is neutral too — the sweep has no venue knowledge to spend", async () => {
    const reason = await sweepReasonFor("bridge_fee");

    expect(reason).toContain("the operation did not take effect");
    expect(reason).not.toContain("slippageBps");
  });

  it("never names the code path that noticed the revert", async () => {
    expect(await sweepReasonFor("swap")).not.toContain("repair sweep receipt lookup");
    expect(await sweepReasonFor("allowance")).not.toContain("repair sweep receipt lookup");
  });
});
