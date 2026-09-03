/**
 * What `WebResearch` hands the model.
 *
 * ONE FLAT `results[]`. The old shape billed every scraped URL twice: once as a
 * search row with its snippet and again as a `fetchedPages` entry with the
 * extract of the same page. Measured on the recorded probes that duplication
 * was 3,179–9,673 B per call, up to 34 % of the payload. The page read is now
 * FOLDED onto the row it belongs to, and on a row that was read the snippet is
 * DROPPED - not shortened. That is projection (removing a value duplicated
 * elsewhere in the same payload), never truncation; the coordinator confirmed
 * first-hand that a snippet can be page-chrome junk while the scrape of the
 * same URL is clean structured markdown, so the extract is strictly the better
 * of the two.
 *
 * The page text is emitted RAW. The old code prefixed every extract with
 * `` `# ${title}\n\nSource: ${url}\n\n` `` while `title` and `url` sat beside it
 * as fields - 460–1,392 B per call of re-serialised header.
 *
 * `pageRead` is a discriminant, not a boolean: "never asked for" and "asked for
 * and failed" are different facts and the old `ok: boolean` could not tell them
 * apart. A page that could not be read is reported on its own row with the
 * reason - never dropped, never substituted.
 *
 * `asOfMs` is the OLDEST capture time in the payload, not the clock: search
 * rows come from a 15-minute cache and page reads from a 60-minute one, so a
 * response can mix freshness. Reporting the oldest component is the reading
 * that cannot overstate how current the evidence is.
 */

import {
  RESEARCH_EXTERNAL_CONTENT_WARNING,
  collectExternalContentFields,
  collectExternalContentPatterns,
} from "../research-provenance.js";
import type { PublishedAtFields } from "./published-date.js";
import type { WebSearchOptions } from "./search-options.js";

/** A search row as the provider returned it - also the search cache's row shape. */
export interface WebSearchRow extends PublishedAtFields {
  title: string;
  url: string;
  snippet: string;
  /** Tavily's own relevance score, populated on every observed row. */
  score: number | null;
}

export type PageReadState = "ok" | "failed" | "not_requested";

/** The outcome of ONE page read, keyed by URL by the handler. */
export type PageOutcome =
  | { readonly state: "ok"; readonly pageText: string; readonly capturedAtMs: number }
  | { readonly state: "failed"; readonly pageError: string };

export interface WebResultRow extends PublishedAtFields {
  title: string;
  url: string;
  score: number | null;
  snippet?: string;
  pageRead: PageReadState;
  pageText?: string;
  pageError?: string;
}

export interface WebSearchCounts {
  /** What we asked Tavily for (`maxResults`). */
  requested: number;
  /** What Tavily returned - it can differ in both directions. */
  returned: number;
  /** Distinct URLs we attempted to read. */
  pagesRequested: number;
  pagesRead: number;
  pagesFailed: number;
}

const SEARCH_EXTERNAL_PATHS = ["title", "snippet", "pageText", "url"] as const;

/**
 * `{url}` mode flags only provider-authored values. The URL itself came from
 * the CALLER there, so labelling it as third-party text would be wrong.
 */
const PAGE_EXTERNAL_PATHS = ["title", "pageText"] as const;

export interface WebSearchOutput {
  externalContentWarning: string;
  externalContentFields: string[];
  asOfMs: number;
  query: string;
  counts: WebSearchCounts;
  filtersApplied: Record<string, string | number>;
  results: WebResultRow[];
}

export interface WebPageOutput {
  externalContentWarning: string;
  externalContentFields: string[];
  asOfMs: number;
  url: string;
  title: string | null;
  pageText: string;
}

/** Fold each page-read outcome onto its row; drop the snippet where a page was read. */
export function foldPageReads(
  rows: readonly WebSearchRow[],
  outcomes: ReadonlyMap<string, PageOutcome>,
): WebResultRow[] {
  return rows.map((row) => {
    const outcome = outcomes.get(row.url);
    const projected: WebResultRow = {
      title: row.title,
      url: row.url,
      publishedAt: row.publishedAt,
      publishedAtMs: row.publishedAtMs,
      ...(row.publishedAtPrecision !== undefined
        ? { publishedAtPrecision: row.publishedAtPrecision }
        : {}),
      score: row.score,
      pageRead: outcome?.state ?? "not_requested",
    };
    if (outcome?.state === "ok") {
      projected.pageText = outcome.pageText;
      return projected;
    }
    // No page text on this row: the snippet is the only content it carries.
    projected.snippet = row.snippet;
    if (outcome?.state === "failed") projected.pageError = outcome.pageError;
    return projected;
  });
}

export function countPageOutcomes(outcomes: ReadonlyMap<string, PageOutcome>): {
  pagesRequested: number;
  pagesRead: number;
  pagesFailed: number;
} {
  let pagesRead = 0;
  let pagesFailed = 0;
  for (const outcome of outcomes.values()) {
    if (outcome.state === "ok") pagesRead += 1;
    else pagesFailed += 1;
  }
  return { pagesRequested: outcomes.size, pagesRead, pagesFailed };
}

function filtersApplied(options: WebSearchOptions): Record<string, string | number> {
  const applied: Record<string, string | number> = {
    maxResults: options.maxResults,
    fetchTop: options.fetchTop,
    topic: options.topic,
    searchDepth: options.searchDepth,
  };
  if (options.chunksPerSource !== null) applied.chunksPerSource = options.chunksPerSource;
  if (options.timeRange !== null) applied.timeRange = options.timeRange;
  return applied;
}

export function buildWebSearchOutput(input: {
  readonly asOfMs: number;
  readonly options: WebSearchOptions;
  readonly rows: readonly WebResultRow[];
  readonly counts: WebSearchCounts;
}): WebSearchOutput {
  // Key order IS the contract: the hostile-content label leads the payload.
  return {
    externalContentWarning: RESEARCH_EXTERNAL_CONTENT_WARNING,
    externalContentFields: collectExternalContentPatterns(
      input.rows,
      "results",
      SEARCH_EXTERNAL_PATHS,
    ),
    asOfMs: input.asOfMs,
    query: input.options.query,
    counts: input.counts,
    filtersApplied: filtersApplied(input.options),
    results: [...input.rows],
  };
}

export function buildWebPageOutput(input: {
  readonly asOfMs: number;
  readonly url: string;
  readonly title: string | null;
  readonly pageText: string;
}): WebPageOutput {
  const page = { title: input.title, pageText: input.pageText };
  return {
    externalContentWarning: RESEARCH_EXTERNAL_CONTENT_WARNING,
    externalContentFields: collectExternalContentFields(page, PAGE_EXTERNAL_PATHS, ""),
    asOfMs: input.asOfMs,
    url: input.url,
    title: input.title,
    pageText: input.pageText,
  };
}
