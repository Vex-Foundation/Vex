/**
 * Seam-preservation regression for the regime worker's Tavily seam.
 *
 * `web_research` gained agent-facing defaults in W2B (6 results, 3 page reads).
 * The regime worker is a SECOND consumer of the same internal function and must
 * not inherit them: its evidence set was 10 search rows with no page reads, and
 * a silently smaller one would degrade classification without any error. The
 * seam therefore takes an EXPLICIT options object and this test pins the
 * worker's outgoing values, plus the `content` → `snippet` migration of its Zod
 * gate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSearch = vi.hoisted(() => vi.fn());

vi.mock("@vex-agent/tools/internal/web.js", () => ({
  searchAndOptionallyFetch: mockSearch,
}));

const { defaultRegimeWorkerDeps } = await import("@vex-agent/engine/regime/regime-worker.js");

function okResult(data: unknown): { success: true; output: string; data: unknown } {
  return { success: true, output: JSON.stringify(data), data };
}

describe("regime worker — web seam", () => {
  beforeEach(() => {
    mockSearch.mockReset();
  });

  it("passes its OWN explicit options: 10 rows, no page reads, general topic", async () => {
    mockSearch.mockResolvedValueOnce(okResult({ results: [] }));

    await defaultRegimeWorkerDeps().searchWeb("btc regime");

    expect(mockSearch).toHaveBeenCalledTimes(1);
    const call = mockSearch.mock.calls[0];
    if (!call) throw new Error("expected the seam to be called");
    const [options] = call;
    expect(options).toMatchObject({
      query: "btc regime",
      maxResults: 10,
      fetchTop: 0,
      topic: "general",
    });
    // Frozen: the seam's contract is an immutable options object, so no
    // downstream code can mutate one consumer's request into another's.
    expect(Object.isFrozen(options)).toBe(true);
  });

  it("extracts title + snippet from the W2B row shape", async () => {
    mockSearch.mockResolvedValueOnce(
      okResult({
        results: [
          { title: "A", url: "https://a.example.com", snippet: "snippet a", pageRead: "not_requested" },
          { title: "B", url: "https://b.example.com", snippet: "snippet b", pageRead: "not_requested" },
        ],
      }),
    );

    const results = await defaultRegimeWorkerDeps().searchWeb("btc regime");
    expect(results).toEqual([
      { title: "A", snippet: "snippet a" },
      { title: "B", snippet: "snippet b" },
    ]);
  });

  it("prefers pageText when a row was read in full (the snippet is dropped there)", async () => {
    mockSearch.mockResolvedValueOnce(
      okResult({
        results: [{ title: "A", url: "https://a.example.com", pageRead: "ok", pageText: "full body" }],
      }),
    );

    const results = await defaultRegimeWorkerDeps().searchWeb("btc regime");
    expect(results).toEqual([{ title: "A", snippet: "full body" }]);
  });

  it("fails loudly on a malformed payload rather than classifying from nothing", async () => {
    mockSearch.mockResolvedValueOnce(okResult({ results: [{ title: 7 }] }));

    await expect(defaultRegimeWorkerDeps().searchWeb("btc regime")).rejects.toThrow(
      "regime_web_search_malformed_payload",
    );
  });

  it("fails loudly when the seam itself failed", async () => {
    mockSearch.mockResolvedValueOnce({ success: false, output: "Web search failed: boom" });

    await expect(defaultRegimeWorkerDeps().searchWeb("btc regime")).rejects.toThrow(
      "regime_web_search_failed",
    );
  });
});
