/**
 * Web research handler — search + fetch in one tool, Tavily-backed, with cache.
 *
 * Branches by params:
 *   - `query` only             → search + auto-scrape top 5 (DEFAULT)
 *   - `query` + `fetchTop: 0`  → search-only (explicit opt-out)
 *   - `query` + `fetchTop: N`  → search + auto-scrape top N (1-10)
 *   - `url` only               → single-page fetch (http/https only)
 *
 * The auto-scrape path uses Tavily's batch extract: one API call for all
 * uncached URLs (server-side parallelization) with the original query
 * passed through for targeted chunk extraction.
 *
 * SSRF: every raw HTTP hop (and the url-branch entry) runs
 * {@link assertPublicHttpUrl} so loopback / private / link-local destinations
 * never enter tool output or fetch_cache. Redirects are manual and re-checked.
 *
 * Validation lives in {@link WebResearchParams} so the boundary contract is
 * explicit (rule 20: validate at boundaries; rule 00.8: fail clearly).
 */

import { z } from "zod";
import { tavily } from "@tavily/core";
import * as searchRepo from "@vex-agent/db/repos/search.js";
import type { ToolResult } from "../types.js";
import type { InternalToolContext } from "./types.js";
import { ok, fail } from "./types.js";
import logger from "@utils/logger.js";
import {
  assertPublicHttpUrl,
  isHttpUrl,
  PublicHttpUrlError,
} from "./public-http-url.js";

const DEFAULT_SEARCH_LIMIT = 10;   // search returns up to N results
const DEFAULT_FETCH_TOP = 5;       // auto-scrape top N when fetchTop is omitted
const MAX_FETCH_TOP = 10;          // hard cap per call (Tavily allows up to 20)
const FETCH_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_S = 30;
const EXTRACT_TIMEOUT_S = 25;
/** Max redirect hops for raw HTTP (each hop re-validated for public dest). */
const MAX_REDIRECT_HOPS = 5;

const WebResearchParams = z
  .object({
    query: z.string().trim().min(1).optional(),
    url: z
      .string()
      .trim()
      .url()
      .refine(isHttpUrl, { message: "URL must use http:// or https://" })
      .optional(),
    fetchTop: z.number().int().min(0).max(MAX_FETCH_TOP).optional(),
    searchDepth: z.enum(["basic", "advanced"]).optional(),
  })
  // Exactly-one-of (rejects both-set AND neither-set).
  .refine((p) => (p.query !== undefined) !== (p.url !== undefined), {
    message: "Provide exactly one of `query` or `url`",
  })
  // `fetchTop` and `searchDepth` are search-only knobs.
  .refine(
    (p) => !(p.url !== undefined && (p.fetchTop !== undefined || p.searchDepth !== undefined)),
    { message: "`fetchTop` and `searchDepth` apply only to `query` searches, not `url` fetches" },
  );

function getTavilyClient(): ReturnType<typeof tavily> | null {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;
  return tavily({ apiKey: key });
}

// ── handler ──────────────────────────────────────────────────────

export async function handleWebResearch(
  params: Record<string, unknown>,
  _context: InternalToolContext,
): Promise<ToolResult> {
  const parsed = WebResearchParams.safeParse(params);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return fail(`web_research: ${firstIssue?.message ?? "invalid arguments"}`);
  }
  const { query, url, fetchTop, searchDepth } = parsed.data;

  // URL-only branch.
  if (url !== undefined) {
    return fetchUrl(url);
  }

  // Search branch (default: auto-scrape top DEFAULT_FETCH_TOP).
  // The XOR refine above guarantees `query` is defined here, but TypeScript
  // does not narrow through `.refine()` — make the precondition explicit.
  if (query === undefined) {
    return fail("web_research: provide exactly one of `query` or `url`");
  }
  const effectiveFetchTop = fetchTop !== undefined ? fetchTop : DEFAULT_FETCH_TOP;
  return searchAndOptionallyFetch(query, effectiveFetchTop, searchDepth);
}

// ── Single-page fetch (Tavily extract → raw HTTP fallback) ─────

type FetchedPage = {
  url: string;
  title: string | null;
  content: string;
  ok: boolean;
  error?: string;
};

async function fetchUrl(url: string): Promise<ToolResult> {
  // Fail closed before cache / Tavily / raw HTTP so private destinations never
  // re-surface from a pre-policy cache entry either.
  try {
    await assertPublicHttpUrl(url);
  } catch (err) {
    if (err instanceof PublicHttpUrlError) {
      return fail(`web_research: ${err.message}`);
    }
    throw err;
  }

  const cached = await searchRepo.getCachedFetch(url);
  if (cached) {
    logger.debug("web.fetch.cache_hit", { url: url.slice(0, 60) });
    const content = `# ${cached.title ?? "Fetched page"}\n\nSource: ${url}\n\n${cached.markdown}`;
    return ok({ title: cached.title, url, content });
  }

  const client = getTavilyClient();
  if (client) {
    try {
      // Tavily's default extract timeout is 10s (basic) / 30s (advanced).
      // We pin 25s so basic depth still has runway before the SDK fires.
      const response = await client.extract([url], { timeout: EXTRACT_TIMEOUT_S });
      const extracted = response.results?.[0];
      if (extracted?.rawContent) {
        const titleMatch = extracted.rawContent.match(/^#\s+(.+)$/m);
        const title = titleMatch?.[1] ?? null;
        await searchRepo.cacheFetchResult(url, extracted.rawContent, title);
        const content = `# ${title ?? "Fetched page"}\n\nSource: ${url}\n\n${extracted.rawContent}`;
        return ok({ title, url, content });
      }
      // Tavily returned no usable content. If it explicitly listed this URL in
      // failedResults, surface the reason before falling back to raw HTTP.
      const failedResult = response.failedResults?.find((f) => f.url === url);
      if (failedResult) {
        logger.warn("web.fetch.tavily_failed_explicit", {
          url: url.slice(0, 60),
          error: failedResult.error,
        });
      }
    } catch (err) {
      logger.debug("web.fetch.tavily_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Raw HTTP fallback — used when Tavily extract returned empty/errored or no API key.
  const fallback = await fetchUrlRawHttp(url);
  if (fallback.ok) {
    return ok({ title: fallback.title, url: fallback.url, content: fallback.content });
  }
  return fail(`Fetch failed: ${fallback.error ?? "unknown error"}`);
}

// Raw HTTP fetch + parse <title> + slice. Returns FetchedPage shape so it can
// be reused in the batch path's failure recovery without a wrapper.
// Every hop (initial + redirects) is re-validated with assertPublicHttpUrl.
async function fetchUrlRawHttp(url: string): Promise<FetchedPage> {
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      try {
        await assertPublicHttpUrl(current);
      } catch (err) {
        if (err instanceof PublicHttpUrlError) {
          return {
            url: current,
            title: null,
            content: "",
            ok: false,
            error: err.message,
          };
        }
        throw err;
      }

      const res = await fetch(current, {
        headers: { "User-Agent": "Vex/2.0" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "manual",
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) {
          return {
            url: current,
            title: null,
            content: "",
            ok: false,
            error: `HTTP ${res.status}`,
          };
        }
        // Resolve relative Location against the current hop.
        current = new URL(loc, current).href;
        if (hop === MAX_REDIRECT_HOPS) {
          return {
            url: current,
            title: null,
            content: "",
            ok: false,
            error: "Too many redirects",
          };
        }
        continue;
      }

      if (!res.ok) {
        return { url: current, title: null, content: "", ok: false, error: `HTTP ${res.status}` };
      }
      const text = await res.text();
      const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch?.[1]?.trim() ?? null;
      const markdown = text.slice(0, 50_000);
      // Cache under the original request URL (caller identity) only after a
      // successful public fetch — never for blocked private hops.
      await searchRepo.cacheFetchResult(url, markdown, title);
      const content = `# ${title ?? "Fetched page"}\n\nSource: ${current}\n\n${markdown}`;
      return { url: current, title, content, ok: true };
    }
    return { url, title: null, content: "", ok: false, error: "Too many redirects" };
  } catch (err) {
    if (err instanceof PublicHttpUrlError) {
      return { url, title: null, content: "", ok: false, error: err.message };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { url, title: null, content: "", ok: false, error: msg };
  }
}

// ── Search (+ optional batch extract top N) ─────────────────────

// Exported as the regime worker's Tavily seam (S6b FIX-3 analog: an internal
// function, NOT a ToolDef/registry surface). The worker calls it with
// fetchTop=0 — snippets only: fewer credits, smaller injection surface.
export async function searchAndOptionallyFetch(
  query: string,
  fetchTop: number,
  searchDepth: "basic" | "advanced" | undefined,
): Promise<ToolResult> {
  // Search side — cache then API.
  const cached = await searchRepo.getCached(query);
  let results: searchRepo.SearchResult[];

  if (cached) {
    logger.debug("web.search.cache_hit", { query: query.slice(0, 50) });
    results = cached;
  } else {
    const client = getTavilyClient();
    if (!client) {
      logger.warn("web.search.no_api_key", { hint: "Set TAVILY_API_KEY for web search" });
      return fail("Web search unavailable — TAVILY_API_KEY not configured");
    }
    try {
      const response = await client.search(query, {
        maxResults: DEFAULT_SEARCH_LIMIT,
        timeout: SEARCH_TIMEOUT_S,
        ...(searchDepth ? { searchDepth } : {}),
      });
      results = (response.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        content: r.content ?? "",
      }));
      await searchRepo.cacheResult(query, results);
      logger.debug("web.search.completed", { count: results.length, query: query.slice(0, 50) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("web.search.failed", { error: msg });
      return fail(`Web search failed: ${msg}`);
    }
  }

  // Explicit opt-out: fetchTop=0 → return search-only payload (no scraping).
  if (fetchTop <= 0) {
    return ok({ count: results.length, results });
  }

  // Auto-fetch top N URLs via Tavily batch extract: one API call for all
  // uncached, http/https URLs (server-side parallel). Per-URL cache keeps
  // credit burn bounded on repeated/related queries.
  const targets = results.slice(0, Math.min(fetchTop, MAX_FETCH_TOP, results.length));
  const fetchedPages: FetchedPage[] = [];
  const uncachedUrls: string[] = [];

  for (const target of targets) {
    if (!target.url) continue;
    if (!isHttpUrl(target.url)) {
      fetchedPages.push({
        url: target.url,
        title: null,
        content: "",
        ok: false,
        error: "Invalid URL — must use http:// or https://",
      });
      continue;
    }
    const cachedFetch = await searchRepo.getCachedFetch(target.url);
    if (cachedFetch) {
      const content = `# ${cachedFetch.title ?? "Fetched page"}\n\nSource: ${target.url}\n\n${cachedFetch.markdown}`;
      fetchedPages.push({
        url: target.url,
        title: cachedFetch.title,
        content,
        ok: true,
      });
    } else {
      uncachedUrls.push(target.url);
    }
  }

  if (uncachedUrls.length > 0) {
    const client = getTavilyClient();
    if (client) {
      try {
        // Targeted extract: pass `query` so Tavily filters chunks by relevance.
        const response = await client.extract(uncachedUrls, {
          timeout: EXTRACT_TIMEOUT_S,
          query,
        });

        // Successful results — cache + push.
        for (const r of response.results ?? []) {
          if (!r.rawContent) continue;
          const titleMatch = r.rawContent.match(/^#\s+(.+)$/m);
          const title = r.title ?? titleMatch?.[1] ?? null;
          await searchRepo.cacheFetchResult(r.url, r.rawContent, title);
          const content = `# ${title ?? "Fetched page"}\n\nSource: ${r.url}\n\n${r.rawContent}`;
          fetchedPages.push({ url: r.url, title, content, ok: true });
        }

        // Explicit failures — log + push as ok:false.
        for (const f of response.failedResults ?? []) {
          logger.warn("web.fetch.tavily_failed_explicit", {
            url: f.url.slice(0, 60),
            error: f.error,
          });
          fetchedPages.push({ url: f.url, title: null, content: "", ok: false, error: f.error });
        }

        // Orphans (URLs neither in results nor failedResults) — fallback raw HTTP.
        const accountedFor = new Set([
          ...(response.results ?? []).map((r) => r.url),
          ...(response.failedResults ?? []).map((f) => f.url),
        ]);
        const orphans = uncachedUrls.filter((u) => !accountedFor.has(u));
        for (const url of orphans) {
          fetchedPages.push(await fetchUrlRawHttp(url));
        }
      } catch (err) {
        // Whole batch failed (timeout, auth) — fallback raw HTTP per URL.
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("web.fetch.tavily_batch_failed", { error: msg, count: uncachedUrls.length });
        for (const url of uncachedUrls) {
          fetchedPages.push(await fetchUrlRawHttp(url));
        }
      }
    } else {
      // No API key — raw HTTP per URL.
      for (const url of uncachedUrls) {
        fetchedPages.push(await fetchUrlRawHttp(url));
      }
    }
  }

  return ok({
    count: results.length,
    results,
    fetchedPages,
  });
}
