/**
 * Hyperliquid protection-notifier — direct unit pin (W0 gap-fill).
 *
 * `hyperliquid-reconciler.test.ts` already pins the safety-wake/notice
 * behavior END-TO-END through `reconcileHyperliquid` (coordinator +
 * projections + notifier together). This file pins the SAME seam — the
 * classifier `protectionNoticeSignal` and the `wakeOrNotify*` promote/enqueue
 * contract — at the notifier module boundary, decoupled from HL market data,
 * clearinghouse parsing, or capture projection. Agent Scan's teardown does not
 * touch this module, but it depends on adjacent repos (`activity.js`
 * `getLatestSessionIdForPosition`, `loop-wake.js`, `mission-runs.js`) that DO
 * move during the teardown; this file is the survives-the-teardown pin for
 * the notifier's own contract, independent of those callers' internals.
 *
 * Genuine gaps filled here (not covered by the coordinator-level suite):
 *   - the `enqueueWake` branch (paused run, but NO pending wake already queued);
 *   - the early-return guards (missing positionKey/coin, no owning session);
 *   - `shouldNotify: false` still runs the safety wake with zero chat notice,
 *     asserted directly against the two exported entry points.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HyperliquidProtectionNotifierDeps } from "@vex-agent/sync/hyperliquid-reconciler/protection-notifier.js";
import {
  protectionNoticeSignal,
  wakeOrNotifyConsolidation,
  wakeOrNotifyUnprotected,
} from "@vex-agent/sync/hyperliquid-reconciler/protection-notifier.js";

describe("protectionNoticeSignal", () => {
  it("CONSOLIDATING + escalated -> UNPROTECTED", () => {
    expect(protectionNoticeSignal("CONSOLIDATING", true)).toBe("UNPROTECTED");
  });

  it("CONSOLIDATING without escalation -> CONSOLIDATING", () => {
    expect(protectionNoticeSignal("CONSOLIDATING", false)).toBe("CONSOLIDATING");
  });

  it("UNPROTECTED and PARTIAL both classify as UNPROTECTED regardless of the escalation flag", () => {
    expect(protectionNoticeSignal("UNPROTECTED", false)).toBe("UNPROTECTED");
    expect(protectionNoticeSignal("PARTIAL", false)).toBe("UNPROTECTED");
  });

  it("healthy states (FLAT / OPENING / PROTECTED / undefined) produce no signal", () => {
    expect(protectionNoticeSignal("FLAT", false)).toBeNull();
    expect(protectionNoticeSignal("OPENING", false)).toBeNull();
    expect(protectionNoticeSignal("PROTECTED", false)).toBeNull();
    expect(protectionNoticeSignal(undefined, false)).toBeNull();
  });
});

describe("wakeOrNotify* — safety-wake seam", () => {
  const CAPTURE = { positionKey: "hyperliquid:perp:BTC:0xWALLET", meta: { coin: "BTC" } };

  let getLatestSessionIdForPosition: ReturnType<typeof vi.fn>;
  let getActiveRunBySession: ReturnType<typeof vi.fn>;
  let getPendingForSession: ReturnType<typeof vi.fn>;
  let promotePendingWakeForSafety: ReturnType<typeof vi.fn>;
  let enqueueWake: ReturnType<typeof vi.fn>;
  let appendEngineMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getLatestSessionIdForPosition = vi.fn().mockResolvedValue("session-1");
    getActiveRunBySession = vi.fn().mockResolvedValue({ id: "run-1", status: "paused_wake" });
    getPendingForSession = vi.fn().mockResolvedValue(null);
    promotePendingWakeForSafety = vi.fn().mockResolvedValue(true);
    enqueueWake = vi.fn().mockResolvedValue(null);
    appendEngineMessage = vi.fn().mockResolvedValue({ id: 1, role: "system", content: "", timestamp: "" });
  });

  function deps(): HyperliquidProtectionNotifierDeps {
    return {
      getLatestSessionIdForPosition,
      getActiveRunBySession,
      getPendingForSession,
      promotePendingWakeForSafety,
      enqueueWake,
      appendEngineMessage,
    };
  }

  it("no pending wake queued -> enqueues a fresh wake (not covered by the coordinator suite)", async () => {
    await wakeOrNotifyConsolidation(CAPTURE, deps(), true);
    expect(enqueueWake).toHaveBeenCalledTimes(1);
    expect(enqueueWake).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        missionRunId: "run-1",
        reason: expect.stringContaining("consolidation"),
      }),
    );
    expect(promotePendingWakeForSafety).not.toHaveBeenCalled();
  });

  it("a pending wake already queued -> promotes it instead of enqueueing a second one", async () => {
    getPendingForSession.mockResolvedValue({ id: "wake-1" });
    await wakeOrNotifyUnprotected(CAPTURE, deps(), true);
    expect(promotePendingWakeForSafety).toHaveBeenCalledWith("session-1", "run-1");
    expect(enqueueWake).not.toHaveBeenCalled();
  });

  it("no active paused_wake run -> no wake at all, even with shouldNotify true", async () => {
    getActiveRunBySession.mockResolvedValue(null);
    await wakeOrNotifyConsolidation(CAPTURE, deps(), true);
    expect(promotePendingWakeForSafety).not.toHaveBeenCalled();
    expect(enqueueWake).not.toHaveBeenCalled();
    // The chat notice is independent of the wake and still fires.
    expect(appendEngineMessage).toHaveBeenCalledTimes(1);
  });

  it("shouldNotify: false still runs the safety wake but posts zero chat notice", async () => {
    await wakeOrNotifyConsolidation(CAPTURE, deps(), false);
    expect(enqueueWake).toHaveBeenCalledTimes(1);
    expect(appendEngineMessage).not.toHaveBeenCalled();
  });

  it("missing positionKey or coin is a no-op (no session lookup, no wake, no notice)", async () => {
    await wakeOrNotifyConsolidation({ meta: { coin: "BTC" } }, deps(), true); // no positionKey
    await wakeOrNotifyConsolidation({ positionKey: "pk" }, deps(), true); // no meta.coin
    expect(getLatestSessionIdForPosition).not.toHaveBeenCalled();
    expect(enqueueWake).not.toHaveBeenCalled();
    expect(appendEngineMessage).not.toHaveBeenCalled();
  });

  it("no owning session found (getLatestSessionIdForPosition -> null) is a fail-soft no-op", async () => {
    getLatestSessionIdForPosition.mockResolvedValue(null);
    await wakeOrNotifyUnprotected(CAPTURE, deps(), true);
    expect(getActiveRunBySession).not.toHaveBeenCalled();
    expect(appendEngineMessage).not.toHaveBeenCalled();
  });
});
