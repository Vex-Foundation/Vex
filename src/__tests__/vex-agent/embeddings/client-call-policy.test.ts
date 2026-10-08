/**
 * Embedding call policies: the interactive discovery budget is a hard 5 s
 * ceiling with one retry, and every other caller keeps the background policy
 * (30 s per attempt, 2 retries) it had before the interactive one existed.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { embedDocument, embedQuery, embedTool } from "@vex-agent/embeddings/client.js";
import {
  BACKGROUND_EMBEDDING_POLICY,
  EMBEDDING_BASE_DELAY_MS,
  EMBEDDING_MAX_DELAY_MS,
  EMBEDDING_MAX_RETRIES,
  EMBEDDING_REQUEST_TIMEOUT_MS,
} from "@vex-agent/embeddings/config.js";
import {
  DISCOVERY_EMBEDDING_BUDGET_MS,
  EmbeddingTimeoutError,
  INTERACTIVE_DISCOVERY_EMBEDDING_POLICY,
} from "@vex-agent/embeddings/call-policy.js";

const CONFIG = {
  baseUrl: "http://127.0.0.1:9/v1",
  model: "ai/embeddinggemma:300M-Q8_0",
  dim: 4,
  provider: "local",
};

/** A provider that accepts the request and never answers, until aborted. */
function hangingFetch() {
  return vi.fn((_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  );
}

function statusFetch(status: number) {
  return vi.fn(async (): Promise<Response> => new Response("down", { status }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("background embedding policy", () => {
  it("keeps the pre-existing timeout, retries and backoff", () => {
    expect(EMBEDDING_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(EMBEDDING_MAX_RETRIES).toBe(2);
    expect(BACKGROUND_EMBEDDING_POLICY).toEqual({
      attemptTimeoutMs: EMBEDDING_REQUEST_TIMEOUT_MS,
      maxRetries: EMBEDDING_MAX_RETRIES,
      baseDelayMs: EMBEDDING_BASE_DELAY_MS,
      maxDelayMs: EMBEDDING_MAX_DELAY_MS,
      jitter: true,
    });
    expect(BACKGROUND_EMBEDDING_POLICY.totalBudgetMs).toBeUndefined();
  });

  it.each([
    ["embedDocument", () => embedDocument("t", "s", CONFIG)],
    ["embedQuery (no policy)", () => embedQuery("q", CONFIG)],
    ["embedTool", () => embedTool("x.y", "s", CONFIG)],
  ])("%s times each attempt at 30 s and makes 3 attempts", async (_name, call) => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = statusFetch(503);
    vi.stubGlobal("fetch", fetchMock);

    const settled = call().then(() => "resolved", (err: unknown) => err);
    await vi.advanceTimersByTimeAsync(60_000);
    const outcome = await settled;

    expect(outcome).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(EMBEDDING_MAX_RETRIES + 1);
    expect(timeoutSpy.mock.calls.map((c) => c[0])).toEqual([30_000, 30_000, 30_000]);
  });
});

describe("interactive discovery embedding policy", () => {
  it("is a 5 s budget with one retry", () => {
    expect(DISCOVERY_EMBEDDING_BUDGET_MS).toBe(5_000);
    expect(INTERACTIVE_DISCOVERY_EMBEDDING_POLICY.totalBudgetMs).toBe(5_000);
    expect(INTERACTIVE_DISCOVERY_EMBEDDING_POLICY.maxRetries).toBe(1);
    const p = INTERACTIVE_DISCOVERY_EMBEDDING_POLICY;
    expect(2 * p.attemptTimeoutMs + p.maxDelayMs).toBeLessThanOrEqual(DISCOVERY_EMBEDDING_BUDGET_MS);
  });

  it("gives up on a hung provider within the budget, after exactly one retry", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const startedAt = Date.now();
    const outcome = await embedQuery("swap usdc", CONFIG, INTERACTIVE_DISCOVERY_EMBEDDING_POLICY)
      .then(() => "resolved", (err: unknown) => err);
    const elapsed = Date.now() - startedAt;

    expect(outcome).toBeInstanceOf(EmbeddingTimeoutError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(6_000);
  }, 15_000);

  it("retries a 5xx once and does not retry a 4xx", async () => {
    const fiveHundred = statusFetch(503);
    vi.stubGlobal("fetch", fiveHundred);
    await expect(embedQuery("q", CONFIG, INTERACTIVE_DISCOVERY_EMBEDDING_POLICY)).rejects.toThrow(/503/);
    expect(fiveHundred).toHaveBeenCalledTimes(2);

    const fourHundred = statusFetch(400);
    vi.stubGlobal("fetch", fourHundred);
    await expect(embedQuery("q", CONFIG, INTERACTIVE_DISCOVERY_EMBEDDING_POLICY)).rejects.toThrow(/400/);
    expect(fourHundred).toHaveBeenCalledTimes(1);
  });
});
