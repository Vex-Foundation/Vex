import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLeaseHandle,
  RunnerLeaseLostError,
  throwIfRunnerLeaseLost,
} from "../../../../vex-agent/engine/runtime/lease-handle.js";
import type { RunnerLease } from "../../../../vex-agent/db/repos/runner-leases.js";

const SAMPLE_LEASE: RunnerLease = {
  sessionId: "session-1",
  missionRunId: null,
  ownerId: "owner-1",
  processKind: "test",
  acquiredAt: new Date("2026-05-21T12:00:00Z"),
  heartbeatAt: new Date("2026-05-21T12:00:00Z"),
  expiresAt: new Date("2026-05-21T12:05:00Z"),
};

interface FakeTimer {
  setInterval: ReturnType<typeof vi.fn>;
  clearInterval: ReturnType<typeof vi.fn>;
  trigger: () => Promise<void>;
}

function makeFakeTimer(): FakeTimer {
  let stored: (() => void) | null = null;
  return {
    setInterval: vi.fn((cb: () => void) => {
      stored = cb;
      return 42 as unknown as ReturnType<typeof setInterval>;
    }),
    clearInterval: vi.fn(),
    async trigger(): Promise<void> {
      if (stored) {
        stored();
        // give the async heartbeat tick a microtask to settle
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LeaseHandle", () => {
  it("schedules the heartbeat at ttlMs / 3 (with a 1s minimum)", () => {
    const timer = makeFakeTimer();
    const handle = createLeaseHandle({
      lease: SAMPLE_LEASE,
      ownerId: "owner-1",
      ttlMs: 60_000,
      timer,
      renewFn: vi.fn().mockResolvedValue(SAMPLE_LEASE),
      releaseFn: vi.fn().mockResolvedValue(1),
    });
    // 60_000 / 3 = 20_000
    expect(timer.setInterval).toHaveBeenCalledWith(expect.any(Function), 20_000);
    void handle.release();
  });

  it("renews on heartbeat tick", async () => {
    const timer = makeFakeTimer();
    const renewFn = vi.fn().mockResolvedValue(SAMPLE_LEASE);
    const releaseFn = vi.fn().mockResolvedValue(1);

    const handle = createLeaseHandle({
      lease: SAMPLE_LEASE,
      ownerId: "owner-1",
      ttlMs: 60_000,
      timer,
      renewFn,
      releaseFn,
    });

    await timer.trigger();
    expect(renewFn).toHaveBeenCalledWith("session-1", "owner-1", 60_000);
    await handle.release();
  });

  it("aborts the ownership signal when renew returns null + stops the interval", async () => {
    const timer = makeFakeTimer();
    const renewFn = vi.fn().mockResolvedValue(null);
    const releaseFn = vi.fn().mockResolvedValue(0);
    const handle = createLeaseHandle({
      lease: SAMPLE_LEASE,
      ownerId: "owner-1",
      ttlMs: 60_000,
      timer,
      renewFn,
      releaseFn,
    });

    expect(handle.signal.aborted).toBe(false);
    await timer.trigger();
    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBeInstanceOf(RunnerLeaseLostError);
    expect(() => throwIfRunnerLeaseLost(handle.signal)).toThrow(
      RunnerLeaseLostError,
    );
    expect(timer.clearInterval).toHaveBeenCalledTimes(1);
    await handle.release();
    // Already released by the lease-stolen path — second release is a no-op.
    expect(releaseFn).not.toHaveBeenCalled();
  });

  it("release is idempotent and does not throw", async () => {
    const timer = makeFakeTimer();
    const releaseFn = vi.fn().mockResolvedValue(1);

    const handle = createLeaseHandle({
      lease: SAMPLE_LEASE,
      ownerId: "owner-1",
      ttlMs: 60_000,
      timer,
      renewFn: vi.fn().mockResolvedValue(SAMPLE_LEASE),
      releaseFn,
    });

    await handle.release();
    await handle.release();
    await handle.release();
    expect(releaseFn).toHaveBeenCalledTimes(1);
    expect(timer.clearInterval).toHaveBeenCalledTimes(1);
  });

  it("heartbeat survives a transient renew throw", async () => {
    const timer = makeFakeTimer();
    const renewFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient db"))
      .mockResolvedValueOnce(SAMPLE_LEASE);
    const releaseFn = vi.fn().mockResolvedValue(1);

    const handle = createLeaseHandle({
      lease: SAMPLE_LEASE,
      ownerId: "owner-1",
      ttlMs: 60_000,
      timer,
      renewFn,
      releaseFn,
    });

    await timer.trigger(); // throws — swallowed
    await timer.trigger(); // succeeds
    expect(renewFn).toHaveBeenCalledTimes(2);
    await handle.release();
  });
});
