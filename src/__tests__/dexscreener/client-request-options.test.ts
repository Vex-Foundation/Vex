/**
 * Per-call request options on `DexScreenerClient`.
 *
 * The price-watch poller runs on a 3 s tick, so it cannot inherit the shared
 * 30 s HTTP default: one slow provider call would stall ten ticks. It also has
 * to be ABORTABLE, because the wake executor's `stop()` must not wait out an
 * in-flight request. Both are per-call and OPTIONAL - every existing caller
 * keeps the 30 s default and passes no signal.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DexScreenerClient } from "@tools/dexscreener/client.js";

vi.mock("@config/store.js", () => ({
  loadConfig: () => ({ services: { dexScreenerApiUrl: "https://api.dexscreener.com" } }),
}));

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A fetch that only ever settles by abort - the stalled-provider case. */
function hangingFetch(_url: string, init: { signal?: AbortSignal }) {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      const err = new Error("aborted");
      err.name = init.signal?.reason?.name === "TimeoutError" ? "TimeoutError" : "AbortError";
      reject(err);
    };
    // Real `fetch` rejects immediately for an ALREADY-aborted signal; the
    // throttle's rate-limit acquire can land the abort before the fetch starts.
    if (init.signal?.aborted === true) {
      abort();
      return;
    }
    init.signal?.addEventListener("abort", abort);
  });
}

/** A fetch that resolves after `ms`, recording the signal it was handed. */
function slowFetch(ms: number, seen: { signal?: AbortSignal }) {
  return (_url: string, init: { signal?: AbortSignal }) => {
    seen.signal = init.signal;
    return new Promise((resolve) => setTimeout(() => resolve(jsonResponse([])), ms));
  };
}

/**
 * The throttle dedupes by URL, so two callers can share ONE in-flight request.
 * A caller's timeout and cancellation therefore bound only ITS OWN WAIT on that
 * shared promise - never the request. Otherwise the poller's 5 s deadline would
 * be inherited by an agent call that happened to ask for the same URL, and the
 * poller's shutdown abort would cancel that agent's request out from under it.
 */
describe("DexScreenerClient shared in-flight request isolation", () => {
  it("does not let a bounded caller's deadline reach a default caller sharing the URL", async () => {
    const seen: { signal?: AbortSignal } = {};
    fetchMock.mockImplementation(slowFetch(120, seen));
    const client = new DexScreenerClient("https://api.dexscreener.com");

    const bounded = client.getTokenPairs("base", "0xshared1", { timeoutMs: 20 });
    const plain = client.getTokenPairs("base", "0xshared1");

    await expect(bounded).rejects.toThrow(/timed out after 20ms/);
    await expect(plain).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen.signal?.aborted ?? false).toBe(false);
  });

  it("holds in the other call order too: the default caller starts the shared request", async () => {
    const seen: { signal?: AbortSignal } = {};
    fetchMock.mockImplementation(slowFetch(120, seen));
    const client = new DexScreenerClient("https://api.dexscreener.com");

    const plain = client.getTokenPairs("base", "0xshared2");
    const bounded = client.getTokenPairs("base", "0xshared2", { timeoutMs: 20 });

    await expect(bounded).rejects.toThrow(/timed out after 20ms/);
    await expect(plain).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen.signal?.aborted ?? false).toBe(false);
  });

  it("a caller's abort abandons only its own wait, never the shared request", async () => {
    const seen: { signal?: AbortSignal } = {};
    fetchMock.mockImplementation(slowFetch(120, seen));
    const client = new DexScreenerClient("https://api.dexscreener.com");
    const controller = new AbortController();

    const bounded = client.getTokenPairs("base", "0xshared3", {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    const plain = client.getTokenPairs("base", "0xshared3");
    controller.abort();

    await expect(bounded).rejects.toThrow();
    await expect(bounded).rejects.not.toThrow(/timed out/);
    await expect(plain).resolves.toEqual([]);
    expect(seen.signal?.aborted ?? false).toBe(false);
  });

  it("returns the shared result to a bounded caller that beats its own deadline", async () => {
    const seen: { signal?: AbortSignal } = {};
    fetchMock.mockImplementation(slowFetch(5, seen));
    const client = new DexScreenerClient("https://api.dexscreener.com");

    await expect(
      client.getTokenPairs("base", "0xshared4", { timeoutMs: 1_000 }),
    ).resolves.toEqual([]);
  });
});

describe("DexScreenerClient per-call request options", () => {
  it("keeps working, and passes no caller signal, when no options are given", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const client = new DexScreenerClient("https://api.dexscreener.com");

    await expect(client.getTokenPairs("base", "0xaaa1")).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honours a per-call timeoutMs instead of the 30 s default", async () => {
    fetchMock.mockImplementation(hangingFetch);
    const client = new DexScreenerClient("https://api.dexscreener.com");

    const started = Date.now();
    await expect(
      client.getTokenPairs("base", "0xaaa2", { timeoutMs: 20 }),
    ).rejects.toThrow(/timed out after 20ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops waiting as soon as the caller's signal fires", async () => {
    fetchMock.mockImplementation(hangingFetch);
    const client = new DexScreenerClient("https://api.dexscreener.com");
    const controller = new AbortController();

    const pending = client.getTokenPairs("base", "0xaaa3", {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow();
    // A caller abort is the caller's own event and must never be reported to
    // the agent as a provider timeout. It ends this WAIT; the shared request
    // itself is left alone (see the isolation suite above).
    await expect(pending).rejects.not.toThrow(/timed out/);
  });
});
