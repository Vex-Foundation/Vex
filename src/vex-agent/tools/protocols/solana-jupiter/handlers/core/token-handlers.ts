/**
 * Jupiter read handlers — prices, token search, token trending.
 *
 * Extracted verbatim from `../core.ts` as part of a façade-preserving
 * structural split; `../core.ts` assembles these into `CORE_HANDLERS`.
 *
 * This module owns the concise-projection wiring (`projectJupiterTokens`) for
 * the two read tools — the capture-safety fence pinned by
 * `solana-jupiter-projectors.test.ts` lives here now.
 */

import {
  searchJupiterTokens,
  getJupiterTokensByCategory,
  getJupiterTokensByTag,
  getJupiterRecentTokens,
} from "@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js";
import type {
  JupiterTokenCategory,
  JupiterTokenTag,
  JupiterTokenInterval,
  JupiterTokenStatsInterval,
} from "@tools/solana-ecosystem/jupiter/jupiter-tokens/types.js";
import {
  filterJupiterTokensByThreshold,
  validateJupiterTokenThresholdFilters,
  type JupiterTokenThresholdFilters,
} from "@tools/solana-ecosystem/jupiter/jupiter-tokens/token-filters.js";
import {
  getJupiterPricesByMint,
  getJupiterPricesForTokenQueries,
} from "@tools/solana-ecosystem/jupiter/jupiter-prices/service.js";

import type { ProtocolHandler } from "../../../types.js";
import { str, num, bool, ok, fail, strArray } from "../../../handler-helpers.js";
import { projectJupiterTokens } from "../../projectors.js";

// ── Category routing for tokens.trending ─────────────────────────

// Membership uses Sets (not the maps' `in` operator) so prototype keys like
// "constructor"/"toString" cannot pass a check and route to an undefined value.
const VALID_TAGS = new Set<JupiterTokenTag>(["lst", "verified", "stocks"]);
const VALID_CATEGORIES = new Set<string>([
  "toptrending",
  "toptraded",
  "toporganicscore",
  "recent",
  "lst",
  "verified",
  "stocks",
]);
const VALID_INTERVALS = new Set<JupiterTokenInterval>(["5m", "1h", "6h", "24h"]);
// Vex-side output-shaping knob (never sent to Jupiter) — see projectors.ts's
// `ProjectJupiterTokenOptions.statsInterval`. "all" is Vex's own escape hatch.
const VALID_STATS_INTERVALS = new Set<JupiterTokenStatsInterval>(["5m", "1h", "6h", "24h", "all"]);

export const TOKEN_READ_HANDLERS: Record<string, ProtocolHandler> = {
  // Core — prices
  //
  // Two mutually-exclusive lookup shapes: `mints` (raw addresses, unchanged
  // fast path) or `queries` (symbols/names/mints, resolved via
  // `getJupiterPricesForTokenQueries` — collapses the former
  // tokens.search → prices two-hop into one call). Jupiter's `/price/v3`
  // silently omits any id it cannot price rather than erroring or returning
  // a null placeholder (confirmed live: `price-v3-bogus-mint.json` fixture
  // returns `200 {}` for an unresolvable mint) — both branches diff the
  // request against the response and surface an explicit `missing` list so
  // that silent omission never reaches the agent unexplained.
  "solana.prices": async (p) => {
    const mints = strArray(p, "mints");
    const queries = strArray(p, "queries");

    if (mints && queries) return fail("Provide either mints or queries, not both.");

    if (queries) {
      const { resolved, raw } = await getJupiterPricesForTokenQueries(queries);
      const missing = resolved.filter((entry) => !entry.found).map((entry) => entry.query);
      return ok({ resolved, raw, missing });
    }

    if (mints) {
      const prices = await getJupiterPricesByMint(mints);
      const missing = mints.filter((mint) => !Object.hasOwn(prices, mint));
      return ok({ prices, missing });
    }

    return fail("Missing required parameter: mints or queries.");
  },

  // Core — token search
  "solana.tokens.search": async (p) => {
    const q = str(p, "query");
    if (!q) return fail("Missing required parameter: query");

    const rawStatsInterval = str(p, "statsInterval");
    const statsInterval = (rawStatsInterval || "1h") as JupiterTokenStatsInterval;
    if (!VALID_STATS_INTERVALS.has(statsInterval)) {
      return fail("Unknown statsInterval '" + rawStatsInterval + "'. Valid stats intervals: 5m, 1h, 6h, 24h, all.");
    }

    const filters: JupiterTokenThresholdFilters = {
      minOrganicScore: num(p, "minOrganicScore"),
      verifiedOnly: bool(p, "verifiedOnly"),
      minLiquidity: num(p, "minLiquidity"),
    };
    const filterError = validateJupiterTokenThresholdFilters(filters);
    if (filterError) return fail(filterError);

    // Project the raw ~40-field JupiterMintInformation to the concise signal
    // set before emitting (P0-3c) — read tool, no _tradeCapture, safe to trim.
    // Threshold filters (Vex-side, no server-side equivalent — W1-G) apply to
    // the raw array BEFORE projection.
    const tokens = filterJupiterTokensByThreshold(await searchJupiterTokens(q), filters);
    return ok(projectJupiterTokens(tokens, { statsInterval }));
  },

  // Core — token trending (routes to category, recent, or tag)
  "solana.tokens.trending": async (p) => {
    const category = str(p, "category") || "toptrending";
    const interval = (str(p, "interval") || "1h") as JupiterTokenInterval;
    const limit = num(p, "limit") ?? 20;

    // Guard a PRESENT-but-unrecognized category (don't silently fall back to toptrending).
    if (str(p, "category") && !VALID_CATEGORIES.has(category)) {
      return fail("Unknown category '" + category + "'. Valid categories: toptrending, toptraded, toporganicscore, recent, lst, verified, stocks.");
    }
    // Guard a PRESENT-but-unrecognized interval (don't let it fail deep in the client with a generic HTTP error).
    if (str(p, "interval") && !VALID_INTERVALS.has(interval)) {
      return fail("Unknown interval '" + interval + "'. Valid intervals: 5m, 1h, 6h, 24h.");
    }

    // Vex-side output-shaping knob (W1-G): defaults to the resolved `interval`
    // above so a caller who only sets `interval` gets a matching single stats
    // window, not all four — explicit "all" opts back into every window.
    const rawStatsInterval = str(p, "statsInterval");
    const statsInterval = (rawStatsInterval || interval) as JupiterTokenStatsInterval;
    if (!VALID_STATS_INTERVALS.has(statsInterval)) {
      return fail("Unknown statsInterval '" + rawStatsInterval + "'. Valid stats intervals: 5m, 1h, 6h, 24h, all.");
    }

    // Vex-side threshold filters (W1-G) — Jupiter has no server-side
    // organicScore/liquidity/verification filter on any read endpoint
    // (recon-docs-tokens.md §7); applied to the raw array BEFORE projection.
    const filters: JupiterTokenThresholdFilters = {
      minOrganicScore: num(p, "minOrganicScore"),
      verifiedOnly: bool(p, "verifiedOnly"),
      minLiquidity: num(p, "minLiquidity"),
    };
    const filterError = validateJupiterTokenThresholdFilters(filters);
    if (filterError) return fail(filterError);

    // Every return path maps the raw token array through the concise projector
    // (P0-3c) so default-limit trending stays under the overflow threshold.
    //
    // The recent and tag endpoints take NO server-side limit, so `limit` is
    // applied here as a VISIBLE window: the pre-fix recent branch ignored the
    // advertised `limit` entirely and a bare live call measured 27,970 B
    // against the 16,384 B tool-output cap. Windowing is accounted, never
    // silent — `totalMatched`/`hasMore` expose what the window holds back.
    const windowed = (tokens: readonly unknown[]): {
      returned: number;
      totalMatched: number;
      hasMore: boolean;
      tokens: readonly unknown[];
    } => ({
      returned: Math.min(tokens.length, limit),
      totalMatched: tokens.length,
      hasMore: tokens.length > limit,
      tokens: tokens.slice(0, limit),
    });
    if (category === "recent") {
      const tokens = filterJupiterTokensByThreshold(await getJupiterRecentTokens(), filters);
      return ok(windowed(projectJupiterTokens(tokens, { statsInterval })));
    }
    // Casts are safe: membership was validated by the Sets above (recent + tags
    // handled here; unknown categories already failed), so `category` is one of
    // the real tag/category literals.
    if (VALID_TAGS.has(category as JupiterTokenTag)) {
      const tokens = filterJupiterTokensByThreshold(
        await getJupiterTokensByTag(category as JupiterTokenTag),
        filters,
      );
      return ok(windowed(projectJupiterTokens(tokens, { statsInterval })));
    }
    const tokens = filterJupiterTokensByThreshold(
      await getJupiterTokensByCategory({ category: category as JupiterTokenCategory, interval, limit }),
      filters,
    );
    // The category endpoint got `limit` server-side; the same envelope keeps
    // the output contract identical across every branch.
    return ok(windowed(projectJupiterTokens(tokens, { statsInterval })));
  },
};
