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

// SSRF policy resolves hostnames; pin public A records so tests do not depend
// on live DNS / NXDOMAIN. Private literals (127.0.0.1) never hit this path.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (hostname: string) => {
    const h = hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost")) {
      return { address: "127.0.0.1", family: 4 };
    }
    // Stable public address for *.example.com and any other test host
    return { address: "93.184.216.34", family: 4 };
  }),
}));

const { handleWebResearch } = await import("../../../../vex-agent/tools/internal/web.js");
import { makeTestContext } from "../_test-context.js";

const baseContext = makeTestContext();

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

  it("rejects `fetchTop` when only `url` is set (search-only knob)", async () => {
    const result = await handleWebResearch(
      { url: "https://example.com", fetchTop: 2 },
      baseContext,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("apply only to `query` searches");
  });

  it("rejects `searchDepth` when only `url` is set", async () => {
    const result = await handleWebResearch(
      { url: "https://example.com", searchDepth: "advanced" },
      baseContext,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("apply only to `query` searches");
  });

  // ── Search branch (replaces old web_search) ───────────────────

  describe("search branch", () => {
    it("returns cached results when available", async () => {
      mockGetCached.mockResolvedValueOnce([
        { title: "Test", url: "https://example.com", content: "cached content" },
      ]);

      const result = await handleWebResearch({ query: "test" }, baseContext);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.count).toBe(1);
      expect(parsed.results[0].title).toBe("Test");
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

  // ── Fetch branch (replaces old web_fetch) ─────────────────────

  describe("fetch branch", () => {
    // ── SSRF destination policy ─────────────────────────────────
    it("blocks loopback URL before Tavily or raw fetch (SSRF)", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const result = await handleWebResearch(
        { url: "http://127.0.0.1:27134/secret" },
        baseContext,
      );
      expect(result.success).toBe(false);
      expect(result.output.toLowerCase()).toMatch(/private|loopback|refusing/);
      expect(mockTavilyExtract).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockCacheFetchResult).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
      if (origKey) process.env.TAVILY_API_KEY = origKey;
      else delete process.env.TAVILY_API_KEY;
    });

    it("blocks cloud metadata link-local URL (SSRF)", async () => {
      const result = await handleWebResearch(
        { url: "http://169.254.169.254/latest/meta-data/" },
        baseContext,
      );
      expect(result.success).toBe(false);
      expect(result.output.toLowerCase()).toMatch(/private|loopback|refusing/);
      expect(mockCacheFetchResult).not.toHaveBeenCalled();
    });

    it("blocks decimal loopback 2130706433 (SSRF encoding)", async () => {
      const result = await handleWebResearch(
        { url: "http://2130706433/secret" },
        baseContext,
      );
      expect(result.success).toBe(false);
      expect(result.output.toLowerCase()).toMatch(/private|loopback|refusing/);
    });

    it("blocks redirect hop to loopback and does not cache (SSRF)", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      delete process.env.TAVILY_API_KEY; // force raw HTTP path
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { Location: "http://127.0.0.1/secret" },
          }),
        );

      const result = await handleWebResearch(
        { url: "https://public.example.com/start" },
        baseContext,
      );
      expect(result.success).toBe(false);
      expect(result.output.toLowerCase()).toMatch(/private|loopback|refusing/);
      // First hop may call fetch; must not cache private outcome.
      expect(mockCacheFetchResult).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
      if (origKey) process.env.TAVILY_API_KEY = origKey;
    });

    it("uses redirect:manual on raw HTTP fetch", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      delete process.env.TAVILY_API_KEY;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("<html><title>OK</title><body>hi</body></html>", { status: 200 }),
      );

      await handleWebResearch({ url: "https://ok.example.com/" }, baseContext);
      expect(fetchSpy).toHaveBeenCalled();
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(init?.redirect).toBe("manual");

      fetchSpy.mockRestore();
      if (origKey) process.env.TAVILY_API_KEY = origKey;
    });

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

    it("falls back to raw HTTP and surfaces failedResults when Tavily extract returns empty", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      // Tavily reports the URL in failedResults — code must log it and still try
      // the raw HTTP fallback (preserving old behavior).
      mockTavilyExtract.mockResolvedValueOnce({
        results: [],
        failedResults: [{ url: "https://blocked.example.com", error: "403 Forbidden" }],
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("<html><title>Blocked Page</title><body>fallback body</body></html>", {
          status: 200,
        }),
      );

      const result = await handleWebResearch(
        { url: "https://blocked.example.com" },
        baseContext,
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.title).toBe("Blocked Page");
      expect(parsed.content).toContain("fallback body");
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      fetchSpy.mockRestore();
      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("falls back to raw HTTP when Tavily extract throws (timeout)", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      mockTavilyExtract.mockRejectedValueOnce(new Error("Request timed out after 25000ms"));
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("<html><title>HTTP OK</title><body>raw body</body></html>", {
          status: 200,
        }),
      );

      const result = await handleWebResearch(
        { url: "https://slow.example.com" },
        baseContext,
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.title).toBe("HTTP OK");
      expect(parsed.content).toContain("raw body");
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      fetchSpy.mockRestore();
      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("rejects plain string (not a url) at Zod boundary", async () => {
      const result = await handleWebResearch({ url: "just-some-text" }, baseContext);
      expect(result.success).toBe(false);
    });

    it("returns cached fetch when available", async () => {
      mockGetCachedFetch.mockResolvedValueOnce({
        markdown: "# Hello World\n\nCached content",
        title: "Hello World",
      });

      const result = await handleWebResearch({ url: "https://example.com" }, baseContext);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.title).toBe("Hello World");
      expect(parsed.content).toContain("Cached content");
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

  // ── Combined branch: search + auto-scrape top N (default 5) ─────

  describe("combined branch (query + auto-scrape)", () => {
    it("auto-scrapes top 5 by default when fetchTop is omitted (single batch extract call)", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      const searchHits = Array.from({ length: 7 }, (_, i) => ({
        title: `Hit ${i}`,
        url: `https://hit${i}.example.com`,
        content: `snippet ${i}`,
      }));
      mockTavilySearch.mockResolvedValueOnce({ results: searchHits });
      // Tavily batch extract returns content for the 5 top URLs in one call.
      mockTavilyExtract.mockResolvedValueOnce({
        results: searchHits.slice(0, 5).map((h, i) => ({
          rawContent: `# ${h.title}\n\nfull ${i}`,
          url: h.url,
          title: h.title,
        })),
        failedResults: [],
      });

      const result = await handleWebResearch({ query: "foo" }, baseContext);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.count).toBe(7);
      expect(parsed.fetchedPages).toHaveLength(5);
      expect(parsed.fetchedPages.every((p: { ok: boolean }) => p.ok)).toBe(true);

      // Critical: ONE batch call, not five separate calls.
      expect(mockTavilyExtract).toHaveBeenCalledTimes(1);
      const [urlsArg, optsArg] = mockTavilyExtract.mock.calls[0]!;
      expect(urlsArg).toHaveLength(5);
      // Targeted extract: original query forwarded for relevance filtering.
      expect((optsArg as { query?: string }).query).toBe("foo");
      expect((optsArg as { timeout?: number }).timeout).toBe(25);

      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("returns search results + fetched top-N pages (explicit fetchTop)", async () => {
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
      const parsed = JSON.parse(result.output);
      expect(parsed.count).toBe(3);
      expect(parsed.fetchedPages).toHaveLength(2);
      // Order may differ from search order — check membership.
      const urls = parsed.fetchedPages.map((p: { url: string }) => p.url).sort();
      expect(urls).toEqual(["https://a.example.com", "https://b.example.com"]);
      expect(parsed.fetchedPages.every((p: { ok: boolean }) => p.ok)).toBe(true);

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
      const parsed = JSON.parse(result.output);
      expect(parsed.count).toBe(1);
      expect(parsed.fetchedPages).toBeUndefined();
      expect(mockTavilyExtract).not.toHaveBeenCalled();

      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("caps fetchTop at the schema max (10)", async () => {
      const result = await handleWebResearch({ query: "foo", fetchTop: 99 }, baseContext);
      expect(result.success).toBe(false);
      // Zod schema rejects fetchTop > 10 at boundary.
    });

    it("reports per-page ok/error: extract returns one result + one explicit failure", async () => {
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
      const parsed = JSON.parse(result.output);
      expect(parsed.fetchedPages).toHaveLength(2);

      const okPage = parsed.fetchedPages.find((p: { url: string }) => p.url === "https://a.example.com");
      const failPage = parsed.fetchedPages.find((p: { url: string }) => p.url === "https://b.example.com");
      expect(okPage.ok).toBe(true);
      expect(okPage.content).toContain("full A");
      expect(failPage.ok).toBe(false);
      expect(failPage.error).toContain("403");

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
          ? { markdown: "cached A body", title: "Cached A" }
          : null,
      );
      mockTavilyExtract.mockResolvedValueOnce({
        results: [{ rawContent: "# B\n\nfull B", url: "https://b.example.com", title: "B" }],
        failedResults: [],
      });

      const result = await handleWebResearch({ query: "foo", fetchTop: 2 }, baseContext);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.fetchedPages).toHaveLength(2);

      // Batch extract called ONCE with only the uncached URL.
      expect(mockTavilyExtract).toHaveBeenCalledTimes(1);
      const [urlsArg] = mockTavilyExtract.mock.calls[0]!;
      expect(urlsArg).toEqual(["https://b.example.com"]);

      // Both pages present — A from cache, B from extract.
      const cachedPage = parsed.fetchedPages.find((p: { url: string }) => p.url === "https://a.example.com");
      expect(cachedPage.title).toBe("Cached A");
      expect(cachedPage.content).toContain("cached A body");

      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });

    it("whole batch failure → fallback raw HTTP per URL", async () => {
      const origKey = process.env.TAVILY_API_KEY;
      process.env.TAVILY_API_KEY = "test-key";
      mockTavilySearch.mockResolvedValueOnce({
        results: [
          { title: "A", url: "https://a.example.com", content: "snippet" },
          { title: "B", url: "https://b.example.com", content: "snippet" },
        ],
      });
      mockTavilyExtract.mockRejectedValueOnce(new Error("Request timed out after 25000ms"));
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response("<html><title>A page</title><body>raw A</body></html>", { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response("<html><title>B page</title><body>raw B</body></html>", { status: 200 }),
        );

      const result = await handleWebResearch({ query: "foo", fetchTop: 2 }, baseContext);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.fetchedPages).toHaveLength(2);
      expect(parsed.fetchedPages.every((p: { ok: boolean }) => p.ok)).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

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
      const parsed = JSON.parse(result.output);
      expect(parsed.fetchedPages).toHaveLength(1);
      expect(parsed.fetchedPages[0].ok).toBe(false);
      expect(parsed.fetchedPages[0].error).toContain("http://");
      // Tavily extract MUST NOT be called when all targets are filtered out.
      expect(mockTavilyExtract).not.toHaveBeenCalled();

      if (origKey) process.env.TAVILY_API_KEY = origKey; else delete process.env.TAVILY_API_KEY;
    });
  });
});
