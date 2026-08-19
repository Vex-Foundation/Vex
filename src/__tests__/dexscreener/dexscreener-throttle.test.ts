import { describe, expect, it, vi } from "vitest";
import {
  DexScreenerThrottle,
  cacheTtlForClass,
  classifyRateClass,
  parseRetryAfterMs,
} from "@tools/dexscreener/throttle.js";

// A virtual clock: `sleep` advances the clock and resolves immediately, so the
// token-bucket / penalty loops terminate deterministically without real timers.
function makeClockThrottle(options: { maxCacheEntries?: number } = {}) {
  const state = { clock: 0 };
  const throttle = new DexScreenerThrottle({
    maxCacheEntries: options.maxCacheEntries,
    deps: {
      now: () => state.clock,
      sleep: async (ms: number) => {
        state.clock += Math.max(0, ms);
      },
    },
  });
  return { throttle, state };
}

describe("classifyRateClass", () => {
  it("maps the 300/min endpoints to fast", () => {
    expect(classifyRateClass("/latest/dex/search")).toBe("fast");
    expect(classifyRateClass("/latest/dex/pairs/ethereum/0xabc")).toBe("fast");
    expect(classifyRateClass("/tokens/v1/solana/abc")).toBe("fast");
    expect(classifyRateClass("/token-pairs/v1/base/0xabc")).toBe("fast");
  });

  it("maps everything else (60/min) to slow — including token-profiles and metas", () => {
    expect(classifyRateClass("/token-profiles/latest/v1")).toBe("slow");
    expect(classifyRateClass("/token-profiles/recent-updates/v1")).toBe("slow");
    expect(classifyRateClass("/token-boosts/latest/v1")).toBe("slow");
    expect(classifyRateClass("/community-takeovers/latest/v1")).toBe("slow");
    expect(classifyRateClass("/ads/latest/v1")).toBe("slow");
    expect(classifyRateClass("/orders/v1/solana/abc")).toBe("slow");
    expect(classifyRateClass("/metas/trending/v1")).toBe("slow");
    expect(classifyRateClass("/metas/meta/v1/knockoff-legends")).toBe("slow");
  });

  it("gives fast a shorter TTL than slow", () => {
    expect(cacheTtlForClass("fast")).toBeLessThan(cacheTtlForClass("slow"));
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("falls back when absent or unparseable", () => {
    expect(parseRetryAfterMs(null)).toBe(5000);
    expect(parseRetryAfterMs(undefined)).toBe(5000);
    expect(parseRetryAfterMs("not-a-number")).toBe(5000);
  });

  it("caps very large values at 60s", () => {
    expect(parseRetryAfterMs("99999")).toBe(60000);
  });
});

describe("DexScreenerThrottle cache + dedupe", () => {
  it("reports the original fetch time and cache age on cache hits", async () => {
    const { throttle, state } = makeClockThrottle();
    const fetcher = vi.fn(async () => ({ ok: true }));

    const first = await throttle.runObserved("observed", "fast", 30_000, fetcher);
    state.clock += 4_250;
    const cached = await throttle.runObserved("observed", "fast", 30_000, fetcher);

    expect(first).toMatchObject({ fetchedAtMs: 0, cacheHit: false, cacheAgeMs: 0 });
    expect(cached).toMatchObject({ fetchedAtMs: 0, cacheHit: true, cacheAgeMs: 4_250 });
    expect(cached.value).toBe(first.value);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves a fresh cache hit without re-fetching, re-fetches after TTL expiry", async () => {
    const { throttle, state } = makeClockThrottle();
    const fetcher = vi.fn(async () => "value");

    await throttle.run("k", "fast", 8000, fetcher);
    await throttle.run("k", "fast", 8000, fetcher); // within TTL → cache hit
    expect(fetcher).toHaveBeenCalledTimes(1);

    state.clock += 8001; // expire
    await throttle.run("k", "fast", 8000, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent identical requests into one fetch", async () => {
    const throttle = new DexScreenerThrottle();
    let resolveFetch!: (v: string) => void;
    const fetcher = vi.fn(() => new Promise<string>((r) => { resolveFetch = r; }));

    const p1 = throttle.run("k", "fast", 1000, fetcher);
    const p2 = throttle.run("k", "fast", 1000, fetcher);

    // Drain microtasks so the (single) in-flight fetch actually fires.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch("shared");
    await expect(p1).resolves.toBe("shared");
    await expect(p2).resolves.toBe("shared");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not cache errors and clears the in-flight entry", async () => {
    const { throttle } = makeClockThrottle();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");

    await expect(throttle.run("k", "fast", 8000, fetcher)).rejects.toThrow("boom");
    // A rejected fetch must not poison the cache — the retry hits the network.
    await expect(throttle.run("k", "fast", 8000, fetcher)).resolves.toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry when the cache exceeds its bound", async () => {
    const { throttle } = makeClockThrottle({ maxCacheEntries: 2 });
    const fetcher = vi.fn(async (k: string) => k);

    await throttle.run("k1", "slow", 60000, () => fetcher("k1"));
    await throttle.run("k2", "slow", 60000, () => fetcher("k2"));
    await throttle.run("k3", "slow", 60000, () => fetcher("k3")); // evicts k1
    expect(fetcher).toHaveBeenCalledTimes(3);

    // k1 was evicted → this re-fetches; k3 is still cached.
    await throttle.run("k1", "slow", 60000, () => fetcher("k1"));
    expect(fetcher).toHaveBeenCalledTimes(4);
    await throttle.run("k3", "slow", 60000, () => fetcher("k3"));
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe("DexScreenerThrottle Retry-After penalty", () => {
  it("parks the rate class for the penalty window before the next fetch", async () => {
    const { throttle, state } = makeClockThrottle();
    throttle.penalize("fast", 5000);

    const fetcher = vi.fn(async () => "v");
    await throttle.run("unique-key", "fast", 8000, fetcher);

    // acquire() had to wait out the 5s penalty (virtual clock advanced).
    expect(state.clock).toBeGreaterThanOrEqual(5000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
