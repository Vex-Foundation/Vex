/**
 * The `WebResearch` parameter boundary: what the agent may ask for, what the
 * defaults are, and what a request means once resolved.
 *
 * TWO CALLERS, ONE CONTRACT. The tool handler builds options from LLM params;
 * the regime worker builds its own (`regime-worker.ts`). The options object is
 * explicit and FROZEN in both cases — every field spelled out at the call site —
 * so a change to the agent-facing default can never silently shrink the regime
 * classifier's evidence set. That failure has a precedent: the classifier ran
 * Tavily-only for a month because a source degraded quietly.
 *
 * DEFAULTS ARE A BYTE BUDGET. `maxResults: 6` + `fetchTop: 3` lands a typical
 * default call near 12 KB, measured from the
 * live per-row means (snippet ≈ 1.0 KB, page read ≈ 2.1 KB). The previous
 * hardcoded shape (10 rows + 5 reads) measured 14,753 B and 16,470 B minutes
 * apart on the SAME query — a coin flip, not a margin.
 *
 * REJECT, DO NOT IGNORE. A param that does not apply is rejected BY NAME rather
 * than dropped: silently discarding a value the caller supplied is the failure
 * mode `rules/90` names for fee and limit params, and it applies to research
 * params for the same reason — the agent believes it asked for something it did
 * not get.
 */

import { z } from "zod";

import { dropEmptyModelValues, formatZodIssueForModel } from "../arg-validation.js";

export const WEB_SEARCH_DEFAULT_MAX_RESULTS = 6;
export const WEB_SEARCH_MAX_RESULTS_CAP = 10;
export const WEB_SEARCH_DEFAULT_FETCH_TOP = 3;
export const WEB_SEARCH_MAX_FETCH_TOP = 10;
export const WEB_SEARCH_MAX_CHUNKS_PER_SOURCE = 5;

export type WebSearchTopic = "general" | "news";
export type WebSearchDepth = "basic" | "advanced";
export type WebSearchTimeRange = "day" | "week" | "month" | "year";

/** Every field is required: a caller states its whole request, never inherits it. */
export interface WebSearchOptions {
  readonly query: string;
  readonly maxResults: number;
  readonly fetchTop: number;
  readonly topic: WebSearchTopic;
  readonly searchDepth: WebSearchDepth;
  readonly chunksPerSource: number | null;
  readonly timeRange: WebSearchTimeRange | null;
}

export function freezeWebSearchOptions(options: WebSearchOptions): WebSearchOptions {
  return Object.freeze({ ...options });
}

export type WebResearchRequest =
  | { readonly mode: "page"; readonly url: string }
  | { readonly mode: "search"; readonly options: WebSearchOptions };

/**
 * Zod's `z.string().url()` accepts every RFC-3986 scheme (ftp, file, mailto,
 * data, …). Tavily only fetches http(s); guard explicitly. Applied at the Zod
 * boundary AND per target URL inside the batch path.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Params that describe a SEARCH and are meaningless on a single-page fetch. */
const SEARCH_ONLY_PARAMS = [
  "query",
  "maxResults",
  "fetchTop",
  "topic",
  "searchDepth",
  "chunksPerSource",
  "timeRange",
] as const;

const WebResearchParams = z
  .object({
    query: z.string().trim().min(1).optional(),
    url: z
      .string()
      .trim()
      .url()
      .refine(isHttpUrl, { message: "URL must use http:// or https://" })
      .optional(),
    maxResults: z.number().int().min(1).max(WEB_SEARCH_MAX_RESULTS_CAP).optional(),
    fetchTop: z.number().int().min(0).max(WEB_SEARCH_MAX_FETCH_TOP).optional(),
    topic: z.enum(["general", "news"]).optional(),
    searchDepth: z.enum(["basic", "advanced"]).optional(),
    chunksPerSource: z.number().int().min(1).max(WEB_SEARCH_MAX_CHUNKS_PER_SOURCE).optional(),
    timeRange: z.enum(["day", "week", "month", "year"]).optional(),
  })
  .superRefine((params, ctx) => {
    // Exactly-one-of (rejects both-set AND neither-set).
    if ((params.query !== undefined) === (params.url !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of `query` or `url`",
      });
      return;
    }

    if (params.url !== undefined) {
      const offenders = SEARCH_ONLY_PARAMS.filter(
        (name) => name !== "query" && params[name] !== undefined,
      );
      if (offenders.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `${offenders.map((name) => `\`${name}\``).join(", ")} apply only to \`query\` `
            + "searches, not `url` fetches",
        });
      }
      return;
    }

    // Measured live (2026-07-27, 3-row control per call): at basic depth Tavily
    // ignores chunksPerSource — rows stayed 459–2,251 B with `chunksPerSource: 1`
    // — while at advanced depth the same request bounded every row to 720–755 B.
    // Forwarding it at basic depth would be a param silently dropped.
    if (params.chunksPerSource !== undefined && params.searchDepth !== "advanced") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "`chunksPerSource` requires `searchDepth: \"advanced\"` — measured live, basic depth "
          + "ignores it (rows stayed 459–2,251 B) while advanced honours it (720–755 B)",
      });
    }
  });

export type WebResearchParseResult =
  | { readonly success: true; readonly request: WebResearchRequest }
  | { readonly success: false; readonly message: string };

/** Validate raw LLM params and resolve them into one explicit request. */
export function parseWebResearchRequest(params: Record<string, unknown>): WebResearchParseResult {
  // Empty means ABSENT before the exactly-one-of refine runs. `{query: "",
  // url: "https://…"}` — the model filling both advertised fields and meaning
  // only the second — used to die on a pathless "Too small: expected string to
  // have >=1 characters" instead of simply fetching the page; and `{query:
  // ""}` alone now gets the refine's actual instruction rather than a size
  // complaint about a field it thought it had left blank.
  const parsed = WebResearchParams.safeParse(dropEmptyModelValues(params));
  if (!parsed.success) {
    return {
      success: false,
      message: formatZodIssueForModel(parsed.error.issues[0], params),
    };
  }

  const { query, url, maxResults, fetchTop, topic, searchDepth, chunksPerSource, timeRange } =
    parsed.data;

  if (url !== undefined) return { success: true, request: { mode: "page", url } };
  if (query === undefined) {
    // Unreachable through the refine above; kept because TypeScript cannot
    // narrow through it and a silent `undefined` query would search for "".
    return { success: false, message: "Provide exactly one of `query` or `url`" };
  }

  return {
    success: true,
    request: {
      mode: "search",
      options: freezeWebSearchOptions({
        query,
        maxResults: maxResults ?? WEB_SEARCH_DEFAULT_MAX_RESULTS,
        fetchTop: fetchTop ?? WEB_SEARCH_DEFAULT_FETCH_TOP,
        topic: topic ?? "general",
        searchDepth: searchDepth ?? "basic",
        chunksPerSource: chunksPerSource ?? null,
        timeRange: timeRange ?? null,
      }),
    },
  };
}
