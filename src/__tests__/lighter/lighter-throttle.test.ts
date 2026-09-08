import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../errors.js";
import { LighterThrottle, parseRetryAfterMs } from "@tools/lighter/throttle.js";

describe("parseRetryAfterMs", () => {
  it("parses delta seconds and caps long waits", () => {
    expect(parseRetryAfterMs("3")).toBe(3_000);
    expect(parseRetryAfterMs("999")).toBe(60_000);
  });

  it("uses a fallback for missing or invalid headers", () => {
    expect(parseRetryAfterMs(null, 1_234)).toBe(1_234);
    expect(parseRetryAfterMs("not a date", 1_234)).toBe(1_234);
  });
});

describe("LighterThrottle", () => {
  it("caches values for the configured TTL and freezes cached objects", async () => {
    let now = 0;
    const throttle = new LighterThrottle({
      ttlMs: 100,
      deps: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });
    const fetcher = vi.fn(async () => ({ nested: { value: 1 } }));

    const first = await throttle.run("same", "core", 100, fetcher);
    const second = await throttle.run("same", "core", 100, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.nested)).toBe(true);

    now = 101;
    await throttle.run("same", "core", 100, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("deduplicates identical in-flight requests", async () => {
    let resolve!: (value: { ok: true }) => void;
    const pending = new Promise<{ ok: true }>((done) => {
      resolve = done;
    });
    const throttle = new LighterThrottle();
    const fetcher = vi.fn(() => pending);

    const first = throttle.run("dupe", "rhc", 100, fetcher);
    const second = throttle.run("dupe", "rhc", 100, fetcher);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolve({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
  });

  it("honors a 429 penalty before the next request", async () => {
    let now = 10_000;
    const sleeps: number[] = [];
    const throttle = new LighterThrottle({
      ttlMs: 0,
      deps: {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
    });

    throttle.penalize("core", 3_000);
    await throttle.run("after-penalty", "core", 0, async () => "ok");

    expect(sleeps).toEqual([3_000]);
  });

  it("fails closed on an invalid bucket key", async () => {
    const throttle = new LighterThrottle();
    await expect(Reflect.apply(throttle.run, throttle, ["bad", "prod", 0, async () => "nope"])).rejects.toMatchObject({
      code: ErrorCodes.LIGHTER_INVALID_REQUEST,
      message: "Invalid Lighter environment: prod",
    });
  });
});

describe("LighterThrottle cancellation", () => {
  it("abandons a queued request without spending a provider slot", async () => {
    // The bucket is under a provider penalty, so this call can only be waiting
    // in the queue. A reader who walked away must not keep the wait alive or
    // spend the slot when it finally opens.
    let resolveSleep: (() => void) | undefined;
    const throttle = new LighterThrottle({
      deps: {
        now: () => 0,
        sleep: (_ms, signal) => new Promise<void>((resolve, reject) => {
          resolveSleep = resolve;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      },
    });
    const fetcher = vi.fn(async () => ({ ok: true }));
    const controller = new AbortController();
    // A 429 penalty is what actually parks a Lighter request in the queue.
    throttle.penalize("core", 5_000);

    const pending = throttle.run("queued", "core", 0, fetcher, controller.signal);
    // Let the acquire loop reach its wait before abandoning it.
    await Promise.resolve();
    expect(resolveSleep).toBeDefined();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never starts a request for an already-abandoned caller", async () => {
    const throttle = new LighterThrottle();
    const fetcher = vi.fn(async () => ({ ok: true }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      throttle.run("dead", "core", 0, fetcher, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a coalesced read alive for the callers that are still waiting", async () => {
    let settle!: (value: { ok: true }) => void;
    const inner = new Promise<{ ok: true }>((resolve) => {
      settle = resolve;
    });
    let fetchSignal: AbortSignal | undefined;
    const throttle = new LighterThrottle({ ttlMs: 1_000 });
    const fetcher = vi.fn((signal?: AbortSignal) => {
      fetchSignal = signal;
      return inner;
    });
    const leaving = new AbortController();

    const abandoned = throttle.run("shared", "core", 1_000, fetcher, leaving.signal);
    const staying = throttle.run("shared", "core", 1_000, fetcher);
    await Promise.resolve();
    leaving.abort();

    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSignal?.aborted).toBe(false);
    settle({ ok: true });
    await expect(staying).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("cancels the shared read once its last caller has left", async () => {
    let fetchSignal: AbortSignal | undefined;
    const throttle = new LighterThrottle({ ttlMs: 1_000 });
    const fetcher = vi.fn((signal?: AbortSignal) => {
      fetchSignal = signal;
      return new Promise<{ ok: true }>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const only = new AbortController();

    const pending = throttle.run("solo", "core", 1_000, fetcher, only.signal);
    await Promise.resolve();
    only.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSignal?.aborted).toBe(true);
  });
});

describe("LighterThrottle in-flight reuse after cancellation", () => {
  it("does not hand a new caller someone else's cancelled read", async () => {
    const throttle = new LighterThrottle({ ttlMs: 1_000 });
    const fetcher = vi.fn((signal?: AbortSignal) => new Promise<{ n: number }>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      if (fetcher.mock.calls.length === 2) resolve({ n: 2 });
    }));
    const leaving = new AbortController();

    const abandoned = throttle.run("reused", "core", 1_000, fetcher, leaving.signal);
    await Promise.resolve();
    leaving.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });

    // The cancelled entry may still be in the map for a microtask; a fresh
    // caller must get a fresh read, not the abandoned rejection.
    await expect(throttle.run("reused", "core", 1_000, fetcher)).resolves.toEqual({ n: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
