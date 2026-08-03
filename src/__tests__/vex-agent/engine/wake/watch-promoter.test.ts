/**
 * The PUSH half of `loop_defer`'s `watch`: a terminalizing `agent_activity` row
 * must move the matching pending wake's deadline to now, so the session wakes on
 * the event instead of on the model's guessed timer.
 *
 * These tests drive the real `pendingActivityBus` — the same object the repo CAS
 * emits on — rather than calling the promoter's internals, because the whole
 * contract is "the bus event causes the promotion". Repo access is mocked; the
 * SQL those two functions emit is covered in `db/repos/loop-wake.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetPendingWithWatch = vi.fn();
const mockPromotePendingWake = vi.fn();

vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  getPendingWithWatch: (...a: unknown[]) => mockGetPendingWithWatch(...a),
  promotePendingWake: (...a: unknown[]) => mockPromotePendingWake(...a),
}));

const { startWakeWatchPromoter } = await import(
  "../../../../vex-agent/engine/wake/watch-promoter.js"
);
const { pendingActivityBus, emitPendingActivityResolved, emitPendingActivityArmed } = await import(
  "../../../../vex-agent/events/pending-activity-bus.js"
);

function pendingWake(overrides: Record<string, unknown> = {}) {
  return {
    id: "wake-1",
    sessionId: "session-1",
    missionRunId: "run-1",
    dueAt: "2026-08-03T10:05:00.000Z",
    status: "pending",
    reason: "bridge fill",
    payload: {
      watchId: "watch-1",
      watchVersion: 1,
      conditions: [
        { type: "bridge_order_status", orderId: "order-abc", activityId: 4242 },
      ],
    },
    ...overrides,
  };
}

/** The bus emits synchronously but the promoter's work is async — let it settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

let handle: { stop(): void } | null = null;

beforeEach(() => {
  mockGetPendingWithWatch.mockReset().mockResolvedValue([pendingWake()]);
  mockPromotePendingWake.mockReset().mockResolvedValue(true);
  pendingActivityBus.clear();
  handle = startWakeWatchPromoter();
});

afterEach(() => {
  handle?.stop();
  pendingActivityBus.clear();
});

describe("wake watch promoter", () => {
  it("promotes the matching wake when the watched activity terminalizes", async () => {
    emitPendingActivityResolved({
      activityId: 4242,
      chainFamily: "eip155",
      chainId: 8453,
      lane: "onchain",
      status: "confirmed",
    });
    await settle();

    expect(mockPromotePendingWake).toHaveBeenCalledTimes(1);
    expect(mockPromotePendingWake).toHaveBeenCalledWith({
      sessionId: "session-1",
      missionRunId: "run-1",
      watchId: "watch-1",
    });
  });

  it("promotes a session-scoped agent wake with missionRunId null", async () => {
    mockGetPendingWithWatch.mockResolvedValue([pendingWake({ missionRunId: null })]);
    emitPendingActivityResolved({
      activityId: 4242,
      chainFamily: "eip155",
      chainId: 8453,
      lane: "onchain",
      status: "confirmed",
    });
    await settle();

    expect(mockPromotePendingWake).toHaveBeenCalledWith({
      sessionId: "session-1",
      missionRunId: null,
      watchId: "watch-1",
    });
  });

  it("ignores a different activity's terminalization", async () => {
    emitPendingActivityResolved({
      activityId: 9999,
      chainFamily: "solana",
      chainId: null,
      lane: "onchain",
      status: "definitively_failed",
    });
    await settle();
    expect(mockPromotePendingWake).not.toHaveBeenCalled();
  });

  // `armed` means the lane STARTED watching, not that anything settled.
  // Promoting on it would wake the session immediately after it went to sleep.
  it("ignores the armed half of the bus", async () => {
    emitPendingActivityArmed({ activityId: 4242, chainFamily: "eip155", chainId: 8453, lane: "onchain" });
    await settle();
    expect(mockGetPendingWithWatch).not.toHaveBeenCalled();
  });

  it("ignores a wake whose payload carries no usable watch", async () => {
    mockGetPendingWithWatch.mockResolvedValue([
      pendingWake({ payload: { trigger: "iteration_limit", automatic: true } }),
    ]);
    emitPendingActivityResolved({
      activityId: 4242,
      chainFamily: "eip155",
      chainId: 8453,
      lane: "onchain",
      status: "confirmed",
    });
    await settle();
    expect(mockPromotePendingWake).not.toHaveBeenCalled();
  });

  // Losing a promotion costs the session its EARLY wake, never its wake — the
  // timer is untouched. A throwing promoter would also poison the bus for the
  // renderer push and the balance snapshot that ride the same event.
  it("swallows a repo failure instead of propagating it through the bus", async () => {
    mockGetPendingWithWatch.mockRejectedValue(new Error("db down"));
    expect(() =>
      emitPendingActivityResolved({
        activityId: 4242,
        chainFamily: "eip155",
        chainId: 8453,
        lane: "onchain",
        status: "confirmed",
      }),
    ).not.toThrow();
    await settle();
    expect(mockPromotePendingWake).not.toHaveBeenCalled();
  });

  it("stops listening after stop()", async () => {
    handle?.stop();
    handle = null;
    emitPendingActivityResolved({
      activityId: 4242,
      chainFamily: "eip155",
      chainId: 8453,
      lane: "onchain",
      status: "confirmed",
    });
    await settle();
    expect(mockGetPendingWithWatch).not.toHaveBeenCalled();
  });
});
