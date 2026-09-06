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
