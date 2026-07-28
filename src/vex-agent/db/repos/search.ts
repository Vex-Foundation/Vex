/**
 * Search/fetch cache repo — Tavily results cached in Postgres.
 *
 * THE KEY IS THE REQUEST, NOT THE QUERY (W2B). While `web_research` hardcoded
 * one search shape, hashing the bare query was sufficient. Now that `topic`,
 * `maxResults`, `searchDepth`, `chunksPerSource` and `timeRange` are all
 * agent-settable — and `topic: "news"` is the ONLY way to get publication dates
 * at all — a bare-query key would serve a cached 6-row general response to a
 * 10-row news request and call it an answer. The key is the normalized
 * effective-options tuple; rows written under the old key simply never match,
 * which is the intended migration (a 15-minute cache does not need a backfill).
 *
 * Cached rows are DB input, therefore untrusted (`rules/03`): they are
 * validated on read and a row set that no longer matches the projection is
 * treated as a miss rather than shipped to the model.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { queryOne, execute } from "../client.js";
import { jsonb } from "../params.js";

const SEARCH_TTL_MS = 15 * 60 * 1000;
const FETCH_TTL_MS = 60 * 60 * 1000;

/** Bumped whenever the cached ROW SHAPE changes, so old rows cannot be read. */
const SEARCH_CACHE_SHAPE_VERSION = "v2";

/** The projected search row — must stay in step with `web-research/result-shape.ts`. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number | null;
  publishedAt: string | null;
  publishedAtMs: number | null;
  publishedAtPrecision?: "day" | "second";
}

const SearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  score: z.number().nullable(),
  publishedAt: z.string().nullable(),
  publishedAtMs: z.number().nullable(),
  publishedAtPrecision: z.enum(["day", "second"]).optional(),
});

const CachedRowsSchema = z.array(SearchResultSchema);

/** Every input that changes what Tavily returns. Enumerated here, pinned by test. */
export interface SearchCacheKeyInput {
  query: string;
  topic: "general" | "news";
  maxResults: number;
  searchDepth: "basic" | "advanced";
  chunksPerSource: number | null;
  timeRange: "day" | "week" | "month" | "year" | null;
}

export interface SearchCacheEntry {
  rows: SearchResult[];
  /** When the provider data was captured — what the payload reports as `asOfMs`. */
  cachedAt: number;
}

export interface FetchResult {
  markdown: string;
  title: string | null;
  /** When the page was captured. */
  fetchedAt: number;
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * The cache key. Field order is fixed and every field is named in the string,
 * so adding an option to the request without adding it here is visible in the
 * diff rather than silent at runtime.
 */
export function searchCacheKeyHash(input: SearchCacheKeyInput): string {
  return hashKey(
    [
      SEARCH_CACHE_SHAPE_VERSION,
      `q=${input.query.toLowerCase().trim()}`,
      `topic=${input.topic}`,
      `max=${input.maxResults}`,
      `depth=${input.searchDepth}`,
      `chunks=${input.chunksPerSource ?? "none"}`,
      `range=${input.timeRange ?? "none"}`,
    ].join("|"),
  );
}

// ── Search cache ────────────────────────────────────────────────────

export async function getCached(input: SearchCacheKeyInput): Promise<SearchCacheEntry | null> {
  const hash = searchCacheKeyHash(input);
  const row = await queryOne<{ results: unknown; cached_at: string }>(
    "SELECT results, cached_at FROM search_cache WHERE query_hash = $1",
    [hash],
  );
  if (!row) return null;
  const cachedAt = new Date(row.cached_at).getTime();
  if (!Number.isFinite(cachedAt) || Date.now() - cachedAt > SEARCH_TTL_MS) {
    await execute("DELETE FROM search_cache WHERE query_hash = $1", [hash]);
    return null;
  }
  const parsed = CachedRowsSchema.safeParse(row.results);
  if (!parsed.success) return null;
  return { rows: parsed.data, cachedAt };
}

export async function cacheResult(
  input: SearchCacheKeyInput,
  results: readonly SearchResult[],
): Promise<void> {
  await execute(
    `INSERT INTO search_cache (query_hash, query, results) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (query_hash) DO UPDATE SET results = $3::jsonb, cached_at = NOW()`,
    [searchCacheKeyHash(input), input.query, jsonb(results)],
  );
}

// ── Fetch cache ─────────────────────────────────────────────────────

export async function getCachedFetch(url: string): Promise<FetchResult | null> {
  const hash = hashKey(url.toLowerCase().trim());
  const row = await queryOne<{ markdown: string; title: string | null; fetched_at: string }>(
    "SELECT markdown, title, fetched_at FROM fetch_cache WHERE url_hash = $1",
    [hash],
  );
  if (!row) return null;
  const fetchedAt = new Date(row.fetched_at).getTime();
  if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > FETCH_TTL_MS) {
    await execute("DELETE FROM fetch_cache WHERE url_hash = $1", [hash]);
    return null;
  }
  return { markdown: row.markdown, title: row.title, fetchedAt };
}

export async function cacheFetchResult(url: string, markdown: string, title: string | null): Promise<void> {
  const hash = hashKey(url.toLowerCase().trim());
  await execute(
    `INSERT INTO fetch_cache (url_hash, url, markdown, title) VALUES ($1, $2, $3, $4)
     ON CONFLICT (url_hash) DO UPDATE SET markdown = $3, title = $4, fetched_at = NOW()`,
    [hash, url, markdown, title],
  );
}
