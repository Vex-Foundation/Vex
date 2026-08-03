/**
 * `handlePostIntentFailure` — the refusal row's write failure is LOGGED.
 *
 * Finalizing the refused leg is best-effort by design: the abort that follows
 * guarantees no row strands as pending, so a failed write must not take the
 * whole failure path down with it. But it used to be swallowed by a bare
 * `catch {}`, which meant the one case where a trade's real refusal code never
 * reached its record left no trace at all — while every sibling in this
 * namespace (`execute-identity.abortRemaining`, `staged-loop`, `fee/run`) logs.
 *
 * A swallowed durable-write failure on a money path is exactly the class of
 * defect that is invisible until someone audits the rows and finds a code
 * missing with no explanation anywhere.
 */

import { describe, it, expect, vi } from "vitest";

const { failActivityEvent, abortPlannedEvents, warn } = vi.hoisted(() => ({
  failActivityEvent: vi.fn(),
  abortPlannedEvents: vi.fn(async () => undefined),
  warn: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  failActivityEvent,
  abortPlannedEvents,
  createAgentActivityPreBroadcastFailure: vi.fn(),
}));

vi.mock("@utils/logger.js", () => ({
  default: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  handlePostIntentFailure,
  type PostIntentFailureInput,
} from "@vex-agent/tools/protocols/trench/handlers/trade/failure-results.js";
import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import type { TradeLegPlan } from "@vex-agent/tools/protocols/trench/handlers/trade/plan.js";
import type { Address, Hex } from "viem";

/** A revert the pre-sign classifier recognises, so the finalizing write is attempted. */
const PRE_SIGN_REVERT = Object.assign(new Error("execution reverted"), {
  shortMessage: "Execution reverted with reason: TrenchExpress: slippage.",
});

/**
 * The durable row as the live contract declares it. Only `id` is read on this
 * path; the remaining columns are stated rather than omitted so a contract
 * change fails here instead of being silenced.
 */
function activityEvent(id: number): AgentActivityEvent {
  return {
    id, protocolExecutionId: 4242, eventIndex: 0, eventRole: "swap", recordVersion: 1,
    kind: "swap", protocol: "trench_express", chainId: 4663, chainSlug: "robinhood",
    status: "pending", failureCode: null, failureReason: null,
    tokenInAddress: "0xIN", tokenInSymbol: "ETH", tokenInDecimals: 18,
    amountInHuman: "1", amountInRaw: "1000000000000000000",
    tokenOutAddress: "0xOUT", tokenOutSymbol: "TRENCH", tokenOutDecimals: 18,
    amountOutHuman: null, amountOutRaw: null,
    executedAmountInHuman: null, executedAmountInRaw: null,
    executedAmountOutHuman: null, executedAmountOutRaw: null,
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
    txHash: null, fromAddress: null, nonce: null,
    walletAddress: "0xWALLET", sessionId: "00000000-0000-4000-8000-000000000001",
    routeProvenance: null,
    fromChainId: null, fromChainSlug: null, toChainId: null, toChainSlug: null,
    chainFamily: "eip155", providerOrderId: null, normalizedRoute: null,
    providerStatus: null, evidenceSource: null, observedAt: null, lastAttemptedAt: null,
    submitAttemptedAt: null,
    recentBlockhash: null, lastValidBlockHeight: null,
    broadcastAt: null, confirmedAt: null, lastCheckedAt: null,
    createdAt: "2026-08-02T09:00:00.000Z", updatedAt: "2026-08-02T09:00:00.000Z",
    verificationAttempts: 0, lastVerificationReason: null,
  };
}

/** Only `eventRole` is read on this path; `txParams`/`event` are the plan's real shape. */
function swapLegPlan(): TradeLegPlan {
  return {
    eventRole: "swap",
    txParams: {
      to: "0x0000000000000000000000000000000000000dEF" as Address,
      data: "0x" as Hex,
    },
    event: {
      eventRole: "swap",
      kind: "swap",
      protocol: "trench_express",
      chainId: 4663,
      walletAddress: "0xWALLET",
      sessionId: "00000000-0000-4000-8000-000000000001",
    },
  };
}

function input(over: Partial<PostIntentFailureInput> = {}): PostIntentFailureInput {
  return {
    executionId: 4242,
    events: [activityEvent(77)],
    plans: [swapLegPlan()],
    slippageBps: 100,
    currentIndex: 0,
    legBroadcastAttempted: false,
    error: PRE_SIGN_REVERT,
    ...over,
  };
}

describe("a failed refusal-row write is logged, never swallowed", () => {
  it("warns with the execution, the event and the real cause", async () => {
    failActivityEvent.mockImplementation(async () => {
      throw new Error("the activity row could not be finalized");
    });

    await handlePostIntentFailure(input());

    const call = warn.mock.calls.find(
      ([event]) => event === "trench.trade_execute.fail_event_write_failed",
    );
    if (call === undefined) throw new Error("the swallowed write failure must reach the log");
    const [, metadata] = call;
    expect(metadata).toMatchObject({ executionId: 4242, eventId: 77 });
    expect(String(metadata.error)).toContain("could not be finalized");
  });

  it("still aborts the remaining legs — the log is added, the guarantee is unchanged", async () => {
    abortPlannedEvents.mockClear();
    failActivityEvent.mockImplementation(async () => {
      throw new Error("the activity row could not be finalized");
    });

    const result = await handlePostIntentFailure(input());

    expect(abortPlannedEvents).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });
});
