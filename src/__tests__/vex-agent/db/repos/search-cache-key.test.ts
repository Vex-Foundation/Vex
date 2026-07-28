/**
 * W2B cache-preservation contract for the Tavily search cache.
 *
 * The key was the bare query. Once `topic`, `maxResults`, `searchDepth`,
 * `chunksPerSource` and `timeRange` are agent-settable, a bare-query key would
 * serve a cached 6-row general response to a 10-row news request — a silent
 * substitution of one answer for another. The key is now the normalized
 * EFFECTIVE OPTIONS tuple, and the fields that make it up are pinned here.
 *
 * Both directions are tested: a row written under the OLD bare-query key is a
 * miss for every new variant, and two different option tuples never share a row.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const mockQueryOne = vi.fn();
const mockExecute = vi.fn();

vi.mock("@vex-agent/db/client.js", () => ({
  query: vi.fn(),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
  queryWith: vi.fn(),
  queryOneWith: vi.fn(),
  executeWith: vi.fn(),
  withTransaction: vi.fn(),
}));

const searchRepo = await import("@vex-agent/db/repos/search.js");

const BASE: import("@vex-agent/db/repos/search.js").SearchCacheKeyInput = {
  query: "solana memecoin momentum",
  topic: "general",
  maxResults: 6,
  searchDepth: "basic",
  chunksPerSource: null,
  timeRange: null,
};

/** The pre-W2B key: sha256 of the lowercased, trimmed query, first 16 hex chars. */
function legacyQueryHash(query: string): string {
  return createHash("sha256").update(query.toLowerCase().trim()).digest("hex").slice(0, 16);
}

function firstCallParams(calls: readonly unknown[][]): unknown[] {
  const call = calls[0];
  if (!call) throw new Error("expected a query call");
  const params = call[1];
  if (!Array.isArray(params)) throw new Error("expected bound parameters");
  return params;
}

function hashOf(input: import("@vex-agent/db/repos/search.js").SearchCacheKeyInput): string {
  return searchRepo.searchCacheKeyHash(input);
}

describe("search cache key — effective options tuple", () => {
  beforeEach(() => {
    mockQueryOne.mockReset().mockResolvedValue(null);
    mockExecute.mockReset().mockResolvedValue(undefined);
  });

  it("is stable for the same tuple and case-insensitive on the query", () => {
    expect(hashOf(BASE)).toBe(hashOf({ ...BASE }));
    expect(hashOf({ ...BASE, query: "  SOLANA Memecoin Momentum " })).toBe(hashOf(BASE));
  });

  it("changes when ANY of the five effective options changes", () => {
    const base = hashOf(BASE);
    expect(hashOf({ ...BASE, topic: "news" })).not.toBe(base);
    expect(hashOf({ ...BASE, maxResults: 10 })).not.toBe(base);
    expect(hashOf({ ...BASE, searchDepth: "advanced" })).not.toBe(base);
    expect(hashOf({ ...BASE, chunksPerSource: 1 })).not.toBe(base);
    expect(hashOf({ ...BASE, timeRange: "day" })).not.toBe(base);
  });

  it("never collides with the OLD bare-query key — old rows are a miss for every variant", () => {
    const legacy = legacyQueryHash(BASE.query);
    for (const variant of [
      BASE,
      { ...BASE, topic: "news" as const },
      { ...BASE, maxResults: 10 },
      { ...BASE, searchDepth: "advanced" as const },
      { ...BASE, timeRange: "week" as const },
    ]) {
      expect(hashOf(variant)).not.toBe(legacy);
    }
  });

  it("reads and writes under the tuple hash, keeping the human-readable query on the row", async () => {
    await searchRepo.getCached(BASE);
    expect(firstCallParams(mockQueryOne.mock.calls)).toEqual([hashOf(BASE)]);

    await searchRepo.cacheResult(BASE, []);
    const writeParams = firstCallParams(mockExecute.mock.calls);
    expect(writeParams[0]).toBe(hashOf(BASE));
    expect(writeParams[1]).toBe(BASE.query);
  });

  it("returns the capture time with the rows so the payload can report asOfMs honestly", async () => {
    const cachedAt = new Date(Date.now() - 60_000);
    mockQueryOne.mockResolvedValueOnce({
      results: [
        {
          title: "t",
          url: "https://example.com",
          snippet: "s",
          score: 0.5,
          publishedAt: null,
          publishedAtMs: null,
        },
      ],
      cached_at: cachedAt.toISOString(),
    });

    const entry = await searchRepo.getCached(BASE);
    expect(entry?.cachedAt).toBe(cachedAt.getTime());
    expect(entry?.rows).toHaveLength(1);
  });

  it("treats a MALFORMED cached row set as a miss — DB rows are untrusted input", async () => {
    mockQueryOne.mockResolvedValueOnce({
      results: [{ title: "t", url: "https://example.com", snippet: 42 }],
      cached_at: new Date().toISOString(),
    });

    expect(await searchRepo.getCached(BASE)).toBeNull();
  });

  it("expires a stale row and reports a miss", async () => {
    mockQueryOne.mockResolvedValueOnce({
      results: [],
      cached_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });

    expect(await searchRepo.getCached(BASE)).toBeNull();
    expect(mockExecute).toHaveBeenCalled();
  });
});
