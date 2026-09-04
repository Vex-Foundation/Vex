/**
 * THE PROPERTY THE QUIT PATH LOST: a shutdown participant that never settles
 * must not be able to hold `will-quit` open, and it must NAME itself when it
 * is abandoned.
 *
 * The regression this file guards is a real one: the Playwright fixture's
 * `app.close()` exceeded a 120 s teardown budget on a spec whose own
 * assertions had already passed, because one participant inside
 * `globalCleanup.runAll()` was awaited with no deadline and the log's last
 * line named the participant BEFORE it. Reverting either the bound or the
 * naming turns these red.
 *
 * The clock is vitest's fake timer rather than a wall-clock sleep, so the
 * deadline is proven by the transition and not by elapsed real time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CleanupRegistry } from "../cleanup-registry.js";
import { QUIT_TASK_DEADLINE_MS, runQuitStage, type QuitStageDeps } from "../quit-stage.js";

function recordingDeps(): { deps: QuitStageDeps; lines: string[] } {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      lines.push(`${level} ${args.map((a) => String(a)).join(" ")}`);
    };
  return {
    lines,
    deps: {
      log: { info: record("info"), warn: record("warn"), error: record("error") },
      now: () => Date.now(),
    },
  };
}

/** A promise nobody will ever settle: the participant this module exists for. */
function neverSettles(): Promise<void> {
  return new Promise<void>(() => undefined);
}

describe("runQuitStage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("abandons a participant whose promise never settles, and names it", async () => {
    const { deps, lines } = recordingDeps();
    const stage = runQuitStage("wedged-participant", 5_000, neverSettles, deps);

    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await stage;

    expect(outcome.status).toBe("timed_out");
    expect(outcome.name).toBe("wedged-participant");
    expect(outcome.durationMs).toBeGreaterThanOrEqual(5_000);
    // The name is on BOTH the way in and the way out, which is what lets a
    // future hang be read off the log without a debugger attached.
    expect(lines.some((l) => l.startsWith("info [quit] begin wedged-participant"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("TIMED OUT wedged-participant"))).toBe(true);
  });

  it("arms the deadline BEFORE invoking the participant", async () => {
    const { deps } = recordingDeps();
    // A participant that blocks the whole synchronous turn it is called on
    // would outlive a deadline created after the await.
    const stage = runQuitStage(
      "synchronously-blocking",
      1_000,
      () => {
        vi.advanceTimersByTime(5_000);
        return neverSettles();
      },
      deps,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect((await stage).status).toBe("timed_out");
  });

  it("reports a throwing participant as failed rather than rejecting", async () => {
    const { deps, lines } = recordingDeps();
    const outcome = await runQuitStage(
      "throwing-participant",
      1_000,
      () => {
        throw new Error("teardown boom");
      },
      deps,
    );

    expect(outcome.status).toBe("failed");
    expect(lines.some((l) => l.includes("failed throwing-participant"))).toBe(true);
  });

  it("reports a participant that finishes, with its duration", async () => {
    const { deps, lines } = recordingDeps();
    const stage = runQuitStage(
      "slow-but-finite",
      5_000,
      async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      },
      deps,
    );

    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await stage;

    expect(outcome.status).toBe("done");
    expect(outcome.durationMs).toBeGreaterThanOrEqual(2_000);
    expect(lines.some((l) => l.includes("end slow-but-finite status=done"))).toBe(true);
  });
});

describe("CleanupRegistry.runAll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles even when one task never settles, and still runs the others", async () => {
    const registry = new CleanupRegistry();
    const finished: string[] = [];

    registry.add(() => {
      finished.push("fast");
    }, "fast-task");
    registry.add(neverSettles, "wedged-task");
    registry.add(async () => {
      await Promise.resolve();
      finished.push("also-fast");
    }, "another-fast-task");

    const runAll = registry.runAll();
    await vi.advanceTimersByTimeAsync(QUIT_TASK_DEADLINE_MS);
    await runAll;

    // THE POINT: `runAll` resolved. Before the per-task deadline it could not,
    // and `app.exit(0)` in the `will-quit` owner was never reached.
    expect(finished).toEqual(["fast", "also-fast"]);
  });

  it("honours a task's own longer budget", async () => {
    const registry = new CleanupRegistry();
    let released = false;
    registry.add(
      async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 12_000));
        released = true;
      },
      "slow-but-entitled",
      { deadlineMs: 20_000 },
    );

    const runAll = registry.runAll();
    await vi.advanceTimersByTimeAsync(12_000);
    await runAll;

    // The default 5 s budget would have abandoned this task mid-drain; the
    // owner that knows what it waits for states the number instead.
    expect(released).toBe(true);
  });
});
