/**
 * Web research handler — search + page reads in one tool, Tavily-backed, cached.
 *
 * Branches by params:
 *   - `query`                  → search + read the top `fetchTop` results (DEFAULT)
 *   - `query` + `fetchTop: 0`  → search only (snippets, no page reads)
 *   - `url`                    → single-page fetch (http/https only)
 *
 * The page-read path uses Tavily's batch extract: one API call for all uncached
 * URLs (server-side parallelization) with the original query passed through, so
 * the provider returns the passages relevant to the question rather than whole
 * documents.
 *
 * The parameter contract lives in `web-research/search-options.ts`, the output
 * contract in `web-research/result-shape.ts`, publisher-timestamp handling in
 * `web-research/published-date.ts`, and failure wording in
 * `web-research/provider-error.ts` — four different reasons to change, kept out
 * of this file so the handler reads as orchestration.
 *
 * PROVIDER DATA IS UNTRUSTED. The exactly-once accounting below is keyed by
 * what WE requested: duplicates, an URL in both results and failedResults, or a
 * URL we never asked for cannot multiply outcomes or poison the cache.
 *
 * PROVIDER ERROR TEXT IS UNTRUSTED TOO, and it used to be the exception: every
 * failure path interpolated the provider's own words into the model's transcript
 * and into the logs. Every one now goes through `classifyProviderFailure`, which
 * answers with a Vex-owned code and a static message. Nothing on a failure path
 * below may interpolate a provider string again.
 */

import { tavily } from "@tavily/core";
import * as searchRepo from "@vex-agent/db/repos/search.js";
import type { ToolResult } from "../types.js";
import type { InternalToolContext } from "./types.js";
import { ok, fail } from "./types.js";
import logger from "@utils/logger.js";
import { readPublishedAt } from "./web-research/published-date.js";
import {
  WEB_SEARCH_MAX_FETCH_TOP,
  isHttpUrl,
  parseWebResearchRequest,
  type WebSearchOptions,
} from "./web-research/search-options.js";
import {
  buildWebPageOutput,
  buildWebSearchOutput,
  countPageOutcomes,
  foldPageReads,
  type PageOutcome,
  type WebSearchRow,
} from "./web-research/result-shape.js";
import {
  UNREADABLE_CONTENT_FAILURE,
  classifyProviderFailure,
  providerFailureLogFields,
  providerFailureMessage,
  providerFailureReason,
} from "./web-research/provider-error.js";

const SEARCH_TIMEOUT_S = 30;
const EXTRACT_TIMEOUT_S = 25;

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
  const parsed = parseWebResearchRequest(params);
  if (!parsed.success) return fail(`WebResearch: ${parsed.message}`);

  return parsed.request.mode === "page"
    ? fetchUrl(parsed.request.url)
    : searchAndOptionallyFetch(parsed.request.options);
}

// ── Single-page fetch ───────────────────────────────────────────

/**
 * Cache writes are BEST-EFFORT: a failed local write must never discard a
 * usable provider result or masquerade as a Tavily failure — the content is
 * already in hand; only future cache hits are lost.
 */
async function cacheFetchBestEffort(url: string, markdown: string, title: string | null): Promise<void> {
  try {
    await searchRepo.cacheFetchResult(url, markdown, title);
  } catch (err) {
    logger.warn("web.fetch.cache_write_failed", {
      url: url.slice(0, 60),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function fetchUrl(url: string): Promise<ToolResult> {
  const cached = await searchRepo.getCachedFetch(url);
  if (cached) {
    logger.debug("web.fetch.cache_hit", { url: url.slice(0, 60) });
    return ok(
      buildWebPageOutput({
        asOfMs: cached.fetchedAt,
        url,
        title: cached.title,
        pageText: cached.markdown,
      }),
    );
  }

  const client = getTavilyClient();
  if (!client) {
    // Defense-in-depth: the registry hides WebResearch without the key
    // (requiresEnv), so this branch is unreachable via visible tools.
    logger.warn("web.fetch.no_api_key", { hint: "Set TAVILY_API_KEY for web fetch" });
    return fail(
      "Web fetch unavailable — TAVILY_API_KEY not configured. The key is free (tavily.com); add it in Settings to enable web research.",
    );
  }

  try {
    // Tavily's default extract timeout is 10s (basic) / 30s (advanced).
    // We pin 25s so basic depth still has runway before the SDK fires.
    const response = await client.extract([url], { timeout: EXTRACT_TIMEOUT_S });
    // Provider data is untrusted: accept ONLY a result for the URL we
    // requested — a planted result for a different URL must never be served
    // (nor cached under the requested key). Tavily's server-side URL echo is
    // undocumented (SDK verified as byte-verbatim passthrough, 2026-07-19), so
    // a mismatch here is at least as likely benign normalization as an attack —
    // the fail-safe response is an honest fetch failure, never acceptance.
    const extracted = (response.results ?? []).find((r) => r.url === url);
    const mismatched = !extracted && (response.results?.length ?? 0) > 0;
    if (mismatched) {
      logger.warn("web.fetch.unrequested_result", { url: String(response.results?.[0]?.url ?? "").slice(0, 60) });
    }
    if (extracted?.rawContent) {
      const title = extracted.title ?? extracted.rawContent.match(/^#\s+(.+)$/m)?.[1] ?? null;
      await cacheFetchBestEffort(url, extracted.rawContent, title);
      return ok(
        buildWebPageOutput({
          asOfMs: Date.now(),
          url,
          title,
          pageText: extracted.rawContent,
        }),
      );
    }
    // Tavily returned no usable content. Classify the explicit failure when
    // present — the provider's own reason is untrusted text, so it selects a
    // code and is then discarded. There is deliberately NO raw-HTTP fallback:
    // owner decision (2026-07-19) removed direct fetching from the privileged
    // process entirely — Tavily's infrastructure does the fetching, which also
    // removes the local SSRF surface.
    const failedResult = response.failedResults?.find((f) => f.url === url);
    // No failure report and no content is a SHAPE failure Vex determined itself
    // (it also covers the planted-result mismatch above): nothing to classify.
    const failure = failedResult
      ? classifyProviderFailure(failedResult.error)
      : UNREADABLE_CONTENT_FAILURE;
    if (failedResult) {
      logger.warn("web.fetch.tavily_failed_explicit", {
        url: url.slice(0, 60),
        ...providerFailureLogFields(failure),
      });
    }
    return fail(`Fetch failed: ${providerFailureMessage(failure)}`);
  } catch (err) {
    const failure = classifyProviderFailure(err);
    logger.debug("web.fetch.tavily_failed", providerFailureLogFields(failure));
    return fail(`Fetch failed: ${providerFailureMessage(failure)}`);
  }
}

// ── Search (+ optional batch page reads) ────────────────────────

/**
 * The internal seam. Takes an EXPLICIT frozen options object because it has two
 * callers with different needs: the tool handler (agent defaults, 6 rows + 3
 * page reads) and the regime worker (10 rows, no page reads). Neither may
 * inherit the other's defaults — see `search-options.ts`.
 *
 * Exported as an internal function, NOT a ToolDef/registry surface.
 */
export async function searchAndOptionallyFetch(options: WebSearchOptions): Promise<ToolResult> {
  const cacheKey: searchRepo.SearchCacheKeyInput = {
    query: options.query,
    topic: options.topic,
    maxResults: options.maxResults,
    searchDepth: options.searchDepth,
    chunksPerSource: options.chunksPerSource,
    timeRange: options.timeRange,
  };

  const cached = await searchRepo.getCached(cacheKey);
  let rows: WebSearchRow[];
  let capturedAtMs: number;

  if (cached) {
    logger.debug("web.search.cache_hit", { query: options.query.slice(0, 50) });
    rows = cached.rows;
    capturedAtMs = cached.cachedAt;
  } else {
    const client = getTavilyClient();
    if (!client) {
      logger.warn("web.search.no_api_key", { hint: "Set TAVILY_API_KEY for web search" });
      return fail("Web search unavailable — TAVILY_API_KEY not configured");
    }
    try {
      const response = await client.search(options.query, {
        maxResults: options.maxResults,
        timeout: SEARCH_TIMEOUT_S,
        topic: options.topic,
        searchDepth: options.searchDepth,
        ...(options.chunksPerSource !== null ? { chunksPerSource: options.chunksPerSource } : {}),
        ...(options.timeRange !== null ? { timeRange: options.timeRange } : {}),
      });
      rows = (response.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
        score: typeof r.score === "number" && Number.isFinite(r.score) ? r.score : null,
        ...readPublishedAt(r.publishedDate),
      }));
      capturedAtMs = Date.now();
      try {
        await searchRepo.cacheResult(cacheKey, rows);
      } catch (cacheErr) {
        // Best-effort: a failed cache write must not turn a successful search
        // into web.search.failed — the results are already in hand.
        logger.warn("web.search.cache_write_failed", {
          error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        });
      }
      logger.debug("web.search.completed", { count: rows.length, query: options.query.slice(0, 50) });
    } catch (err) {
      const failure = classifyProviderFailure(err);
      logger.warn("web.search.failed", providerFailureLogFields(failure));
      return fail(`Web search failed: ${providerFailureMessage(failure)}`);
    }
  }

  const outcomes = await readTopPages(options, rows);

  // `asOfMs` never overstates freshness: it is the OLDEST capture time in the
  // payload, since search rows and page reads come from caches of different
  // lengths.
  let asOfMs = capturedAtMs;
  for (const outcome of outcomes.values()) {
    if (outcome.state === "ok" && outcome.capturedAtMs < asOfMs) asOfMs = outcome.capturedAtMs;
  }

  return ok(
    buildWebSearchOutput({
      asOfMs,
      options,
      rows: foldPageReads(rows, outcomes),
      counts: {
        requested: options.maxResults,
        returned: rows.length,
        ...countPageOutcomes(outcomes),
      },
    }),
  );
}

/**
 * Read the top `fetchTop` URLs through ONE Tavily batch extract. Returns one
 * outcome per DISTINCT requested URL — a search result set can repeat a URL,
 * and every consumer below must see each URL exactly once.
 */
async function readTopPages(
  options: WebSearchOptions,
  rows: readonly WebSearchRow[],
): Promise<Map<string, PageOutcome>> {
  const outcomes = new Map<string, PageOutcome>();
  if (options.fetchTop <= 0) return outcomes;

  const targets = rows.slice(0, Math.min(options.fetchTop, WEB_SEARCH_MAX_FETCH_TOP, rows.length));
  const uncachedUrls: string[] = [];

  for (const target of targets) {
    if (!target.url) continue;
    if (outcomes.has(target.url) || uncachedUrls.includes(target.url)) continue;
    if (!isHttpUrl(target.url)) {
      outcomes.set(target.url, {
        state: "failed",
        pageError: "Invalid URL — must use http:// or https://",
      });
      continue;
    }
    const cachedFetch = await searchRepo.getCachedFetch(target.url);
    if (cachedFetch) {
      outcomes.set(target.url, {
        state: "ok",
        pageText: cachedFetch.markdown,
        capturedAtMs: cachedFetch.fetchedAt,
      });
    } else {
      uncachedUrls.push(target.url);
    }
  }

  if (uncachedUrls.length === 0) return outcomes;

  const client = getTavilyClient();
  if (!client) {
    // No API key — reading is unavailable (free key: tavily.com).
    for (const url of uncachedUrls) {
      outcomes.set(url, { state: "failed", pageError: "TAVILY_API_KEY not configured" });
    }
    return outcomes;
  }

  const requested = new Set(uncachedUrls); // already unique (deduped above)
  try {
    // Targeted extract: pass `query` so Tavily filters chunks by relevance.
    const response = await client.extract(uncachedUrls, {
      timeout: EXTRACT_TIMEOUT_S,
      query: options.query,
    });

    const fetched = new Map<string, PageOutcome>();
    for (const r of response.results ?? []) {
      if (!requested.has(r.url)) {
        logger.warn("web.fetch.unrequested_result", { url: r.url.slice(0, 60) });
        continue; // never accept — and never cache — what we did not ask for
      }
      if (fetched.get(r.url)?.state === "ok") continue; // first success wins
      if (!r.rawContent) {
        // Still "accounted for" by Tavily — must not vanish, unless a duplicate
        // already produced a real outcome.
        if (!fetched.has(r.url)) {
          fetched.set(r.url, { state: "failed", pageError: "empty content from Tavily extract" });
        }
        continue;
      }
      const title = r.title ?? r.rawContent.match(/^#\s+(.+)$/m)?.[1] ?? null;
      await cacheFetchBestEffort(r.url, r.rawContent, title);
      // Success overrides an earlier failure entry for the same URL.
      fetched.set(r.url, { state: "ok", pageText: r.rawContent, capturedAtMs: Date.now() });
    }
    for (const f of response.failedResults ?? []) {
      if (!requested.has(f.url)) {
        logger.warn("web.fetch.unrequested_failure", { url: f.url.slice(0, 60) });
        continue;
      }
      // The row keeps `pageRead: "failed"`; only the REASON becomes Vex-owned.
      const failure = classifyProviderFailure(f.error);
      logger.warn("web.fetch.tavily_failed_explicit", {
        url: f.url.slice(0, 60),
        ...providerFailureLogFields(failure),
      });
      if (fetched.has(f.url)) continue; // success (or first report) wins
      fetched.set(f.url, { state: "failed", pageError: providerFailureReason(failure) });
    }
    // One outcome per requested URL: anything Tavily left unmentioned is an
    // honest failure (no raw-HTTP fallback exists — owner decision).
    for (const url of requested) {
      outcomes.set(
        url,
        fetched.get(url) ?? { state: "failed", pageError: "not returned by Tavily extract" },
      );
    }
  } catch (err) {
    // Whole batch failed (timeout, auth) — every URL reported as failed. This
    // catch also spans the response loop above, so a provider-shaped crash
    // (a non-string `url`, say) is reported here rather than escaping into the
    // dispatcher's generic catch, which would serialize the raw message.
    const failure = classifyProviderFailure(err);
    logger.warn("web.fetch.tavily_batch_failed", {
      ...providerFailureLogFields(failure),
      count: uncachedUrls.length,
    });
    for (const url of requested) outcomes.set(url, { state: "failed", pageError: providerFailureReason(failure) });
  }

  return outcomes;
}
