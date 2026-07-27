import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock search cache repo
const mockGetCached = vi.fn().mockResolvedValue(null);
const mockCacheResult = vi.fn().mockResolvedValue(undefined);
const mockGetCachedFetch = vi.fn().mockResolvedValue(null);
const mockCacheFetchResult = vi.fn().mockResolvedValue(undefined);

vi.mock("@vex-agent/db/repos/search.js", () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  cacheResult: (...args: unknown[]) => mockCacheResult(...args),
  getCachedFetch: (...args: unknown[]) => mockGetCachedFetch(...args),
  cacheFetchResult: (...args: unknown[]) => mockCacheFetchResult(...args),
}));

// Mock Tavily SDK so we can assert timeout option + simulate hangs without
// hitting the network. Each test resets these via vi.clearAllMocks().
const mockTavilySearch = vi.fn();
const mockTavilyExtract = vi.fn();
vi.mock("@tavily/core", () => ({
  tavily: () => ({ search: mockTavilySearch, extract: mockTavilyExtract }),
}));

const { handleWebResearch } = await import("../../../../vex-agent/tools/internal/web.js");
import { makeTestContext } from "../_test-context.js";

const baseContext = makeTestContext();

/** The W2B row shape: one flat `results[]`, page reads folded onto their row. */
interface ParsedRow {
  title: string;
  url: string;
  snippet?: string;
  pageRead: "ok" | "failed" | "not_requested";
  pageText?: string;
  pageError?: string;
}
interface ParsedSearch {
  results: ParsedRow[];
  counts: { requested: number; returned: number; pagesRequested: number; pagesRead: number; pagesFailed: number };
}

function parsed(output: string): ParsedSearch {
  return JSON.parse(output) as ParsedSearch;
}
function firstRow(output: string): ParsedRow {
  const row = parsed(output).results[0];
  if (!row) throw new Error("expected at least one result row");
  return row;
}
function rowFor(output: string, url: string): ParsedRow {
  const row = parsed(output).results.find((r) => r.url === url);
  if (!row) throw new Error(`no row for ${url}`);
  return row;
}

describe("web_research", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call history but not implementations set inside
    // tests via mockImplementation/mockResolvedValueOnce. Re-pin defaults so
    // tests that don't touch these mocks get null/undefined as before.
    mockGetCached.mockReset().mockResolvedValue(null);
    mockCacheResult.mockReset().mockResolvedValue(undefined);
    mockGetCachedFetch.mockReset().mockResolvedValue(null);
    mockCacheFetchResult.mockReset().mockResolvedValue(undefined);
  });

  // ── XOR validation ────────────────────────────────────────────

  it("rejects when neither `query` nor `url` is provided", async () => {
    const result = await handleWebResearch({}, baseContext);
    expect(result.success).toBe(false);
    expect(result.output).toContain("exactly one of `query` or `url`");
  });

  it("rejects when both `query` and `url` are provided", async () => {
    const result = await handleWebResearch(
      { query: "x", url: "https://example.com" },
      baseContext,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("exactly one of `query` or `url`");
  });

  it("rejects `fetchTop` when only `url` is set (search-only knob, named in the message)", async () => {
    const result = await handleWebResearch(
      { url: "https://example.com", fetchTop: 2 },
      baseContext,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("`fetchTop`");
    expect(result.output).toContain("apply only to `query` searches");
  });

  it("rejects `searchDepth` when only `url` is set", async () => {
    const result = await handleWebResearch(
      { url: "https://example.com", searchDepth: "advanced" },
      baseContext,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("`searchDepth`");
    expect(result.output).toContain("apply only to `query` searches");
  });

  // ── Search branch ─────────────────────────────────────────────

  describe("search branch", () => {
    it("returns cached results when available", async () => {
      mockGetCached.mockResolvedValueOnce({
        rows: [
          {
            title: "Test",
            url: "https://example.com",
            snippet: "cached content",
            score: 0.5,
            publishedAt: null,
            publishedAtMs: null,
          },
        ],
        cachedAt: Date.now(),
      });

      const result = await handleWebResearch({ query: "test", fetchTop: 0 }, baseContext);
      expect(result.success).toBe(true);
      const payload = parsed(result.output);
      expect(payload.counts.returned).toBe(1);
      expect(firstRow(result.output).title).toBe("Test");
      expect(mockCacheResult).not.toHaveBeenCalled();
    });

    it("fails gracefully without TAVILY_API_KEY", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      delete process.env.TAVILY_API_KEY;

      const result = await handleWebResearch({ query: "test" }, baseContext);
      expect(result.success).toBe(false);
      expect(result.output).toContain("TAVILY_API_KEY");

      if (origKey) process.env.TAVILY_API_KEY = origKey;
    });

    // Regression: Tavily SDK calls without a timeout could wedge the engine
    // for the full 600 s loop budget when upstream hung (observed live as
    // 694 s+ stuck spinner). Pin `timeout: 30` and assert SDK rejection
    // surfaces as a clean fail() — no rethrow, no infinite wait, no cache
    // write. SDK respects the param at runtime
    // (node_modules/@tavily/core/dist/index.js:113).
    it("passes timeout: 30 to the Tavily search SDK", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      mockTavilySearch.mockResolvedValueOnce({ results: [] });

      await handleWebResearch({ query: "x" }, baseContext);
      expect(mockTavilySearch).toHaveBeenCalledTimes(1);
      const [, opts] = mockTavilySearch.mock.calls[0]!;
      expect((opts as { timeout?: number }).timeout).toBe(30);

      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("forwards `searchDepth` to the SDK when provided", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      mockTavilySearch.mockResolvedValueOnce({ results: [] });

      await handleWebResearch({ query: "x", searchDepth: "advanced" }, baseContext);
      const [, opts] = mockTavilySearch.mock.calls[0]!;
      expect((opts as { searchDepth?: string }).searchDepth).toBe("advanced");

      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("returns a clean failure when Tavily search times out", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      mockTavilySearch.mockRejectedValueOnce(new Error("Request timed out after 30000ms"));

      const result = await handleWebResearch({ query: "stuck-query" }, baseContext);
      expect(result.success).toBe(false);
      expect(result.output.toLowerCase()).toMatch(/timed out|timeout|failed/);
      // Failure path must not write to cache.
      expect(mockCacheResult).not.toHaveBeenCalled();

      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });
  });

  // ── Fetch branch ──────────────────────────────────────────────

  describe("fetch branch", () => {
    it("rejects non-http url at Zod boundary (and skips Tavily entirely)", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";

      const result = await handleWebResearch({ url: "ftp://example.com" }, baseContext);
      expect(result.success).toBe(false);
      expect(result.output).toContain("http://");
      // Schema-level rejection MUST short-circuit before any SDK call.
      expect(mockTavilyExtract).not.toHaveBeenCalled();

      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("surfaces failedResults as an honest failure — there is NO raw-HTTP fallback (Tavily-only, owner decision)", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      mockTavilyExtract.mockResolvedValueOnce({
        results: [],
        failedResults: [{ url: "https://blocked.example.com", error: "403 Forbidden" }],
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const result = await handleWebResearch(
        { url: "https://blocked.example.com" },
        baseContext,
      );
      expect(result.success).toBe(false);
      expect(result.output).toContain("403 Forbidden");
      // The privileged process must never fetch the URL itself.
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("a Tavily extract failure (timeout) is an honest failure — no raw-HTTP fallback", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      mockTavilyExtract.mockRejectedValueOnce(new Error("Request timed out after 25000ms"));
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const result = await handleWebResearch(
        { url: "https://slow.example.com" },
        baseContext,
      );
      expect(result.success).toBe(false);
      expect(result.output).toContain("timed out");
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("fetch without TAVILY_API_KEY fails with actionable guidance — defense-in-depth: the registry (requiresEnv) already hides the tool from the LLM without the key", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      delete process.env.TAVILY_API_KEY;
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const result = await handleWebResearch(
        { url: "https://example.com/article" },
        baseContext,
      );
      expect(result.success).toBe(false);
      expect(result.output).toContain("TAVILY_API_KEY");
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
      if (origKey) process.env.TAVILY_API_KEY = origKey;
    });

    it("rejects plain string (not a url) at Zod boundary", async () => {
      const result = await handleWebResearch({ url: "just-some-text" }, baseContext);
      expect(result.success).toBe(false);
    });

    it("returns cached fetch when available, as raw pageText", async () => {
      mockGetCachedFetch.mockResolvedValueOnce({
        markdown: "# Hello World\n\nCached content",
        title: "Hello World",
        fetchedAt: Date.now() - 1000,
      });

      const result = await handleWebResearch({ url: "https://example.com" }, baseContext);
      expect(result.success).toBe(true);
      const payload = JSON.parse(result.output) as { title: string; pageText: string };
      expect(payload.title).toBe("Hello World");
      expect(payload.pageText).toContain("Cached content");
      // No re-serialized `Source:` header — url and title are fields already.
      expect(payload.pageText).not.toContain("Source: https://example.com");
    });

    it("passes timeout: 25 to the Tavily extract SDK", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      mockTavilyExtract.mockResolvedValueOnce({
        results: [{ rawContent: "# Doc\n\nbody", url: "https://example.com" }],
      });

      await handleWebResearch({ url: "https://example.com/doc" }, baseContext);
      expect(mockTavilyExtract).toHaveBeenCalledTimes(1);
      const [, opts] = mockTavilyExtract.mock.calls[0]!;
      expect((opts as { timeout?: number }).timeout).toBe(25);

      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });
  });

  // ── Combined branch: search + page reads (default 3) ────────────

  describe("combined branch (query + page reads)", () => {
    it("reads the top 3 by default when fetchTop is omitted (single batch extract call)", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      const searchHits = Array.from({ length: 7 }, (_, i) => ({
        title: `Hit ${i}`,
        url: `https://hit${i}.example.com`,
        content: `snippet ${i}`,
      }));
      mockTavilySearch.mockResolvedValueOnce({ results: searchHits });
      // Tavily batch extract returns content for the 3 top URLs in one call.
      mockTavilyExtract.mockResolvedValueOnce({
        results: searchHits.slice(0, 3).map((h, i) => ({
          rawContent: `# ${h.title}\n\nfull ${i}`,
          url: h.url,
          title: h.title,
        })),
        failedResults: [],
      });

      const result = await handleWebResearch({ query: "foo" }, baseContext);
      expect(result.success).toBe(true);
      const payload = parsed(result.output);
      expect(payload.counts.returned).toBe(7);
      expect(payload.counts.pagesRead).toBe(3);
      expect(payload.results.filter((r) => r.pageRead === "ok")).toHaveLength(3);

      // Critical: ONE batch call, not three.
      expect(mockTavilyExtract).toHaveBeenCalledTimes(1);
      const [urlsArg, optsArg] = mockTavilyExtract.mock.calls[0]!;
      expect(urlsArg).toHaveLength(3);
      // Targeted extract: original query forwarded for relevance filtering.
      expect((optsArg as { query?: string }).query).toBe("foo");
      expect((optsArg as { timeout?: number }).timeout).toBe(25);

      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("returns search rows with the top-N pages folded in (explicit fetchTop)", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      mockTavilySearch.mockResolvedValueOnce({
        results: [
          { title: "A", url: "https://a.example.com", content: "a snippet" },
          { title: "B", url: "https://b.example.com", content: "b snippet" },
          { title: "C", url: "https://c.example.com", content: "c snippet" },
        ],
      });
      // Single batch extract call returns both URLs at once.
      mockTavilyExtract.mockResolvedValueOnce({
        results: [
          { rawContent: "# A\n\nfull A", url: "https://a.example.com", title: "A" },
          { rawContent: "# B\n\nfull B", url: "https://b.example.com", title: "B" },
        ],
        failedResults: [],
      });

      const result = await handleWebResearch({ query: "foo", fetchTop: 2 }, baseContext);
      expect(result.success).toBe(true);
      const payload = parsed(result.output);
      expect(payload.counts.returned).toBe(3);
      expect(payload.counts.pagesRead).toBe(2);
      expect(rowFor(result.output, "https://a.example.com").pageRead).toBe("ok");
      expect(rowFor(result.output, "https://b.example.com").pageRead).toBe("ok");
      // The third row was never requested — a distinct state from "failed".
      expect(rowFor(result.output, "https://c.example.com").pageRead).toBe("not_requested");

      // ONE batch call, not two.
      expect(mockTavilyExtract).toHaveBeenCalledTimes(1);

      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("fetchTop: 0 explicit → search-only, no extract called", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      mockTavilySearch.mockResolvedValueOnce({
        results: [{ title: "A", url: "https://a.example.com", content: "snip" }],
      });

      const result = await handleWebResearch({ query: "foo", fetchTop: 0 }, baseContext);
      expect(result.success).toBe(true);
      const payload = parsed(result.output);
      expect(payload.counts.returned).toBe(1);
      expect(payload.counts.pagesRequested).toBe(0);
      expect(firstRow(result.output).pageRead).toBe("not_requested");
      expect(firstRow(result.output).snippet).toBe("snip");
      expect(mockTavilyExtract).not.toHaveBeenCalled();

      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("caps fetchTop at the schema max (10)", async () => {
      const result = await handleWebResearch({ query: "foo", fetchTop: 99 }, baseContext);
      expect(result.success).toBe(false);
      // Zod schema rejects fetchTop > 10 at boundary.
    });

    it("reports per-row page state: extract returns one result + one explicit failure", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      mockTavilySearch.mockResolvedValueOnce({
        results: [
          { title: "A", url: "https://a.example.com", content: "a snippet" },
          { title: "B", url: "https://b.example.com", content: "b snippet" },
        ],
      });
      // Batch returns A as success, B as explicit failure (e.g. 403 blocked).
      mockTavilyExtract.mockResolvedValueOnce({
        results: [{ rawContent: "# A\n\nfull A", url: "https://a.example.com", title: "A" }],
        failedResults: [{ url: "https://b.example.com", error: "403 Forbidden" }],
      });

      const result = await handleWebResearch({ query: "foo", fetchTop: 2 }, baseContext);
      expect(result.success).toBe(true);

      const okRow = rowFor(result.output, "https://a.example.com");
      const failRow = rowFor(result.output, "https://b.example.com");
      expect(okRow.pageRead).toBe("ok");
      expect(okRow.pageText).toContain("full A");
      expect(failRow.pageRead).toBe("failed");
      expect(failRow.pageError).toContain("403");
      // A row that could not be read keeps the snippet it does have.
      expect(failRow.snippet).toBe("b snippet");

      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("cached URL skips the batch extract call (cache hit pre-filter)", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      mockTavilySearch.mockResolvedValueOnce({
        results: [
          { title: "A", url: "https://a.example.com", content: "a snippet" },
          { title: "B", url: "https://b.example.com", content: "b snippet" },
        ],
      });
      // A is in fetch cache; B requires Tavily.
      mockGetCachedFetch.mockImplementation(async (url: string) =>
        url === "https://a.example.com"
          ? { markdown: "cached A body", title: "Cached A", fetchedAt: Date.now() - 5000 }
          : null,
      );
      mockTavilyExtract.mockResolvedValueOnce({
        results: [{ rawContent: "# B\n\nfull B", url: "https://b.example.com", title: "B" }],
        failedResults: [],
      });

      const result = await handleWebResearch({ query: "foo", fetchTop: 2 }, baseContext);
      expect(result.success).toBe(true);
      expect(parsed(result.output).counts.pagesRead).toBe(2);

      // Batch extract called ONCE with only the uncached URL.
      expect(mockTavilyExtract).toHaveBeenCalledTimes(1);
      const [urlsArg] = mockTavilyExtract.mock.calls[0]!;
      expect(urlsArg).toEqual(["https://b.example.com"]);

      // Both pages present — A from cache, B from extract.
      expect(rowFor(result.output, "https://a.example.com").pageText).toContain("cached A body");

      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("whole batch failure → every row reported failed with the reason — no raw-HTTP fallback", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      mockTavilySearch.mockResolvedValueOnce({
        results: [
          { title: "A", url: "https://a.example.com", content: "snippet" },
          { title: "B", url: "https://b.example.com", content: "snippet" },
        ],
      });
      mockTavilyExtract.mockRejectedValueOnce(new Error("Request timed out after 25000ms"));
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const result = await handleWebResearch({ query: "foo", fetchTop: 2 }, baseContext);
      expect(result.success).toBe(true); // search itself succeeded — snippets stand
      const payload = parsed(result.output);
      expect(payload.counts.pagesFailed).toBe(2);
      expect(payload.results.every((r) => r.pageRead === "failed")).toBe(true);
      expect(payload.results.every((r) => String(r.pageError).includes("timed out"))).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("guards per-target URL scheme in fetchTop (skips non-http hits without calling Tavily extract)", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      mockTavilySearch.mockResolvedValueOnce({
        results: [
          { title: "Bad", url: "ftp://files.example.com/doc", content: "snippet" },
        ],
      });

      const result = await handleWebResearch({ query: "foo", fetchTop: 1 }, baseContext);
      expect(result.success).toBe(true);
      const row = firstRow(result.output);
      expect(row.pageRead).toBe("failed");
      expect(row.pageError).toContain("http://");
      // Tavily extract MUST NOT be called when all targets are filtered out.
      expect(mockTavilyExtract).not.toHaveBeenCalled();

      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });
  });

  it("a batch result with EMPTY rawContent is reported failed — never silently dropped (exactly-once accounting)", async () => {
    const origKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "test-key";
    mockTavilySearch.mockResolvedValueOnce({
      results: [
        { title: "A", url: "https://a.example.com", content: "snippet" },
        { title: "B", url: "https://b.example.com", content: "snippet" },
      ],
    });
    mockTavilyExtract.mockResolvedValueOnce({
      results: [
        { url: "https://a.example.com", rawContent: "# A\n\nbody" },
        { url: "https://b.example.com", rawContent: "" }, // accounted for, but empty
      ],
      failedResults: [],
    });

    const result = await handleWebResearch({ query: "foo", fetchTop: 2 }, baseContext);
    expect(result.success).toBe(true);
    const rowB = rowFor(result.output, "https://b.example.com");
    expect(rowB.pageRead).toBe("failed");
    expect(String(rowB.pageError)).toContain("empty content");

    if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
  });

  it("duplicate results for one URL yield exactly ONE outcome (first success wins)", async () => {
    const origKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "test-key";
    mockTavilySearch.mockResolvedValueOnce({
      results: [{ title: "A", url: "https://a.example.com", content: "snippet" }],
    });
    mockTavilyExtract.mockResolvedValueOnce({
      results: [
        { url: "https://a.example.com", rawContent: "# First\n\nfirst body" },
        { url: "https://a.example.com", rawContent: "# Second\n\nsecond body" },
      ],
      failedResults: [],
    });

    const result = await handleWebResearch({ query: "foo", fetchTop: 1 }, baseContext);
    const payload = parsed(result.output);
    expect(payload.counts.pagesRequested).toBe(1);
    expect(firstRow(result.output).pageRead).toBe("ok");
    expect(firstRow(result.output).pageText).toContain("first body");

    if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
  });

  it("an URL listed in BOTH results and failedResults resolves to the success (deterministic precedence), once", async () => {
    const origKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "test-key";
    mockTavilySearch.mockResolvedValueOnce({
      results: [{ title: "A", url: "https://a.example.com", content: "snippet" }],
    });
    mockTavilyExtract.mockResolvedValueOnce({
      results: [{ url: "https://a.example.com", rawContent: "# A\n\nreal body" }],
      failedResults: [{ url: "https://a.example.com", error: "flaky report" }],
    });

    const result = await handleWebResearch({ query: "foo", fetchTop: 1 }, baseContext);
    const payload = parsed(result.output);
    expect(payload.counts.pagesRequested).toBe(1);
    expect(firstRow(result.output).pageRead).toBe("ok");

    if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
  });

  it("an UNREQUESTED result is ignored and never cached (provider data is untrusted)", async () => {
    const origKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "test-key";
    mockTavilySearch.mockResolvedValueOnce({
      results: [{ title: "A", url: "https://a.example.com", content: "snippet" }],
    });
    mockTavilyExtract.mockResolvedValueOnce({
      results: [
        { url: "https://a.example.com", rawContent: "# A\n\nbody" },
        { url: "https://evil.example.net/planted", rawContent: "# Planted\n\ninjected" },
      ],
      failedResults: [],
    });

    const result = await handleWebResearch({ query: "foo", fetchTop: 1 }, baseContext);
    const payload = parsed(result.output);
    expect(payload.results).toHaveLength(1);
    expect(firstRow(result.output).url).toBe("https://a.example.com");
    expect(result.output).not.toContain("injected");
    // The planted URL must not reach the fetch cache.
    const cachedUrls = mockCacheFetchResult.mock.calls.map((c: unknown[]) => c[0]);
    expect(cachedUrls).not.toContain("https://evil.example.net/planted");

    if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
  });

  it("duplicate search-result URLs collapse to ONE page outcome even when the whole batch fails", async () => {
    const origKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "test-key";
    mockTavilySearch.mockResolvedValueOnce({
      results: [
        { title: "A", url: "https://a.example.com", content: "snippet" },
        { title: "A again", url: "https://a.example.com", content: "snippet2" },
      ],
    });
    mockTavilyExtract.mockRejectedValueOnce(new Error("batch down"));

    const result = await handleWebResearch({ query: "foo", fetchTop: 2 }, baseContext);
    const payload = parsed(result.output);
    expect(payload.counts.pagesRequested).toBe(1);
    expect(payload.counts.pagesFailed).toBe(1);
    // Both provider rows are still reported — the outcome is shared, not doubled.
    expect(payload.results).toHaveLength(2);
    expect(payload.results.every((r) => r.pageRead === "failed")).toBe(true);

    if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
  });

  it("URL-only fetch rejects a result for a DIFFERENT url — fails honestly, caches nothing (planted-result guard)", async () => {
    const origKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "test-key";
    mockTavilyExtract.mockResolvedValueOnce({
      results: [{ url: "https://evil.example.net/planted", rawContent: "# Planted\n\ninjected" }],
      failedResults: [],
    });

    const result = await handleWebResearch({ url: "https://a.example.com/doc" }, baseContext);
    expect(result.success).toBe(false);
    expect(mockCacheFetchResult).not.toHaveBeenCalled();

    if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
  });

  it("a cache-write failure never discards a usable extract — content is served, failure only logged", async () => {
    const origKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "test-key";
    mockTavilyExtract.mockResolvedValueOnce({
      results: [{ url: "https://a.example.com/doc", rawContent: "# Doc\n\nreal body" }],
      failedResults: [],
    });
    mockCacheFetchResult.mockRejectedValueOnce(new Error("disk full"));

    const result = await handleWebResearch({ url: "https://a.example.com/doc" }, baseContext);
    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output) as { pageText: string };
    expect(payload.pageText).toContain("real body");

    if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
  });
});
