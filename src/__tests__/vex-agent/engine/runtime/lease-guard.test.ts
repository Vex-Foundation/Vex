/**
 * Kairos S-1 — the runner lease guard, the heartbeat's loss classification,
 * the finalizer's stale-runner short circuit and the takeover reconcile.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import type {
  LeaseFence,
  LeaseFenceOutcome,
  LeaseFenceSite,
} from "@vex-agent/db/lease-fence.js";
import type { RunnerLease } from "@vex-agent/db/repos/runner-leases.js";
import type { UnresolvedMoneyState } from "@vex-agent/db/repos/approval-intents/money-state.js";
import type { Message } from "@vex-agent/db/repos/messages.js";
import { fakeLeaseHandle } from "../../../helpers/lease-guard.js";
import { testPoolClient } from "../../../helpers/pool-client.js";

const withLeaseFence = vi.fn<(site: LeaseFenceSite) => void>();
vi.mock("@vex-agent/db/lease-fence.js", () => ({
  readLeaseFenceState: async () => "held",
  logFencedWriteRefused: () => {},
  withLeaseFence: async <T>(
    _fence: LeaseFence,
    fn: (client: PoolClient) => Promise<T>,
    opts: { readonly site: LeaseFenceSite },
  ): Promise<LeaseFenceOutcome<T>> => {
    withLeaseFence(opts.site);
    return { fenced: true, state: "held", value: await fn(testPoolClient({})) };
  },
}));
const moneyState = vi.fn<() => Promise<UnresolvedMoneyState>>();
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async <T>(fn: (client: PoolClient) => Promise<T>) => fn(testPoolClient({})),
}));
vi.mock("@vex-agent/db/repos/approval-intents/money-state.js", () => ({
  getUnresolvedMoneyStateForSession: () => moneyState(),
}));
const appendUnderLease = vi.fn();
vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessagesUnderLease: (...a: unknown[]) => appendUnderLease(...a),
}));

const { createRunnerLeaseGuard, guardedWrite } = await import(
  "../../../../vex-agent/engine/runtime/lease-guard.js"
);
const { createLeaseHandle } = await import(
  "../../../../vex-agent/engine/runtime/lease-handle.js"
);
const { finalizeSkippedForLease } = await import(
  "../../../../vex-agent/engine/core/runner/mission-finalize.js"
);
const { reconcileAfterTakeover, TAKEOVER_RECONCILE_MESSAGE_TYPE } = await import(
  "../../../../vex-agent/engine/core/turn-loop/takeover-reconcile.js"
);

const LEASE: RunnerLease = {
  sessionId: "session-1",
  missionRunId: null,
  ownerId: "retry-run-1",
  processKind: "test",
  acquiredAt: new Date(),
  heartbeatAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
  claimToken: "token-a",
};

function manualTimer() {
  let tick: (() => void) | null = null;
  const handle = setInterval(() => {}, 1_000_000);
  clearInterval(handle);
  return {
    setInterval: (cb: () => void) => {
      tick = cb;
      return handle;
    },
    clearInterval: () => {},
    fire: () => tick?.(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RunnerLeaseGuard", () => {
  it("records only the FIRST loss and aborts its own signal", () => {
    const onLost = vi.fn();
    const guard = createRunnerLeaseGuard({
      ownerId: "o",
      fence: { sessionId: "s", claimToken: "t" },
      onLost,
    });
    expect(guard.lostSignal.aborted).toBe(false);
    guard.markLost("released", "heartbeat");
    guard.markLost("taken_over", "fence");
    expect(guard.lostReason()).toBe("released");
    expect(guard.lostSignal.aborted).toBe(true);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("refuses a write locally once the claim is known taken over (no DB round trip)", async () => {
    const guard = createRunnerLeaseGuard({ ownerId: "o", fence: { sessionId: "s", claimToken: "t" } });
    guard.markLost("taken_over", "heartbeat");
    const fn = vi.fn();
    const outcome = await guardedWrite(guard, "assistant_message", fn);
    expect(outcome).toEqual({ fenced: false, state: "taken_over" });
    expect(fn).not.toHaveBeenCalled();
    expect(withLeaseFence).not.toHaveBeenCalled();
  });

  it("a RELEASED claim still goes to the DB fence (the Stop's closing writes)", async () => {
    const guard = createRunnerLeaseGuard({ ownerId: "o", fence: { sessionId: "s", claimToken: "t" } });
    guard.markLost("released", "heartbeat");
    const outcome = await guardedWrite(guard, "assistant_message", async () => 7);
    expect(outcome).toEqual({ fenced: true, state: "held", value: 7 });
    expect(withLeaseFence).toHaveBeenCalledWith("assistant_message");
  });
});

describe("LeaseHandle heartbeat — loss classification", () => {
  it("a failed renewal with the row still present is a TAKEOVER", async () => {
    const timer = manualTimer();
    const handle = createLeaseHandle({
      lease: LEASE,
      ownerId: LEASE.ownerId,
      ttlMs: 60_000,
      timer,
      renewFn: vi.fn().mockResolvedValue(null),
      releaseFn: vi.fn().mockResolvedValue(0),
      probeFn: vi.fn().mockResolvedValue(LEASE),
    });
    timer.fire();
    await vi.waitFor(() => expect(handle.lostSignal.aborted).toBe(true));
    expect(handle.lostReason()).toBe("taken_over");
  });

  it("a failed renewal with the row gone is a RELEASE", async () => {
    const timer = manualTimer();
    const handle = createLeaseHandle({
      lease: LEASE,
      ownerId: LEASE.ownerId,
      ttlMs: 60_000,
      timer,
      renewFn: vi.fn().mockResolvedValue(null),
      releaseFn: vi.fn().mockResolvedValue(0),
      probeFn: vi.fn().mockResolvedValue(null),
    });
    timer.fire();
    await vi.waitFor(() => expect(handle.lostSignal.aborted).toBe(true));
    expect(handle.lostReason()).toBe("released");
  });

  it("renews and releases with the CLAIM TOKEN, never the owner id", async () => {
    const timer = manualTimer();
    const renewFn = vi.fn().mockResolvedValue(LEASE);
    const releaseFn = vi.fn().mockResolvedValue(1);
    const handle = createLeaseHandle({
      lease: LEASE,
      ownerId: LEASE.ownerId,
      ttlMs: 60_000,
      timer,
      renewFn,
      releaseFn,
    });
    timer.fire();
    await vi.waitFor(() => expect(renewFn).toHaveBeenCalledWith("session-1", "token-a", 60_000));
    await handle.release();
    expect(releaseFn).toHaveBeenCalledWith("session-1", "token-a");
    expect(handle.lostSignal.aborted).toBe(false);
  });
});

describe("finalizer — stale runner short circuit", () => {
  it("skips a lease_lost outcome and a known takeover, never the operator Stop", () => {
    const guard = fakeLeaseHandle({ ownerId: "o" });
    expect(finalizeSkippedForLease("s", "r", "lease_lost", { leaseGuard: guard })).toBe(true);
    expect(finalizeSkippedForLease("s", "r", "goal_reached", { leaseGuard: guard })).toBe(false);
    guard.markLost("taken_over", "fence");
    expect(finalizeSkippedForLease("s", "r", "goal_reached", { leaseGuard: guard })).toBe(true);
    expect(finalizeSkippedForLease("s", "r", "user_stopped", { leaseGuard: guard })).toBe(false);
    expect(finalizeSkippedForLease("s", "r", "goal_reached", undefined)).toBe(false);
  });
});

describe("reconcile before dispatch after a takeover", () => {
  it("appends ONE fenced notice naming the unresolved kinds, and never dispatches", async () => {
    moneyState.mockResolvedValue({
      clear: false,
      reasons: [
        { kind: "wallet_intent_live", ref: "wi-1" },
        { kind: "approval_in_flight", ref: "ap-1" },
        { kind: "wallet_intent_live", ref: "wi-2" },
      ],
    });
    appendUnderLease.mockResolvedValue([]);
    const guard = fakeLeaseHandle({ ownerId: "new-owner", sessionId: "session-1", tookOver: true });
    const live: Message[] = [];

    const result = await reconcileAfterTakeover({
      sessionId: "session-1",
      missionRunId: "run-1",
      leaseGuard: guard,
      liveMessages: live,
    });

    expect(result).toEqual({
      clear: false,
      kinds: ["approval_in_flight", "wallet_intent_live"],
      noticeWritten: true,
    });
    expect(appendUnderLease).toHaveBeenCalledTimes(1);
    expect(appendUnderLease.mock.calls[0]?.[3]).toBe("takeover_notice");
    expect(live).toHaveLength(1);
    expect(live[0]?.metadata?.messageType).toBe(TAKEOVER_RECONCILE_MESSAGE_TYPE);
    expect(live[0]?.content).toContain("Do NOT repeat any fund-moving action.");
  });

  it("writes nothing when the money state is clear", async () => {
    moneyState.mockResolvedValue({ clear: true });
    const live: Message[] = [];
    const result = await reconcileAfterTakeover({
      sessionId: "session-1",
      missionRunId: null,
      leaseGuard: fakeLeaseHandle({ ownerId: "new-owner", tookOver: true }),
      liveMessages: live,
    });
    expect(result.clear).toBe(true);
    expect(appendUnderLease).not.toHaveBeenCalled();
    expect(live).toHaveLength(0);
  });

  it("fails closed: an unreadable gate is reported as unknown, not clear", async () => {
    moneyState.mockRejectedValue(new Error("db down"));
    appendUnderLease.mockResolvedValue([]);
    const result = await reconcileAfterTakeover({
      sessionId: "session-1",
      missionRunId: null,
      leaseGuard: fakeLeaseHandle({ ownerId: "new-owner", tookOver: true }),
      liveMessages: [],
    });
    expect(result.kinds).toEqual(["unknown"]);
    expect(appendUnderLease).toHaveBeenCalledTimes(1);
  });
});
