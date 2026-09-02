/**
 * The restart-orphan reclaim's RECURRING handle: lifecycle only.
 *
 * What the reclaim WRITES is proven against real Postgres
 * (`integration/engine/restart-orphan-reclaim.int.test.ts`); a mocked client
 * cannot show a CAS or a lock. What is proven HERE is the handle contract that
 * makes it safe to own a repeating sweep at all, and those are scheduler
 * properties with no DB in them: single-flight (a slow pass is never lapped),
 * a drained shutdown, and no pass started after `stop()`.
 *
 * The pass is injected, so this file never touches `db/client.js`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  startRestartOrphanReclaim,
  type ReclaimPassSummary,
} from "../../../../vex-agent/engine/runtime/restart-orphan-reclaim.js";

const EMPTY: ReclaimPassSummary = {
  candidates: 0,
  reclaimed: 0,
  skipped: 0,
  failed: 0,
};

/** A pass whose completion the test controls. */
function deferredPass() {
  let release: (() => void) | null = null;
  const calls: number[] = [];
  const runPass = vi.fn(async (): Promise<ReclaimPassSummary> => {
    calls.push(Date.now());
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return EMPTY;
  });
  return {
    runPass,
    calls,
    finish: () => {
      if (!release) throw new Error("pass not started");
      const r = release;
      release = null;
      r();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startRestartOrphanReclaim", () => {
  it("runs a pass every interval", async () => {
    const runPass = vi.fn().mockResolvedValue(EMPTY);
    const handle = startRestartOrphanReclaim({ intervalMs: 1000, runPass });

    expect(runPass).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runPass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runPass).toHaveBeenCalledTimes(2);

    await handle.stop();
  });

  it("is single-flight: a slow pass is never lapped by the interval", async () => {
    const pass = deferredPass();
    const handle = startRestartOrphanReclaim({
      intervalMs: 1000,
      runPass: pass.runPass,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(pass.runPass).toHaveBeenCalledTimes(1);

    // Five intervals pass while the first sweep is still working.
    await vi.advanceTimersByTimeAsync(5000);
    expect(pass.runPass).toHaveBeenCalledTimes(1);

    pass.finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pass.runPass).toHaveBeenCalledTimes(2);
    pass.finish();

    await handle.stop();
  });

  it("stop() resolves only after the in-flight pass settles", async () => {
    const pass = deferredPass();
    const handle = startRestartOrphanReclaim({
      intervalMs: 1000,
      runPass: pass.runPass,
    });
    await vi.advanceTimersByTimeAsync(1000);

    let stopped = false;
    const stopping = handle.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    // The reclaim writes inside a transaction; quit sequences this stop before
    // Postgres teardown, so resolving early would tear the DB out from under it.
    expect(stopped).toBe(false);

    pass.finish();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("starts no further pass after stop(), and stop() is idempotent", async () => {
    const pass = deferredPass();
    const handle = startRestartOrphanReclaim({
      intervalMs: 1000,
      runPass: pass.runPass,
    });
    await vi.advanceTimersByTimeAsync(1000);

    const stopping = handle.stop();
    pass.finish();
    await stopping;
    await handle.stop();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pass.runPass).toHaveBeenCalledTimes(1);
  });

  it("tells the pass to stop between candidates once stopping", async () => {
    // `shouldContinue` is how a shutdown drains promptly instead of working
    // through a whole backlog: the pass checks it between candidates.
    let shouldContinue: (() => boolean) | undefined;
    const pass = vi.fn(async (options: { shouldContinue?: () => boolean }) => {
      shouldContinue = options.shouldContinue;
      return EMPTY;
    });
    const handle = startRestartOrphanReclaim({
      intervalMs: 1000,
      runPass: pass,
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(shouldContinue?.()).toBe(true);
    await handle.stop();
    expect(shouldContinue?.()).toBe(false);
  });

  it("keeps sweeping after a pass throws", async () => {
    const runPass = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient db failure"))
      .mockResolvedValue(EMPTY);
    const handle = startRestartOrphanReclaim({ intervalMs: 1000, runPass });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(runPass).toHaveBeenCalledTimes(2);
    await handle.stop();
  });
});
