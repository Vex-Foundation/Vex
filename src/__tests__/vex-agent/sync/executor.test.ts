import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSyncExecutor } from "../../../vex-agent/sync/executor.js";

// `fastLane: false` throughout: these cases pin the TICK scheduler, and the
// Wave P fast lane is an independent wheel timer with its own suite
// (`fast-lane.test.ts`). Leaving it on would put a second repeating timer into
// every `advanceTimersByTimeAsync` window and make these assertions about
// something they are not testing.
describe("sync executor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs init first, then periodic sync ticks", async () => {
    const deps = {
      initSync: vi.fn().mockResolvedValue(undefined),
      syncTick: vi.fn().mockResolvedValue(undefined),
    };

    const handle = startSyncExecutor({ intervalMs: 1000, deps, fastLane: false });

    await vi.runOnlyPendingTimersAsync();
    expect(deps.initSync).toHaveBeenCalledTimes(1);
    expect(deps.syncTick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.syncTick).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it("does not schedule more work after stop", async () => {
    const deps = {
      initSync: vi.fn().mockResolvedValue(undefined),
      syncTick: vi.fn().mockResolvedValue(undefined),
    };

    const handle = startSyncExecutor({ intervalMs: 1000, deps, fastLane: false });

    await vi.runOnlyPendingTimersAsync();
    await handle.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(deps.syncTick).not.toHaveBeenCalled();
  });
});
