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

import { handlePostIntentFailure } from "@vex-agent/tools/protocols/trench/handlers/trade/failure-results.js";

/** A revert the pre-sign classifier recognises, so the finalizing write is attempted. */
const PRE_SIGN_REVERT = Object.assign(new Error("execution reverted"), {
  shortMessage: "Execution reverted with reason: TrenchExpress: slippage.",
});

function input(over: Record<string, unknown> = {}) {
  return {
    executionId: 4242,
    events: [{ id: 77 }],
    plans: [{ eventRole: "swap" }],
    slippageBps: 100,
    currentIndex: 0,
    legBroadcastAttempted: false,
    error: PRE_SIGN_REVERT,
    ...over,
  } as never;
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
    expect(call, "the swallowed write failure must reach the log").toBeDefined();
    expect(call![1]).toMatchObject({ executionId: 4242, eventId: 77 });
    expect(String(call![1].error)).toContain("could not be finalized");
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
