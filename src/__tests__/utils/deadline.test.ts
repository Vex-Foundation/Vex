/**
 * `runWithinDeadline`: one leg of a multi-source read, bounded, with the
 * deadline reported as its own outcome and a caller Stop kept distinct.
 */

import { describe, it, expect } from "vitest";

import { runWithinDeadline, LegDeadlineError } from "../../utils/deadline.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("runWithinDeadline", () => {
  it("with no deadline, hands the caller's own signal to the work and settles", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const outcome = await runWithinDeadline(0, controller.signal, async (signal) => {
      seen = signal;
      return 7;
    });
    expect(outcome).toEqual({ kind: "settled", value: 7 });
    expect(seen).toBe(controller.signal);
  });

  it("with no deadline and no caller signal, the work gets none", async () => {
    let seen: AbortSignal | undefined = new AbortController().signal;
    await runWithinDeadline(0, undefined, async (signal) => {
      seen = signal;
      return null;
    });
    expect(seen).toBeUndefined();
  });

  it("settles a leg that answers in time", async () => {
    const outcome = await runWithinDeadline(200, undefined, async () => {
      await sleep(10);
      return "ok";
    });
    expect(outcome).toEqual({ kind: "settled", value: "ok" });
  });

  it("aborts a signal-honouring leg at the deadline with a LegDeadlineError", async () => {
    let reason: unknown;
    const outcome = await runWithinDeadline(30, undefined, (signal) =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reason = signal.reason;
          reject(signal.reason);
        });
      }));
    expect(outcome).toEqual({ kind: "deadline" });
    expect(reason).toBeInstanceOf(LegDeadlineError);
  });

  it("bounds the wait on a leg that ignores its signal", async () => {
    const startedAt = Date.now();
    const outcome = await runWithinDeadline(30, undefined, async () => {
      await sleep(2_000);
      return "late";
    });
    expect(outcome).toEqual({ kind: "deadline" });
    // Well under the leg's own 2 s: the wait ended at the deadline.
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("rethrows a leg's own failure that is not the deadline", async () => {
    await expect(
      runWithinDeadline(500, undefined, async () => {
        throw new Error("provider 500");
      }),
    ).rejects.toThrow("provider 500");
  });

  it("a caller Stop rethrows the caller's reason, never a deadline outcome", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(
      runWithinDeadline(5_000, controller.signal, () => new Promise<never>(() => undefined)),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("a caller already stopped never starts the leg", async () => {
    const controller = new AbortController();
    controller.abort();
    let started = false;
    await expect(
      runWithinDeadline(100, controller.signal, async () => {
        started = true;
        return 1;
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toBe(false);
  });
});
