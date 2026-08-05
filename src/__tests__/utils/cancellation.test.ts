/**
 * Wave S1 (T2) — signal-aware timing primitives.
 *
 * The four properties every adopting call site depends on:
 *  - `delay` rejects promptly on abort and clears its timer (a 60 s delay that
 *    is aborted must not keep the event loop alive for 60 s);
 *  - `pollUntil` observes an abort raised DURING the inter-attempt wait, not at
 *    the next interval boundary;
 *  - `composeDeadline(undefined, ms) === undefined` — the no-signal path stays
 *    byte-identical for callers that use no cancellation;
 *  - a caller abort surfaces `AbortError` while a deadline breach surfaces
 *    `TimeoutError`. Both are asserted: this is what keeps "the user stopped"
 *    distinguishable from "the provider hung".
 */

import { describe, expect, it } from "vitest";
import {
  composeDeadline,
  delay,
  pollUntil,
  throwIfAborted,
} from "@utils/cancellation.js";

function errorName(err: unknown): string {
  return err instanceof Error || err instanceof DOMException ? err.name : String(err);
}

describe("throwIfAborted", () => {
  it("is a no-op without a signal and for a live signal", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  it("throws the signal's own reason", () => {
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown;
    try {
      throwIfAborted(controller.signal);
    } catch (err) {
      thrown = err;
    }
    expect(errorName(thrown)).toBe("AbortError");
  });
});

describe("delay", () => {
  it("resolves after the requested time", async () => {
    const started = Date.now();
    await delay(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1);
  });

  it("rejects promptly on abort and clears its timer", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = delay(60_000, controller.signal);
    setTimeout(() => controller.abort(), 5);

    let thrown: unknown;
    try {
      await pending;
    } catch (err) {
      thrown = err;
    }

    expect(errorName(thrown)).toBe("AbortError");
    // A leaked 60 s timer would keep this test (and the process) waiting.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(delay(60_000, controller.signal)).rejects.toSatisfy(
      (err: unknown) => errorName(err) === "AbortError",
    );
  });

  it("rejects with TimeoutError when the abort came from a deadline", async () => {
    const signal = composeDeadline(new AbortController().signal, 5);
    let thrown: unknown;
    try {
      await delay(60_000, signal);
    } catch (err) {
      thrown = err;
    }
    expect(errorName(thrown)).toBe("TimeoutError");
  });
});

describe("pollUntil", () => {
  it("returns the settled value", async () => {
    const outcome = await pollUntil<string>({
      attempts: 3,
      intervalMs: 1,
      attempt: async (): Promise<string | undefined> => "done",
    });
    expect(outcome).toEqual({ kind: "settled", value: "done" });
  });

  it("returns exhausted after the attempt budget", async () => {
    let calls = 0;
    const outcome = await pollUntil<string>({
      attempts: 3,
      intervalMs: 1,
      attempt: async (): Promise<string | undefined> => {
        calls += 1;
        return undefined;
      },
    });
    expect(outcome).toEqual({ kind: "exhausted" });
    expect(calls).toBe(3);
  });

  it("aborts DURING the inter-attempt wait, not at the next interval", async () => {
    const controller = new AbortController();
    let calls = 0;
    const started = Date.now();

    const outcome = await pollUntil<string>({
      attempts: 5,
      intervalMs: 60_000,
      signal: controller.signal,
      attempt: async (): Promise<string | undefined> => {
        calls += 1;
        setTimeout(() => controller.abort(), 5);
        return undefined;
      },
    });

    expect(outcome).toEqual({ kind: "aborted" });
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("returns aborted without running an attempt when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const outcome = await pollUntil<string>({
      attempts: 3,
      intervalMs: 1,
      signal: controller.signal,
      attempt: async (): Promise<string | undefined> => {
        calls += 1;
        return "never";
      },
    });
    expect(outcome).toEqual({ kind: "aborted" });
    expect(calls).toBe(0);
  });
});

describe("composeDeadline", () => {
  it("returns undefined when there is no caller signal", () => {
    expect(composeDeadline(undefined, 1_000)).toBeUndefined();
  });

  it("adopts a caller abort as AbortError", async () => {
    const controller = new AbortController();
    const composed = composeDeadline(controller.signal, 60_000);
    expect(composed).toBeDefined();
    controller.abort();
    expect(composed?.aborted).toBe(true);
    expect(errorName(composed?.reason)).toBe("AbortError");
  });

  it("adopts a deadline breach as TimeoutError", async () => {
    const composed = composeDeadline(new AbortController().signal, 5);
    expect(composed).toBeDefined();
    await new Promise<void>((resolve) => {
      composed?.addEventListener("abort", () => resolve(), { once: true });
    });
    expect(errorName(composed?.reason)).toBe("TimeoutError");
  });
});
