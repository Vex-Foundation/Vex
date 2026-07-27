/**
 * W2B contract pins for `web_research`.
 *
 * These assert the OUTPUT CONTRACT the Wave-2 plan fixed, through the
 * production handler:
 *
 *  - `externalContentWarning` is the FIRST key of every output shape (owner
 *    directive: the hostile-content label is the first thing the model reads,
 *    not a footnote). JSON.stringify preserves insertion order, so key order is
 *    part of the contract and is pinned here.
 *  - ONE flat `results[]`: the page read is folded onto the row it belongs to
 *    and the snippet is DROPPED on a row whose page was read (the measured 34%
 *    duplication), never truncated anywhere.
 *  - the published-date trio, including the two failure shapes that must never
 *    produce NaN or a fabricated time of day.
 *  - `maxResults` changes the TAVILY REQUEST rather than trimming locally.
 *  - search-only params are rejected BY NAME in `{url}` mode.
 */

import { afterAll, describe, it, expect, vi, beforeEach } from "vitest";

const mockGetCached = vi.fn();
const mockCacheResult = vi.fn();
const mockGetCachedFetch = vi.fn();
const mockCacheFetchResult = vi.fn();

vi.mock("@vex-agent/db/repos/search.js", () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  cacheResult: (...args: unknown[]) => mockCacheResult(...args),
  getCachedFetch: (...args: unknown[]) => mockGetCachedFetch(...args),
  cacheFetchResult: (...args: unknown[]) => mockCacheFetchResult(...args),
}));

const mockTavilySearch = vi.fn();
const mockTavilyExtract = vi.fn();
vi.mock("@tavily/core", () => ({
  tavily: () => ({ search: mockTavilySearch, extract: mockTavilyExtract }),
}));

const { handleWebResearch } = await import("../../../../vex-agent/tools/internal/web.js");
const { RESEARCH_EXTERNAL_CONTENT_WARNING } = await import(
  "../../../../vex-agent/tools/internal/research-provenance.js"
);
import { makeTestContext } from "../_test-context.js";

const ctx = makeTestContext();

interface EmittedRow {
  title: string;
  url: string;
  publishedAt: string | null;
  publishedAtMs: number | null;
  publishedAtPrecision?: string;
  score: number | null;
  snippet?: string;
  pageRead: string;
  pageText?: string;
  pageError?: string;
}

interface EmittedSearch {
  externalContentWarning: string;
  externalContentFields: string[];
  asOfMs: number;
  query: string;
  counts: {
    requested: number;
    returned: number;
    pagesRequested: number;
    pagesRead: number;
    pagesFailed: number;
  };
  filtersApplied: Record<string, unknown>;
  results: EmittedRow[];
}

function parse<T>(output: string): T {
  return JSON.parse(output) as T;
}

/** The provider options of the search request the handler actually issued. */
interface IssuedSearchOptions {
  maxResults?: number;
  topic?: string;
  searchDepth?: string;
  chunksPerSource?: number;
  timeRange?: string;
  timeout?: number;
}

function issuedSearchOptions(): IssuedSearchOptions {
  const call = mockTavilySearch.mock.calls[0];
  if (!call) throw new Error("expected a Tavily search call");
  const [, options] = call;
  return options ?? {};
}

function rowAt(output: string, index: number): EmittedRow {
  const row = parse<EmittedSearch>(output).results[index];
  if (!row) throw new Error(`expected a result row at index ${index}`);
  return row;
}

function searchHit(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: `Hit ${index}`,
    url: `https://hit${index}.example.com`,
    content: `snippet ${index}`,
    score: 0.5 + index / 100,
    ...overrides,
  };
}

describe("web_research — W2B output contract", () => {
  const originalKey = process.env.TAVILY_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCached.mockReset().mockResolvedValue(null);
    mockCacheResult.mockReset().mockResolvedValue(undefined);
    mockGetCachedFetch.mockReset().mockResolvedValue(null);
    mockCacheFetchResult.mockReset().mockResolvedValue(undefined);
    mockTavilySearch.mockReset();
    mockTavilyExtract.mockReset();
    process.env.TAVILY_API_KEY = "test-key";
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = originalKey;
  });

  // ── Warning placement (owner directive) ───────────────────────

  it("puts externalContentWarning FIRST in the search output, followed by externalContentFields", async () => {
    mockTavilySearch.mockResolvedValueOnce({ results: [searchHit(0)] });
    mockTavilyExtract.mockResolvedValueOnce({ results: [], failedResults: [] });

    const result = await handleWebResearch({ query: "foo", fetchTop: 0 }, ctx);
    expect(result.success).toBe(true);
    const keys = Object.keys(parse<EmittedSearch>(result.output));
    expect(keys[0]).toBe("externalContentWarning");
    expect(keys[1]).toBe("externalContentFields");
    const payload = parse<EmittedSearch>(result.output);
    expect(payload.externalContentWarning).toBe(RESEARCH_EXTERNAL_CONTENT_WARNING);
    expect(payload.externalContentFields).toContain("results[].snippet");
  });

  it("puts externalContentWarning FIRST in the {url} fetch output too", async () => {
    mockTavilyExtract.mockResolvedValueOnce({
      results: [{ url: "https://a.example.com/doc", rawContent: "# Doc\n\nbody", title: "Doc" }],
      failedResults: [],
    });

    const result = await handleWebResearch({ url: "https://a.example.com/doc" }, ctx);
    expect(result.success).toBe(true);
    const keys = Object.keys(parse<Record<string, unknown>>(result.output));
    expect(keys[0]).toBe("externalContentWarning");
    expect(keys[1]).toBe("externalContentFields");
  });

  // ── One flat results[] ────────────────────────────────────────

  it("folds the page read onto its row: no fetchedPages array, snippet DROPPED on a scraped row", async () => {
    mockTavilySearch.mockResolvedValueOnce({ results: [searchHit(0), searchHit(1)] });
    mockTavilyExtract.mockResolvedValueOnce({
      results: [{ url: "https://hit0.example.com", rawContent: "extracted body zero", title: "Hit 0" }],
      failedResults: [],
    });

    const result = await handleWebResearch({ query: "foo", fetchTop: 1 }, ctx);
    const payload = parse<EmittedSearch>(result.output);

    expect(payload).not.toHaveProperty("fetchedPages");
    expect(payload).not.toHaveProperty("count");
    expect(payload.results).toHaveLength(2);

    const scraped = rowAt(result.output, 0);
    expect(scraped.pageRead).toBe("ok");
    expect(scraped.pageText).toBe("extracted body zero");
    expect(scraped).not.toHaveProperty("snippet");

    const unscraped = rowAt(result.output, 1);
    expect(unscraped.pageRead).toBe("not_requested");
    expect(unscraped.snippet).toBe("snippet 1");
    expect(unscraped).not.toHaveProperty("pageText");
  });

  it("never re-serializes `Source: <url>` or the title into pageText", async () => {
    mockTavilySearch.mockResolvedValueOnce({ results: [searchHit(0)] });
    mockTavilyExtract.mockResolvedValueOnce({
      results: [{ url: "https://hit0.example.com", rawContent: "body only", title: "Hit 0" }],
      failedResults: [],
    });

    const result = await handleWebResearch({ query: "foo", fetchTop: 1 }, ctx);
    expect(rowAt(result.output, 0).pageText).toBe("body only");
    expect(result.output).not.toContain("Source: https://hit0.example.com");
  });

  it("a failed page read keeps its snippet and reports pageRead:'failed' with the reason", async () => {
    mockTavilySearch.mockResolvedValueOnce({ results: [searchHit(0)] });
    mockTavilyExtract.mockResolvedValueOnce({
      results: [],
      failedResults: [{ url: "https://hit0.example.com", error: "403 Forbidden" }],
    });

    const result = await handleWebResearch({ query: "foo", fetchTop: 1 }, ctx);
    const row = rowAt(result.output, 0);
    expect(row.pageRead).toBe("failed");
    expect(row.pageError).toContain("403");
    expect(row.snippet).toBe("snippet 0");
  });

  // ── Published-date trio ───────────────────────────────────────

  it("emits the published-date trio: second precision for a timestamped value", async () => {
    mockTavilySearch.mockResolvedValueOnce({
      results: [searchHit(0, { publishedDate: "Wed, 22 Jul 2026 14:17:25 GMT" })],
    });

    const result = await handleWebResearch({ query: "foo", fetchTop: 0, topic: "news" }, ctx);
    const row = rowAt(result.output, 0);
    expect(row.publishedAt).toBe("Wed, 22 Jul 2026 14:17:25 GMT");
    expect(row.publishedAtMs).toBe(Date.parse("Wed, 22 Jul 2026 14:17:25 GMT"));
    expect(row.publishedAtPrecision).toBe("second");
  });

  it("a midnight-UTC publisher timestamp is DAY precision — never a fabricated time of day", async () => {
    mockTavilySearch.mockResolvedValueOnce({
      results: [searchHit(0, { publishedDate: "Fri, 24 Jul 2026 00:00:00 GMT" })],
    });

    const result = await handleWebResearch({ query: "foo", fetchTop: 0, topic: "news" }, ctx);
    const row = rowAt(result.output, 0);
    expect(row.publishedAtMs).toBe(Date.parse("2026-07-24T00:00:00Z"));
    expect(row.publishedAtPrecision).toBe("day");
  });

  it("a missing publishedDate yields nulls and NO precision key", async () => {
    mockTavilySearch.mockResolvedValueOnce({ results: [searchHit(0)] });

    const result = await handleWebResearch({ query: "foo", fetchTop: 0 }, ctx);
    const row = rowAt(result.output, 0);
    expect(row.publishedAt).toBeNull();
    expect(row.publishedAtMs).toBeNull();
    expect(row).not.toHaveProperty("publishedAtPrecision");
  });

  it("a MALFORMED publishedDate keeps the provider string but yields null ms — never NaN", async () => {
    mockTavilySearch.mockResolvedValueOnce({
      results: [searchHit(0, { publishedDate: "not a date at all" })],
    });

    const result = await handleWebResearch({ query: "foo", fetchTop: 0, topic: "news" }, ctx);
    const row = rowAt(result.output, 0);
    expect(row.publishedAt).toBe("not a date at all");
    expect(row.publishedAtMs).toBeNull();
    expect(row).not.toHaveProperty("publishedAtPrecision");
    expect(result.output).not.toContain("NaN");
  });

  // ── maxResults is a REQUEST parameter, not a local trim ────────

  it("default call requests maxResults 6 and reads the top 3", async () => {
    mockTavilySearch.mockResolvedValueOnce({ results: [searchHit(0), searchHit(1), searchHit(2)] });
    mockTavilyExtract.mockResolvedValueOnce({
      results: [0, 1, 2].map((i) => ({
        url: `https://hit${i}.example.com`,
        rawContent: `body ${i}`,
        title: `Hit ${i}`,
      })),
      failedResults: [],
    });

    const result = await handleWebResearch({ query: "foo" }, ctx);
    expect(issuedSearchOptions().maxResults).toBe(6);
    const payload = parse<EmittedSearch>(result.output);
    expect(payload.filtersApplied.maxResults).toBe(6);
    expect(payload.filtersApplied.fetchTop).toBe(3);
    expect(payload.counts.pagesRead).toBe(3);
  });

  it("maxResults changes the TAVILY REQUEST and never trims what the provider returned", async () => {
    mockTavilySearch.mockResolvedValueOnce({
      results: [searchHit(0), searchHit(1), searchHit(2), searchHit(3), searchHit(4)],
    });

    const result = await handleWebResearch({ query: "foo", maxResults: 3, fetchTop: 0 }, ctx);
    expect(issuedSearchOptions().maxResults).toBe(3);

    const payload = parse<EmittedSearch>(result.output);
    // Five rows came back for a 3-row request: they are ALL reported. A local
    // trim here would be a silent cut of provider data.
    expect(payload.results).toHaveLength(5);
    expect(payload.counts.requested).toBe(3);
    expect(payload.counts.returned).toBe(5);
  });

  it("rejects maxResults above the cap at the Zod boundary", async () => {
    const result = await handleWebResearch({ query: "foo", maxResults: 25 }, ctx);
    expect(result.success).toBe(false);
    expect(mockTavilySearch).not.toHaveBeenCalled();
  });

  // ── Param contracts ───────────────────────────────────────────

  it("rejects search-only params BY NAME in {url} mode", async () => {
    const result = await handleWebResearch(
      { url: "https://a.example.com", maxResults: 3, topic: "news" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("maxResults");
    expect(result.output).toContain("topic");
    expect(mockTavilyExtract).not.toHaveBeenCalled();
  });

  it("forwards topic and timeRange to the Tavily request and echoes them in filtersApplied", async () => {
    mockTavilySearch.mockResolvedValueOnce({ results: [searchHit(0)] });

    const result = await handleWebResearch(
      { query: "foo", fetchTop: 0, topic: "news", timeRange: "day" },
      ctx,
    );
    expect(issuedSearchOptions().topic).toBe("news");
    expect(issuedSearchOptions().timeRange).toBe("day");
    const payload = parse<EmittedSearch>(result.output);
    expect(payload.filtersApplied.topic).toBe("news");
    expect(payload.filtersApplied.timeRange).toBe("day");
  });

  it("rejects chunksPerSource BY NAME unless searchDepth is advanced (measured: basic ignores it)", async () => {
    const rejected = await handleWebResearch({ query: "foo", chunksPerSource: 1 }, ctx);
    expect(rejected.success).toBe(false);
    expect(rejected.output).toContain("chunksPerSource");
    expect(rejected.output).toContain("advanced");
    expect(mockTavilySearch).not.toHaveBeenCalled();

    mockTavilySearch.mockResolvedValueOnce({ results: [searchHit(0)] });
    const accepted = await handleWebResearch(
      { query: "foo", fetchTop: 0, searchDepth: "advanced", chunksPerSource: 1 },
      ctx,
    );
    expect(accepted.success).toBe(true);
    expect(issuedSearchOptions().chunksPerSource).toBe(1);
  });

  // ── Provenance envelope ───────────────────────────────────────

  it("asOfMs reports the CAPTURE time on a cache hit, not the clock", async () => {
    const capturedAt = Date.now() - 9 * 60 * 1000;
    mockGetCached.mockResolvedValueOnce({
      rows: [
        {
          title: "Cached",
          url: "https://cached.example.com",
          snippet: "cached snippet",
          score: 0.4,
          publishedAt: null,
          publishedAtMs: null,
        },
      ],
      cachedAt: capturedAt,
    });

    const result = await handleWebResearch({ query: "foo", fetchTop: 0 }, ctx);
    const payload = parse<EmittedSearch>(result.output);
    expect(payload.asOfMs).toBe(capturedAt);
    expect(mockTavilySearch).not.toHaveBeenCalled();
  });

  it("counts describe the window and the page reads", async () => {
    mockTavilySearch.mockResolvedValueOnce({ results: [searchHit(0), searchHit(1)] });
    mockTavilyExtract.mockResolvedValueOnce({
      results: [{ url: "https://hit0.example.com", rawContent: "body 0", title: "Hit 0" }],
      failedResults: [{ url: "https://hit1.example.com", error: "timeout" }],
    });

    const result = await handleWebResearch({ query: "foo", maxResults: 6, fetchTop: 2 }, ctx);
    const payload = parse<EmittedSearch>(result.output);
    expect(payload.counts).toEqual({
      requested: 6,
      returned: 2,
      pagesRequested: 2,
      pagesRead: 1,
      pagesFailed: 1,
    });
  });
});
