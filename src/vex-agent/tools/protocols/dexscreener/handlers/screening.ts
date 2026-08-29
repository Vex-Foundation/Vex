/**
 * Handlers for the site screening family, the chain catalog and the token
 * screen (8 tools).
 *
 * Thin by design. Everything that could be wrong in an interesting way already
 * has an owner in `src/tools/dexscreener/`: the wire grammar and the filter
 * whitelist in `screen-core/request.ts`, the row projection and the derived
 * metrics in `screen-core/project.ts`, the field groups and the issuer-text
 * sanitization in `screen-core/fields.ts`, the accounting invariant in
 * `screen-core/envelope.ts`, and the chain vocabulary in
 * `endpoints/chains-catalog.ts`. What is left here is the per-tool decision:
 * which sort key is pinned, which default floors apply, and what the summary
 * sentence says.
 *
 * THE ONE RULE THIS MODULE ENFORCES ITSELF. A chain slug is resolved against
 * the catalog BEFORE the screener is asked. The provider answers an unknown
 * slug with zero rows and HTTP 200, which is indistinguishable from a real
 * empty market, so a typo would otherwise be reported to the user as "there is
 * nothing trading on that chain".
 *
 * TRANSPORT. These channels live on the website hosts, which are reachable only
 * through the desktop bridge. A headless caller (CLI, tests, CI) reaches the
 * default public-API transport and gets its typed `SITE_TRANSPORT_UNAVAILABLE`
 * with the remedy, which is the honest answer rather than an empty board.
 */

import {
  fetchChainsCatalog,
  resolveChainSlugs,
  assertChainSlugsResolved,
  type CatalogChain,
  type ChainsCatalog,
} from "@tools/dexscreener/endpoints/chains-catalog.js";
import { fetchNarrativeCatalog } from "@tools/dexscreener/endpoints/metas.js";
import {
  fetchScreenerPage,
  type ScreenerPageResult,
} from "@tools/dexscreener/endpoints/screener.js";
import {
  fetchTokensPage,
  TOKENS_CHANNEL_HONESTY,
} from "@tools/dexscreener/endpoints/tokens-screener.js";
import {
  getDexScreenerTransport,
  type DexScreenerTransport,
} from "@tools/dexscreener/transport.js";
import {
  buildPriceDivergenceBlock,
  buildScreenEnvelope,
  type ScreenRankApplied,
  planOffsetWindow,
  PROVIDER_ROWS_PER_PAGE,
  type SourceObservation,
} from "@tools/dexscreener/screen-core/envelope.js";
import {
  externalContentFieldsFor,
  parseScreenFieldGroups,
  shapePairRow,
  type ScreenFieldGroup,
  type ShapedPairRow,
} from "@tools/dexscreener/screen-core/fields.js";
import { projectProfile } from "@tools/dexscreener/screen-core/profile.js";
import {
  projectMarketStats,
  assessPriceDivergence,
  PRICE_DIVERGENCE_RATIO,
  projectPairRow,
  type PriceDivergenceInput,
  type ProjectedMarketStats,
  type ProjectedPairRow,
  type VolumeShareBasis,
} from "@tools/dexscreener/screen-core/project.js";
import {
  accountFloors,
  applyFloor,
  buildScreenQuery,
  priceChangeRankKey,
  SCREEN_PRESET_FLOORS,
  trendingScoreRankKey,
  type ScreenFloorAccounting,
  type ScreenFloorRecord,
  type ScreenPresetId,
  type ScreenQuery,
  type ScreenRankKey,
  type ScreenRequest,
  type ScreenSortOrder,
  type ScreenWindow,
} from "@tools/dexscreener/screen-core/request.js";
import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
  siteError,
} from "@tools/dexscreener/site-errors.js";
import { bool, fail, num, ok, str } from "../../handler-helpers.js";
import { readStringList } from "../../runtime/list-params.js";
import type { ProtocolHandler } from "../../types.js";
import {
  SCREEN_LIMIT_DEFAULT,
  SCREEN_LIMIT_MAX,
  SCREEN_LIMIT_MIN,
} from "../manifests/screen-params.js";

/** The deadline one provider page gets. The channels answer in well under this. */
const SCREEN_TIMEOUT_MS = 20_000;
/** The catalog is a 63 KB JSON document behind a 24 hour cache. */
const CATALOG_TIMEOUT_MS = 15_000;

/** The four windows, for the `allWindows` field group. */
const ALL_WINDOWS: readonly ScreenWindow[] = ["m5", "h1", "h6", "h24"];

/* ------------------------------------------------------------------ */
/* Param reading                                                       */
/* ------------------------------------------------------------------ */

/**
 * A threshold as the caller expressed it.
 *
 * Two states: `undefined` (the caller said nothing, so the tool's default
 * applies) and a number (the caller chose). `null` is REFUSED by name. A tool
 * schema cannot declare a nullable number here, so a null removal was a
 * mechanism no agent could discover from the manifest and no schema could
 * validate; `disableQualityFloor` replaces it (plan 14.6 item 1).
 */
function threshold(
  params: Record<string, unknown>,
  key: string
): number | undefined {
  if (!(key in params)) return undefined;
  const raw = params[key];
  if (raw === null) throw nullNotLegal(key);
  if (raw === undefined || raw === "") return undefined;
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_FILTER_VALUE_INVALID,
      `"${key}" must be a finite number; received ${describe(raw)}`,
      "Send a number such as 25000. An empty string is not a number, and null is not accepted: set disableQualityFloor to true to drop every default floor at once."
    );
  }
  return value;
}

/** A boolean flag with the same two-state contract as `threshold`. */
function flag(
  params: Record<string, unknown>,
  key: string
): boolean | undefined {
  if (!(key in params)) return undefined;
  const raw = params[key];
  if (raw === null) throw nullNotLegal(key);
  if (raw === undefined || raw === "") return undefined;
  return bool(params, key);
}

/** One refusal for the retired null-removal spelling, wherever it arrives. */
function nullNotLegal(key: string) {
  return siteError(
    DexScreenerSiteErrorCodes.SCREEN_FILTER_VALUE_INVALID,
    `"${key}" does not accept null on this surface`,
    "To drop every default quality floor at once, send disableQualityFloor: true. To change one threshold, send its number. Both are reported in filtersApplied and in the floor accounting."
  );
}

/**
 * A list param, in either spelling, or a refusal naming the offending value.
 *
 * `readStringList` and NOT the shared `strArray` helper: that one returns
 * `undefined` for an array, and every list param on this family declares
 * `acceptsStringArray`, so `strArray` would silently drop `chainIds: ["solana"]`
 * and screen every chain instead of two. The runtime param gate validates the
 * array shape but deliberately does not rewrite it, so the array reaches the
 * handler intact and the handler has to understand it. Measured in the
 * handler tests: the two spellings must build a byte-identical query string.
 */
function readList(
  params: Record<string, unknown>,
  key: string,
  lowercase: boolean
): readonly string[] | undefined {
  const read = readStringList(params, key, { lowercase, acceptsArray: true });
  if (!read.ok) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_FILTER_VALUE_INVALID,
      read.reason,
      "Send a comma-separated string or an array of strings; the two are equivalent."
    );
  }
  return read.value ?? undefined;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `the string "${value}"`;
  return `a ${typeof value}`;
}

/** Read and bound `limit`, refusing rather than silently serving short. */
function readLimit(params: Record<string, unknown>): number {
  const raw = num(params, "limit");
  if (raw === undefined) return SCREEN_LIMIT_DEFAULT;
  if (!Number.isInteger(raw) || raw < SCREEN_LIMIT_MIN || raw > SCREEN_LIMIT_MAX) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_SHAPING_VALUE_INVALID,
      `"limit" must be a whole number from ${SCREEN_LIMIT_MIN} to ${SCREEN_LIMIT_MAX}; received ${String(raw)}`,
      `${SCREEN_LIMIT_MAX} is the provider's own page size. To reach further into the ranking, keep limit at or below ${SCREEN_LIMIT_MAX} and raise offset.`
    );
  }
  return raw;
}

function readOffset(params: Record<string, unknown>): number {
  const raw = num(params, "offset");
  if (raw === undefined) return 0;
  if (!Number.isInteger(raw) || raw < 0) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_SHAPING_VALUE_INVALID,
      `"offset" must be a whole number of 0 or more; received ${String(raw)}`,
      "Offset counts ranked rows to skip, so 100 starts at the second provider page."
    );
  }
  return raw;
}

function readWindow(
  params: Record<string, unknown>,
  key: string,
  fallback: ScreenWindow | undefined
): ScreenWindow | undefined {
  const raw = str(params, key);
  if (raw === "") return fallback;
  if (!ALL_WINDOWS.includes(raw as ScreenWindow)) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_FILTER_VALUE_INVALID,
      `"${key}" must be one of the stats windows the provider measures; received "${raw}"`,
      `Accepted windows: ${ALL_WINDOWS.join(", ")}.`
    );
  }
  return raw as ScreenWindow;
}

/**
 * Assemble the domain request from the raw params.
 *
 * Everything here is the DOMAIN vocabulary (USD, seconds, percent, counts);
 * the provider's own units and bracket grammar exist only inside
 * `screen-core/request.ts`.
 */
function readScreenRequest(
  params: Record<string, unknown>,
  rankBy: { readonly key: ScreenRankKey; readonly order: ScreenSortOrder },
  window: ScreenWindow,
  chainIds: readonly string[] | undefined
): ScreenRequest {
  return {
    rankBy,
    window,
    thresholdWindow: readWindow(params, "thresholdWindow", undefined),

    ...(chainIds === undefined ? {} : { chainIds }),
    dexIds: readList(params, "dexIds", true),
    excludeDexIds: readList(params, "excludeDexIds", true),
    // Labels, narrative IDs and mint suffixes keep the caller's casing: the
    // provider matches labels case-insensitively, while a narrative ID and a
    // base58 address suffix are case-SENSITIVE and lowercasing them would
    // match nothing while looking like a valid filter.
    labels: readList(params, "labels", false),
    metaIds: readList(params, "metaIds", false),
    launchpadIds: readList(params, "launchpadIds", true),
    baseTokenSuffixes: readList(params, "baseTokenSuffixes", false),
    includeLaunchpadPairs: bool(params, "includeLaunchpadPairs"),
    includeInactive: bool(params, "includeInactive"),

    minLiquidityUsd: threshold(params, "minLiquidityUsd"),
    maxLiquidityUsd: threshold(params, "maxLiquidityUsd"),
    minMarketCapUsd: threshold(params, "minMarketCapUsd"),
    maxMarketCapUsd: threshold(params, "maxMarketCapUsd"),
    minFdvUsd: threshold(params, "minFdvUsd"),
    maxFdvUsd: threshold(params, "maxFdvUsd"),
    minPairAgeSeconds: threshold(params, "minPairAgeSeconds"),
    maxPairAgeSeconds: threshold(params, "maxPairAgeSeconds"),
    minLaunchpadProgressPct: threshold(params, "minLaunchpadProgressPct"),
    maxLaunchpadProgressPct: threshold(params, "maxLaunchpadProgressPct"),
    minBoostCount: threshold(params, "minBoostCount"),
    maxBoostCount: threshold(params, "maxBoostCount"),

    minVolumeUsd: threshold(params, "minVolumeUsd"),
    maxVolumeUsd: threshold(params, "maxVolumeUsd"),
    minTxnCount: threshold(params, "minTxnCount"),
    maxTxnCount: threshold(params, "maxTxnCount"),
    minBuyCount: threshold(params, "minBuyCount"),
    maxBuyCount: threshold(params, "maxBuyCount"),
    minSellCount: threshold(params, "minSellCount"),
    maxSellCount: threshold(params, "maxSellCount"),
    minPriceChangePct: threshold(params, "minPriceChangePct"),
    maxPriceChangePct: threshold(params, "maxPriceChangePct"),

    requireProfile: flag(params, "requireProfile"),
    onlyBoosted: flag(params, "onlyBoosted"),
    onlyAds: flag(params, "onlyAds"),
    onlyRecentAds: flag(params, "onlyRecentAds"),

    disableQualityFloor: bool(params, "disableQualityFloor"),
  };
}

/**
 * Fill in a board's pinned request fields only where the caller said nothing.
 *
 * `readScreenRequest` writes `undefined` for every key the caller omitted, and
 * a plain object spread would let those undefineds erase a pin. Filling by
 * absence keeps both properties: the board gets its default, and an explicit
 * caller value always wins.
 */
function applyPins(
  base: ScreenRequest,
  pins: Partial<ScreenRequest> | undefined
): ScreenRequest {
  if (pins === undefined) return base;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(pins)) {
    if (Reflect.get(base, key) === undefined) patch[key] = value;
  }
  return { ...base, ...patch } as ScreenRequest;
}

/* ------------------------------------------------------------------ */
/* Chain vocabulary                                                    */
/* ------------------------------------------------------------------ */

/**
 * Resolve the caller's chain slugs against the catalog, or refuse by name.
 *
 * Returns undefined when the caller named no chain, which means "every indexed
 * chain" and is a legitimate request rather than a missing parameter.
 */
async function resolveChains(
  params: Record<string, unknown>,
  transport: DexScreenerTransport,
  signal: AbortSignal | undefined
): Promise<readonly string[] | undefined> {
  const requested = readList(params, "chainIds", true);
  if (requested === undefined || requested.length === 0) return undefined;

  const catalog = await fetchChainsCatalog({
    transport,
    timeoutMs: CATALOG_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
  const resolution = resolveChainSlugs(catalog, requested);
  assertChainSlugsResolved(resolution);
  return resolution.valid;
}

/**
 * Resolve `metaIds` against the narrative catalog, or refuse by name.
 *
 * S10-40. THE SAME FAIL-OPEN THE CHAIN REFUSAL ABOVE EXISTS TO STOP, on a
 * different vocabulary. The screener takes narrative IDs and NOT slugs, and it
 * answers a slug the way it answers an unknown chain: zero rows, HTTP 200, no
 * error. Measured, the plausible wrong value (the slug "cat" instead of its
 * numeric id) returned a confident empty market - 0 rows, 0 matched, zeroed
 * marketStats, the filter echoed back as though it had been selective - for a
 * theme carrying 158 million USD across 798 pairs. An agent reading that
 * concludes the narrative is dead.
 *
 * The repository documented the id-versus-slug hazard in three places as prose
 * and enforced it nowhere. The catalog is 18 rows and about 3.2 KB behind an
 * edge cache, so the check costs one cached read, and refusing is what the same
 * family already does for the identical failure mode.
 *
 * A catalog that cannot be reached does NOT block the board: the filter goes
 * through unvalidated rather than taking the whole call down, exactly as the
 * batch vocabulary check degrades.
 */
async function assertNarrativeIds(
  requested: readonly string[] | undefined,
  transport: DexScreenerTransport,
  signal: AbortSignal | undefined
): Promise<void> {
  if (requested === undefined || requested.length === 0) return;
  let catalog: readonly { readonly id: string; readonly slug: string }[];
  try {
    catalog = await fetchNarrativeCatalog({
      transport,
      timeoutMs: CATALOG_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return;
  }
  if (catalog.length === 0) return;
  const ids = new Set(catalog.map((row) => row.id));
  const bySlug = new Map(catalog.map((row) => [row.slug.toLowerCase(), row]));
  const unknown = requested.filter((value) => !ids.has(value.trim()));
  if (unknown.length === 0) return;

  const described = unknown
    .map((value) => {
      const asSlug = bySlug.get(value.trim().toLowerCase());
      return asSlug === undefined
        ? `"${value}": not an id in the narrative catalog`
        : `"${value}": that is the SLUG of the "${asSlug.slug}" narrative, whose id is "${asSlug.id}"`;
    })
    .join("; ");
  throw siteError(
    DexScreenerSiteErrorCodes.SCREEN_FILTER_VALUE_INVALID,
    `These metaIds are not narrative ids: ${described}.`,
    `filters[metaIds] takes a narrative's id, never its slug, and the screener answers an unknown id with zero rows and no error, so a slug would have been reported to you as an empty market. Call dexscreener__narratives_list for the ids; the catalog currently has ${ids.size}.`
  );
}

/* ------------------------------------------------------------------ */
/* The shared board pipeline                                           */
/* ------------------------------------------------------------------ */

interface BoardSpec {
  readonly publicName: string;
  readonly preset: ScreenPresetId;
  /** Which channel serves it: the v7 pair rows or the v2 token rows. */
  readonly channel: "pairs" | "tokens";
  readonly endpoint: string;
  /** How the board is ranked, given the resolved window and the raw params. */
  readonly rankBy: (
    window: ScreenWindow,
    params: Record<string, unknown>
  ) => { readonly key: ScreenRankKey; readonly order: ScreenSortOrder };
  /** Extra request fields the board pins, applied before the floors. */
  readonly pin?: (params: Record<string, unknown>) => Partial<ScreenRequest>;
  /** The board's own newness threshold, for `freshPairFlag`. */
  readonly freshPairMaxAgeSeconds?: number;
  /**
   * Row field groups this board always ships, whatever `fields` says. `core`
   * is implicit everywhere; a board names another group here only when that
   * group carries the answer the board exists to give.
   */
  readonly alwaysIncludeFieldGroups?: readonly ScreenFieldGroup[];
  /**
   * Refuse a parameter combination the provider answers with an empty board.
   * Runs before anything is fetched. Throwing here is the point: an empty
   * result an agent reads as "the market is empty" is worse than a refusal
   * that names the remedy.
   */
  readonly preflight?: (params: Record<string, unknown>) => void;
  /** One quantitative sentence about what was asked and what came back. */
  readonly summary: (facts: SummaryFacts) => string;
}

interface SummaryFacts {
  readonly window: ScreenWindow;
  readonly rows: readonly ShapedPairRow[];
  readonly totalApprox: number | null;
  readonly offset: number;
  readonly floors: string;
  readonly scope: string;
  /** The ordering that ran, so a summary can name the column it ranked. */
  readonly rankApplied: ScreenRankApplied;
}

/** One floor, rendered at a value the reader can check against filtersApplied. */
function renderFloor(
  record: ScreenFloorRecord,
  value: number | boolean | null
): string {
  const window = record.window === undefined ? "" : ` over ${record.window}`;
  if (typeof value !== "number") return record.param;
  return `${record.param} ${value.toLocaleString("en-US")}${window}`;
}

/**
 * Describe the floors that ACTUALLY RAN, never the preset table.
 *
 * Reading the preset table here is the defect this replaces: a board whose
 * `requireProfile` filter never went on the wire still announced it, and a
 * weakened liquidity floor still quoted the frozen 250,000 while the population
 * it screened had grown from 162 rows to 545.
 */
function describeFloors(
  accounting: ScreenFloorAccounting,
  query: ScreenQuery
): string {
  const inForce = accounting.floors.filter(
    (record) =>
      record.disposition === "applied" || record.disposition === "tightened"
  );
  const weakened = accounting.floors.filter(
    (record) => record.disposition === "weakened"
  );
  const removed = accounting.floors.filter(
    (record) => record.disposition === "removed"
  );

  /*
   * S10-23. THE FILTERS THE CALLER SET ARE PART OF WHY THE BOARD IS EMPTY.
   *
   * This sentence used to describe the DECLARED preset floors only, so a board
   * narrowed by minLaunchpadProgressPct, minVolumeUsd and minPairAgeSeconds -
   * every one of them caller-set, every one of them row-excluding, none of them
   * in the preset table - read as "about 0 matched" under "no default quality
   * floor". An empty market and a market the caller filtered down to nothing
   * are opposite findings and they rendered identically. `filtersApplied`
   * always carried the truth; the sentence a reader stops at did not.
   *
   * The declared floors are excluded from this clause because the three lists
   * above already speak for them, and nothing that merely scopes the board
   * (chain, dex exclusion, the inactivity switch) narrows it row by row.
   */
  const declaredKeys = new Set(
    accounting.floors
      .map((record) => record.effectiveKey)
      .filter((key): key is string => key !== null)
  );
  const callerNarrowing = query.filtersApplied.filter(
    (entry) =>
      entry.filter !== "chainIds"
      && entry.filter !== "excludedDexIds"
      && entry.filter !== "includePairsInactiveInTimeframe"
      && !declaredKeys.has(entry.key)
  );

  const parts: string[] = [];
  if (accounting.floors.length === 0) {
    parts.push("no default quality floor");
  } else {
    parts.push(
      inForce.length === 0
        ? "no quality floor in force"
        : `quality floor ${inForce.map((record) => renderFloor(record, record.effectiveValue)).join(", ")}`
    );
  }
  if (weakened.length > 0) {
    parts.push(
      `loosened below the default: ${weakened
        .map(
          (record) =>
            `${renderFloor(record, record.effectiveValue)} instead of ${renderFloor(record, record.defaultValue)}`
        )
        .join(", ")}`
    );
  }
  if (removed.length > 0) {
    /*
     * S10-39. "REMOVED" IS THE WRONG WORD WHEN THE FLOOR MOVED WINDOWS.
     *
     * Measured: a default minTxnCount 300 over h24 was re-anchored by the
     * caller to m5, which went on the wire as filters[txns][m5][min]=300 and
     * cut the population from 127 to 4 - STRICTER, not removed. The record's
     * own `effectiveKey` says where it landed and this clause never read it,
     * so the summary announced a loosening that was in fact a tightening.
     */
    const reanchored = removed.filter((record) => record.effectiveKey !== null);
    const gone = removed.filter((record) => record.effectiveKey === null);
    if (gone.length > 0) {
      parts.push(
        `removed at your request: ${gone
          .map((record) => renderFloor(record, record.defaultValue))
          .join(", ")}`
      );
    }
    if (reanchored.length > 0) {
      parts.push(
        `re-anchored to another window at your request, which is a different filter and not a removal: ${reanchored
          .map(
            (record) =>
              `${renderFloor(record, record.defaultValue)} now sent as ${record.effectiveKey ?? "an unnamed key"}`
          )
          .join(", ")}`
      );
    }
  }
  if (callerNarrowing.length > 0) {
    parts.push(
      `narrowed further by filters you set, which exclude rows and are part of why this count is what it is: ${callerNarrowing
        .map((entry) => `${entry.key}=${entry.value}`)
        .join(", ")}`
    );
  }
  return parts.join("; ");
}

function describeScope(chainIds: readonly string[] | undefined): string {
  if (chainIds === undefined || chainIds.length === 0) return "all indexed chains";
  return chainIds.join(", ");
}

/** The headline number of the top row, so the summary is quantitative. */
function headline(
  rows: readonly ShapedPairRow[],
  render: (row: ShapedPairRow) => string
): string {
  const top = rows[0];
  return top === undefined ? "" : ` Top row: ${top.baseTokenSymbol ?? top.baseTokenAddress} at ${render(top)}.`;
}

function usd(value: number | null): string {
  return value === null
    ? "an unreported amount"
    : `$${Math.round(value).toLocaleString("en-US")}`;
}

function pct(value: number | null): string {
  return value === null ? "an unreported change" : `${value.toFixed(2)} percent`;
}

/**
 * Run one board end to end.
 *
 * The order is load-bearing: chains are validated before the query is built,
 * the floors are applied before the query string is rendered so the echo shows
 * what actually went on the wire, and the envelope is assembled last from the
 * numbers the fetch produced rather than from the numbers that were requested.
 */
async function runBoard(
  spec: BoardSpec,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<ReturnType<typeof ok>> {
  spec.preflight?.(params);
  const transport = getDexScreenerTransport();
  const groups = parseScreenFieldGroups(
    str(params, "fields"),
    spec.alwaysIncludeFieldGroups
  );
  const limit = readLimit(params);
  const offset = readOffset(params);
  const window = readWindow(params, "window", "h24") ?? "h24";
  const chainIds = await resolveChains(params, transport, signal);
  // Same fail-closed reason as the chain slug above: an unknown value here
  // returns an empty board rather than an error.
  await assertNarrativeIds(readList(params, "metaIds", false), transport, signal);

  const base = readScreenRequest(params, spec.rankBy(window, params), window, chainIds);
  // A pinned field is a DEFAULT the board applies, never an override: an agent
  // that explicitly set `includeLaunchpadPairs: false` asked for something, and
  // silently reversing it would answer a different question than the one put.
  const requested: ScreenRequest = applyPins(base, spec.pin?.(params));
  const floored = applyFloor(requested, SCREEN_PRESET_FLOORS[spec.preset]);
  const query = buildScreenQuery(floored.request);
  // Derived from the built query, so what the envelope claims about the floor
  // and what the provider was actually asked for are the same fact.
  const accounting = accountFloors(floored, query);

  const plan = planOffsetWindow(offset, limit);
  const pages: ScreenerPageResult[] = [];
  for (let page = plan.firstPage; page <= plan.lastPage; page += 1) {
    const options = {
      page,
      transport,
      timeoutMs: SCREEN_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    };
    pages.push(
      spec.channel === "tokens"
        ? await fetchTokensPage(query, options)
        : await fetchScreenerPage(query, options)
    );
  }

  const first = pages[0];
  if (first === undefined) {
    // planOffsetWindow always yields at least one page; this keeps the
    // invariant explicit rather than reaching for a non-null assertion.
    throw new RangeError("screen paging produced no provider page");
  }
  const last = pages[pages.length - 1] ?? first;

  const providerRows = pages.flatMap((page) => page.frame.rows);
  const wanted = providerRows.slice(plan.sliceStart, plan.sliceEnd);
  const nowMs = Date.now();
  const frameStats = projectMarketStats(first.frame.stats, null);

  const sanitized = new Set<string>();
  const isTokens = spec.channel === "tokens";
  const shareBasis = resolveShareBasis(chainIds, window, query);
  const rows = wanted.map((raw, index) =>
    shapeOne(raw, {
      groups,
      window,
      nowMs,
      frameStats,
      shareBasis,
      sanitized,
      // The provider's own ordinal, 1-based over the ranking it served, so a
      // row can be cited by position without recomputing the opaque score.
      ...(isTokens ? { providerRank: offset + index + 1 } : {}),
      ...(spec.freshPairMaxAgeSeconds === undefined
        ? {}
        : { freshPairMaxAgeSeconds: spec.freshPairMaxAgeSeconds }),
    })
  );

  const totalApprox = isTokens ? null : first.frame.pairsCount;

  const envelope = buildScreenEnvelope<ShapedPairRow>({
    summary: spec.summary({
      window,
      rows,
      totalApprox,
      offset,
      floors: describeFloors(accounting, query),
      scope: describeScope(chainIds),
      rankApplied: query.rankApplied,
    }),
    rows,
    offset,
    providerCount: totalApprox,
    ...(isTokens ? { totalUnavailable: true } : {}),
    // Only the rows inside the offset window were asked for; the rest of the
    // fetched pages were never candidates, so they are not "dropped" and must
    // not be accounted as such.
    providerReturned: rows.length,
    filtersApplied: query.filtersApplied,
    // The ordering is an input like any other, and the only one that decides
    // the whole answer; it had no echo at all before this.
    rankApplied: query.rankApplied,
    qualityFloorApplied: accounting.qualityFloorApplied,
    exclusionDefaultReplaced: query.exclusionDefaultReplaced,
    endpoint: spec.endpoint,
    pagesFetched: pages.length,
    rowsPerPage: PROVIDER_ROWS_PER_PAGE,
    ...(isTokens ? { pagesMayOverlap: true } : {}),
    // Counted, not assumed: a window that stitched two provider pages can hold
    // the same row twice, measured at two different instants. The duplicates
    // stay in `rows`; the envelope says how many there are.
    //
    // THE IDENTITY IS PER CHANNEL, and this is not a cosmetic choice. A pair
    // row IS its pair address, but a TOKEN row is one aggregate of a token
    // attached to whichever pool the provider picked that page, and it picks a
    // different one on a later page. Measured 2026-08-25: pages 1 and 2 of one
    // token board repeated 14 base tokens carrying ZERO repeated pair
    // addresses (17 tokens on the earlier capture, likewise zero), so keying
    // the token channel on the pair address reported 0 duplicates on a window
    // that had just re-served a dozen tokens. On the token channel the
    // identity is the base token.
    rowIdentities: rows.map((row) =>
      isTokens
        ? `${row.chainId}:${row.baseTokenAddress}`
        : `${row.chainId}:${row.pairAddress}`
    ),
    // S10-41: on a pair board the rows are pools, so how many TOKENS they
    // represent is a separate number and it is the one a reader is usually
    // after. The token board needs no second count: its rows are tokens.
    ...(isTokens
      ? {}
      : {
          tokenIdentities: rows.map(
            (row) => `${row.chainId}:${row.baseTokenAddress}`
          ),
        }),
    lastPageWasFull: last.frame.rows.length >= PROVIDER_ROWS_PER_PAGE,
    marketStats: projectMarketStats(first.frame.stats, first.latestBlock),
    sourceObservation: observation(transport, first.fetchedAtMs),
    externalContentFields: externalContentFieldsFor(
      groups,
      EXTERNAL_ROW_FIELDS,
      PROFILE_FIELDS
    ),
  });

  return ok({
    ...envelope,
    // Set here rather than inside `buildScreenEnvelope`, whose input contract
    // is owned by the client layer: the sanitization happens at shaping time,
    // so the shaping layer is what knows which field paths were touched.
    sanitizedFields: [...sanitized].sort(),
    defaultsApplied: accounting.defaultsApplied,
    defaultsOverridden: accounting.defaultsOverridden,
    defaultsDisabled: accounting.defaultsDisabled,
    // Every declared floor with what became of it on the wire, in one list, so
    // the three lists above cannot be read as the whole story.
    floorAccounting: accounting.floors,
    // The token channel's measured limits, verbatim from the client so the
    // wording of an honesty claim has one owner.
    ...(isTokens ? { honesty: TOKENS_CHANNEL_HONESTY } : {}),
    // S10-31b. The population is every row the fetched pages carried, before
    // the offset window was sliced out of them, so that `limit` and `offset`
    // cannot move the median a flag is measured against. Assessing the emitted
    // window let a slice that happened to be all-junk agree with itself and
    // report nothing, and a slice where junk was the majority flag the honest
    // rows instead.
    ...buildPriceDivergenceBlock(
      assessPriceDivergence(divergencePopulation(providerRows, window, nowMs)),
      rows,
      PRICE_DIVERGENCE_RATIO
    ),
  });
}

/**
 * The identity and price of every provider row, for the divergence assessment.
 *
 * S10-31b. The assessment must see the FULL fetched population, not the offset
 * window that is about to be emitted, so it cannot read the shaped rows: those
 * exist only for the window. It projects the raw rows through `projectPairRow`,
 * the same projection the emitted rows go through, rather than reaching into
 * the raw shape a second time - a second reader of the provider's price field
 * would be a second source of truth for exactly the number under test.
 *
 * The window argument only selects which timeframe's derived fields are
 * computed; `priceUsd` and the identity are window-independent.
 */
function divergencePopulation(
  providerRows: readonly unknown[],
  window: ScreenWindow,
  nowMs: number
): readonly PriceDivergenceInput[] {
  return providerRows.map((raw) => {
    const row = projectPairRow(raw, { window, nowMs });
    return {
      chainId: row.chainId,
      baseTokenAddress: row.baseToken.address,
      pairAddress: row.pairAddress,
      priceUsd: row.priceUsd,
    };
  });
}

const EXTERNAL_ROW_FIELDS: readonly string[] = [
  "baseToken.name",
  "baseToken.symbol",
  "quoteToken.symbol",
];

const PROFILE_FIELDS: readonly string[] = [
  "profile.description",
  "profile.links[].label",
  "profile.links[].url",
];

interface ShapeOneOptions {
  readonly groups: readonly ScreenFieldGroup[];
  readonly window: ScreenWindow;
  readonly nowMs: number;
  /**
   * The frame's whole stats block, so each window's share uses ITS OWN
   * denominator. Passing one number read at the selected window made every
   * other window in `allWindows` divide its volume by the selected window's
   * total: measured on a solana m5 board, the h24 share came out 3.53 percent
   * against a true 0.0395 percent, an 89x overstatement of a field a model
   * will quote.
   */
  readonly frameStats: ProjectedMarketStats;
  /** Which denominator the frame volume is, which decides the share's NAME. */
  readonly shareBasis: VolumeShareBasis;
  readonly sanitized: Set<string>;
  readonly providerRank?: number;
  readonly freshPairMaxAgeSeconds?: number;
}

/**
 * Project and shape one provider row.
 *
 * `allWindows` re-projects the same raw row once per window rather than growing
 * a second reader for the same fields: the projection contract (missing input
 * becomes null with its name recorded, never zero) then holds identically on
 * all four windows, which a parallel reader could not guarantee.
 */
function shapeOne(raw: unknown, options: ShapeOneOptions): ShapedPairRow {
  const project = (window: ScreenWindow): ProjectedPairRow =>
    projectPairRow(raw, {
      window,
      nowMs: options.nowMs,
      frameVolumeUsd: options.frameStats[window].volumeUsd,
      shareBasis: options.shareBasis,
      ...(options.freshPairMaxAgeSeconds === undefined
        ? {}
        : { freshPairMaxAgeSeconds: options.freshPairMaxAgeSeconds }),
    });

  const row = project(options.window);
  const wantsWindows = options.groups.includes("allWindows");
  const wantsProfile = options.groups.includes("profile");

  return shapePairRow({
    row,
    groups: options.groups,
    sanitized: options.sanitized,
    ...(options.providerRank === undefined
      ? {}
      : { providerRank: options.providerRank }),
    ...(wantsWindows
      ? {
          perWindow: {
            m5: options.window === "m5" ? row : project("m5"),
            h1: options.window === "h1" ? row : project("h1"),
            h6: options.window === "h6" ? row : project("h6"),
            h24: options.window === "h24" ? row : project("h24"),
          },
        }
      : {}),
    ...(wantsProfile ? { profile: projectProfile(raw, options.sanitized) } : {}),
  });
}

/**
 * Which denominator the frame's window volume actually IS, which decides the
 * share's NAME.
 *
 * `chainVolumeSharePct` is only honest when the frame's total is one chain's
 * total. Measured live 2026-08-24, the frame's `stats` block responds to the
 * query, so any row-excluding input moves the denominator off that meaning:
 *
 *  - solana, chainIds only, h24 path: stats.h24 = 6,665,767,128 (the chain);
 *  - the same chain plus `filters[liquidity][min]` and `filters[pairAge][max]`:
 *    4,685,578,720, i.e. 70 percent of it;
 *  - the same chain plus `filters[dexIds]`: 108,413,621, 1.6 percent of it;
 *  - solana, chainIds only, on the m5 PATH: 1,961,951,831, because the path
 *    timeframe is itself an activity gate (m5 matched 5,015 rows where h24
 *    matched 54,186, and `includePairsInactiveInTimeframe` lifts it).
 *
 * So the chain name survives only a single-chain query with no row-excluding
 * filter and no activity gate. `filters[excludedDexIds]` is exempt in ONE of
 * its two forms only, and the two share a filter name, which is why the
 * exemption reads `query.exclusionForm` and never the name:
 *
 *  - the LIFT form (an empty item) excludes no row. It replaces the
 *    provider's own default view of the chain with nothing and was measured
 *    moving the total by about 2 percent, and `exclusionDefaultReplaced`
 *    reports it separately. Exempt.
 *  - a real LIST of dex ids deletes every row on those venues from the
 *    population. Measured on solana with one venue named: the h24 total fell
 *    75.17 percent while this function still called the result a chain share.
 *    Row-excluding, so the basis is `filteredSet`.
 */
function resolveShareBasis(
  chainIds: readonly string[] | undefined,
  window: ScreenWindow,
  query: ScreenQuery
): VolumeShareBasis {
  if (chainIds === undefined || chainIds.length !== 1) return "filteredSet";
  const activityGated =
    window !== "h24"
    && !query.filtersApplied.some(
      (entry) => entry.filter === "includePairsInactiveInTimeframe"
    );
  if (activityGated) return "filteredSet";
  if (query.exclusionForm === "list") return "filteredSet";
  const rowExcluding = query.filtersApplied.some(
    (entry) =>
      entry.filter !== "chainIds"
      && entry.filter !== "excludedDexIds"
      && entry.filter !== "includePairsInactiveInTimeframe"
  );
  return rowExcluding ? "filteredSet" : "chain";
}

function observation(
  transport: DexScreenerTransport,
  fetchedAtMs: number
): SourceObservation {
  return {
    transport: transport.name,
    fetchedAtMs,
    // `not_cached` here is the MEASURED truth, not the hardcoded literal that
    // was wrong on the HTTP site endpoints (EP6/EP8, fixed by
    // `readCacheObservation`). Both screener boards are WebSocket exchanges:
    // there are no response headers to read, no `cf-cache-status` exists on an
    // upgraded socket, and nothing sits between a frame and its socket. The
    // one HTTP read in this module, the chains catalog, reports its real cache
    // state from the catalog client's own `cacheHit` in `runChains`.
    cacheState: "not_cached",
  };
}

/* ------------------------------------------------------------------ */
/* Board specifications                                                */
/* ------------------------------------------------------------------ */

const PAIRS_ENDPOINT = "/dex/screener/v7/pairs";
const TOKENS_ENDPOINT = "/dex/screener/v2/tokens";

const TOP_RANK_KEYS: Readonly<Record<string, ScreenRankKey>> = {
  volume: "volume",
  txns: "txns",
  buys: "buys",
  sells: "sells",
  liquidity: "liquidity",
  // S10-50: `marketCap` is NOT in this map, and its absence is the enforcement
  // rather than the enum alone. The provider accepts the key and answers with a
  // board built out of mispriced pools - measured rank 1 at a market cap of
  // 263.09 trillion USD beside an FDV of 332,916 on the same row. Same decision
  // and same reason as its withdrawal from the tokens board.
  // Measured live 2026-08-24: rankBy=activeBoosts served 100 rows of a 54,051
  // population, so the provider ranks by paid visibility as a first-class key.
  boosts: "activeBoosts",
};

/** Which floor preset the `top` board uses depends on how it was sorted. */
function topPreset(params: Record<string, unknown>): ScreenPresetId {
  const sortBy = str(params, "sortBy") || "volume";
  if (sortBy === "volume") return "topVolume";
  if (sortBy === "txns") return "topTxns";
  return "topOther";
}

function readSortDir(params: Record<string, unknown>): ScreenSortOrder {
  return readSortDirOrUndefined(params) ?? "desc";
}

/**
 * The caller's direction, or undefined when they said nothing.
 *
 * The distinction matters where a board's default direction depends on the
 * rank key: filling "desc" in before that decision is made would make an
 * unset `sortDir` indistinguishable from an explicit `sortDir: "desc"` and
 * quietly override the key's own default.
 */
function readSortDirOrUndefined(
  params: Record<string, unknown>
): ScreenSortOrder | undefined {
  const raw = str(params, "sortDir");
  if (raw === "asc") return "asc";
  if (raw === "desc") return "desc";
  return undefined;
}

const TRENDING: BoardSpec = {
  publicName: "dexscreener__pairs_trending_list",
  preset: "trending",
  channel: "pairs",
  endpoint: PAIRS_ENDPOINT,
  rankBy: (window) => ({ key: trendingScoreRankKey(window), order: "desc" }),
  summary: (facts) =>
    `Trending pairs on ${facts.scope} ranked by DexScreener's ${facts.window} trending score, `
    + `with ${facts.floors}. Returned ${facts.rows.length} rows from offset ${facts.offset}`
    + `${facts.totalApprox === null ? "" : ` of about ${facts.totalApprox.toLocaleString("en-US")} matched`}.`
    + headline(facts.rows, (row) => `${pct(row.priceChangePct)} over ${facts.window} on ${usd(row.volumeUsd)} volume`),
};

const TOP: BoardSpec = {
  publicName: "dexscreener__pairs_top_list",
  preset: "topVolume",
  channel: "pairs",
  endpoint: PAIRS_ENDPOINT,
  rankBy: (_window, params) => ({
    key: TOP_RANK_KEYS[str(params, "sortBy") || "volume"] ?? "volume",
    order: readSortDir(params),
  }),
  summary: (facts) =>
    `Top pairs on ${facts.scope} over ${facts.window}, ${describeRank(facts.rankApplied)}, with ${facts.floors}. `
    + `Returned ${facts.rows.length} rows from offset ${facts.offset}`
    + `${facts.totalApprox === null ? "" : ` of about ${facts.totalApprox.toLocaleString("en-US")} matched`}.`
    + headline(facts.rows, (row) => `${usd(row.volumeUsd)} volume and ${usd(row.liquidityUsd)} liquidity`),
};

const GAINERS: BoardSpec = {
  publicName: "dexscreener__gainers_list",
  preset: "gainers",
  channel: "pairs",
  endpoint: PAIRS_ENDPOINT,
  rankBy: (window) => ({ key: priceChangeRankKey(window), order: "desc" }),
  summary: (facts) =>
    `Biggest ${facts.window} gainers on ${facts.scope}, with ${facts.floors}. `
    + `Returned ${facts.rows.length} rows from offset ${facts.offset}`
    + `${facts.totalApprox === null ? "" : ` of about ${facts.totalApprox.toLocaleString("en-US")} matched`}.`
    + headline(facts.rows, (row) => `${pct(row.priceChangePct)} over ${facts.window}`),
};

const LOSERS: BoardSpec = {
  publicName: "dexscreener__losers_list",
  preset: "losers",
  channel: "pairs",
  endpoint: PAIRS_ENDPOINT,
  rankBy: (window) => ({ key: priceChangeRankKey(window), order: "asc" }),
  summary: (facts) =>
    `Biggest ${facts.window} losers on ${facts.scope}, with ${facts.floors}. `
    + `Returned ${facts.rows.length} rows from offset ${facts.offset}`
    + `${facts.totalApprox === null ? "" : ` of about ${facts.totalApprox.toLocaleString("en-US")} matched`}.`
    + headline(facts.rows, (row) => `${pct(row.priceChangePct)} over ${facts.window}`),
};

/** The newness threshold the `new` board reports `freshPairFlag` against. */
const NEW_PAIR_FRESH_SECONDS = 3_600;

const NEW: BoardSpec = {
  publicName: "dexscreener__pairs_new_list",
  preset: "new",
  channel: "pairs",
  endpoint: PAIRS_ENDPOINT,
  rankBy: () => ({ key: "pairAge", order: "asc" }),
  freshPairMaxAgeSeconds: NEW_PAIR_FRESH_SECONDS,
  summary: (facts) =>
    `Newest pairs on ${facts.scope} first, with ${facts.floors}; freshPairFlag marks pairs under `
    + `${NEW_PAIR_FRESH_SECONDS / 60} minutes old. Returned ${facts.rows.length} rows from offset ${facts.offset}`
    + `${facts.totalApprox === null ? "" : ` of about ${facts.totalApprox.toLocaleString("en-US")} matched`}.`
    + headline(facts.rows, (row) =>
        row.pairAgeSeconds === null
          ? "an unreported age"
          : `${Math.round(row.pairAgeSeconds / 60)} minutes old with ${usd(row.liquidityUsd)} liquidity`
      ),
};

const LAUNCHPAD_RANK_KEYS: Readonly<Record<string, ScreenRankKey>> = {
  launchpadProgress: "launchpadProgress",
  volume: "volume",
  txns: "txns",
  marketCap: "marketCap",
  pairAge: "pairAge",
};

function launchpadStage(params: Record<string, unknown>): "bonding" | "graduated" {
  return str(params, "stage") === "graduated" ? "graduated" : "bonding";
}

const LAUNCHPAD: BoardSpec = {
  publicName: "dexscreener__launchpad_pairs_list",
  preset: "launchpadBonding",
  channel: "pairs",
  endpoint: PAIRS_ENDPOINT,
  rankBy: (window, params) => {
    const requested = str(params, "sortBy");
    const stage = launchpadStage(params);
    /*
     * S10-5. THIS BOARD IGNORED sortDir ENTIRELY, so "newest bonding tokens"
     * was inexpressible: the sibling boards take a direction and this one
     * hardcoded one per key. The per-key default is kept exactly as it was
     * (pairAge ascending, everything else descending) and an explicit
     * direction now wins, which is the contract every other board states.
     */
    const chosen = readSortDirOrUndefined(params);
    if (requested === "trendingScore") {
      return { key: trendingScoreRankKey(window), order: chosen ?? "desc" };
    }
    if (requested === "priceChange") {
      return { key: priceChangeRankKey(window), order: chosen ?? "desc" };
    }
    const mapped = LAUNCHPAD_RANK_KEYS[requested];
    if (mapped !== undefined) {
      return {
        key: mapped,
        order: chosen ?? (requested === "pairAge" ? "asc" : "desc"),
      };
    }
    // Progress ranks the bonding board (the near-graduation question); on the
    // graduated board every row is at 100 and would rank nothing, so the
    // trending score is the default there instead.
    return stage === "graduated"
      ? { key: trendingScoreRankKey(window), order: "desc" }
      : { key: "launchpadProgress", order: "desc" };
  },
  // Bonding-curve pairs are hidden from every ordinary screen by a provider
  // default; the board exists to show them, so it lifts that exclusion itself.
  pin: () => ({ includeLaunchpadPairs: true }),
  // The board's whole point is progress, creator and migration dex, which live
  // in the non-default `launchpad` group. Shipping `core` alone made the
  // ranked column invisible on every row.
  alwaysIncludeFieldGroups: ["core", "launchpad"],
  preflight: assertLaunchpadStageFilter,
  summary: (facts) =>
    `Launchpad pairs on ${facts.scope} over ${facts.window}, ${describeLaunchpadRank(facts)}, with ${facts.floors}. `
    + `Returned ${facts.rows.length} rows from offset ${facts.offset}`
    + `${facts.totalApprox === null ? "" : ` of about ${facts.totalApprox.toLocaleString("en-US")} matched`}.`
    + headline(facts.rows, (row) =>
        row.launchpad?.progressPct === undefined || row.launchpad?.progressPct === null
          ? `${usd(row.marketCapUsd)} market cap`
          : `${row.launchpad.progressPct.toFixed(2)} percent bonded at ${usd(row.marketCapUsd)} market cap`
      ),
};

/**
 * Refuse `launchpadIds` on the bonding stage, with the filter that works.
 *
 * Measured live 2026-08-24 from the raw frames: `launchpad.meta` is `{}` on
 * every bonding row and carries `{"id":"pumpfun"}` only after migration, so
 * the provider's `filters[launchpadIds]` matches GRADUATED rows only. The
 * combination is not an error to the provider, it is an empty board: the
 * manifest's own example (`stage: "bonding"`, `launchpadIds: "pumpfun"`)
 * returned 0 rows and `pairsCount` 0, while the same call with
 * `dexIds: "pumpfun"` returned a 53,478-row population. An agent reading the
 * empty board concludes there is nothing bonding.
 */
function assertLaunchpadStageFilter(params: Record<string, unknown>): void {
  const launchpadIds = readList(params, "launchpadIds", true);
  if (launchpadIds === undefined || launchpadIds.length === 0) return;
  if (launchpadStage(params) !== "bonding") return;
  throw siteError(
    DexScreenerSiteErrorCodes.SCREEN_FILTER_NOT_SUPPORTED,
    `"launchpadIds" cannot be combined with stage "bonding": the provider only attaches a launchpad id to a pair AFTER it graduates, so this pairing matches nothing and would look like an empty market`,
    `Use "dexIds" with the same value on the bonding stage (dexIds: "${launchpadIds[0] ?? "pumpfun"}"), which is the launchpad's own dex while the curve is running, or keep "launchpadIds" and pass stage: "graduated".`
  );
}

/**
 * Name the ordering in the sentence.
 *
 * A liquidity board ascending and the same board descending were
 * byte-indistinguishable apart from their rows: the sentence said neither, and
 * no field carried the rank key at all. `rankApplied` is the machine-readable
 * fact; this is the human one.
 */
function describeRank(rank: ScreenRankApplied): string {
  return `ranked by ${rank.key} ${rank.order === "asc" ? "ascending" : "descending"}`;
}

/** The launchpad board names its own column, because progress is why it exists. */
function describeLaunchpadRank(facts: SummaryFacts): string {
  return facts.rankApplied.key === "launchpadProgress"
    ? `ranked by bonding progress ${facts.rankApplied.order === "asc" ? "ascending" : "descending"}`
    : describeRank(facts.rankApplied);
}

/**
 * The rank keys this channel is offered on.
 *
 * `marketCap` is absent DELIBERATELY. The provider accepts it and answers with
 * a degenerate board: measured 2026-08-25 on solana it served 43 rows in
 * total, 18 of 42 adjacent pairs out of order on the very column it claims to
 * rank, with JUP at 3.68 trillion USD and PUMP at 23.98 trillion, quoted in
 * junk pairs. An enum member that answers a market-cap league table with 43
 * junk rows is worse than one the schema refuses by name.
 *
 * `pairAge` is present because the channel honours it and it is the only way
 * to ask this channel for the newest tokens: measured 2026-08-25, desc served
 * tokens created in 2022 and 2023 and asc served tokens created that day.
 */
const TOKENS_RANK_KEYS: Readonly<Record<string, ScreenRankKey>> = {
  volume: "volume",
  txns: "txns",
  liquidity: "liquidity",
  pairAge: "pairAge",
};

/** Rank keys whose useful default direction is ascending, not descending. */
const TOKENS_ASCENDING_BY_DEFAULT: ReadonlySet<string> = new Set(["pairAge"]);

const TOKENS: BoardSpec = {
  publicName: "dexscreener__tokens_screen",
  preset: "tokensScreen",
  channel: "tokens",
  endpoint: TOKENS_ENDPOINT,
  rankBy: (window, params) => {
    const requested = str(params, "sortBy");
    // An explicit direction always wins; the per-key default only fills the
    // silence. "Newest tokens" is what `pairAge` is asked for, and that is
    // ascending age, so a desc default would answer the opposite question. The
    // direction that ran is echoed in `rankApplied` either way.
    const order =
      readSortDirOrUndefined(params)
      ?? (TOKENS_ASCENDING_BY_DEFAULT.has(requested) ? "asc" : "desc");
    if (requested === "priceChange") {
      return { key: priceChangeRankKey(window), order };
    }
    const mapped = TOKENS_RANK_KEYS[requested];
    if (mapped !== undefined) return { key: mapped, order };
    return { key: trendingScoreRankKey(window), order };
  },
  summary: (facts) =>
    `Token aggregate rows on ${facts.scope} over ${facts.window}, ${describeRank(facts.rankApplied)}. `
    + `Returned ${facts.rows.length} rows from offset ${facts.offset}. `
    + "Volume, liquidity and counts are SUMS across each token's pools; marketCap, fdv, price and "
    + "the pair identity are one representative pool's and can be wrong by orders of magnitude. "
    + "Coverage is the provider's profile-carrying tokens only, this channel publishes no total, "
    + "and pages repeat tokens (counted by base token in duplicateRowsAcrossPages), so a short "
    + "board here is not evidence of a short market and traversal is not exhaustive."
    + headline(facts.rows, (row) => `${usd(row.volumeUsd)} of pooled volume at ${usd(row.marketCapUsd)} representative-pool market cap`),
};

/**
 * The launchpad board's floors depend on the stage it was asked for, so its
 * preset is chosen per call rather than pinned on the spec.
 */
function launchpadSpec(params: Record<string, unknown>): BoardSpec {
  return {
    ...LAUNCHPAD,
    preset:
      launchpadStage(params) === "graduated"
        ? "launchpadGraduated"
        : "launchpadBonding",
  };
}

/* ------------------------------------------------------------------ */
/* Chain catalog                                                       */
/* ------------------------------------------------------------------ */

/** One catalog row as the tool reports it. */
function catalogRow(chain: CatalogChain): Record<string, unknown> {
  return {
    slug: chain.slug,
    name: chain.name,
    shortName: chain.shortName,
    architecture: chain.architecture,
    nativeChainId: chain.nativeChainId,
    wrappedNativeToken: chain.wrappedNativeToken,
    dexCount: chain.dexes.length,
    dexIds: chain.dexes,
    blockExplorer: chain.blockExplorer,
    // Presence of an integration is CATALOG metadata: it says the provider can
    // ask that auditor about this chain, never that an audit exists for a
    // given token.
    auditIntegrations: Object.entries(chain.integrations)
      .filter(([, integration]) => integration.isEnabled)
      .map(([key]) => key)
      .sort(),
    // NAMED FOR WHAT IT IS, not for what it looks like. The provider's
    // `features.metas.isEnabled` is a SITE-VISIBILITY label: it says whether
    // dexscreener.com surfaces a narratives view for the chain, not whether
    // narrative data exists there. Measured: narratives aggregate live on
    // robinhood, ton and polygon, none of which the site surfaces. Under the
    // old name `narrativesEnabled` a false value read as "this chain has no
    // narratives", which is the exact wrong answer.
    //
    // `isVisible` keeps its own key rather than being folded in: it is a
    // second provider flag, and the catalog client records that the two were
    // measured identical on all 74 chains and have never diverged. Collapsing
    // them here would hide the day they do.
    narrativesSurfacedOnSite: chain.features.metasEnabled,
    narrativesSurfacedOnSiteVisible: chain.features.metasVisible,
  };
}

async function runChains(
  params: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<ReturnType<typeof ok>> {
  const transport = getDexScreenerTransport();
  const catalog: ChainsCatalog = await fetchChainsCatalog({
    transport,
    timeoutMs: CATALOG_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });

  const requested = str(params, "chain");
  const narrowed = requested === "" ? undefined : requested;
  // Filter on the CANONICAL slug the resolver computed, never on the caller's
  // raw string. `chain` accepts the numeric chain id every other chain-valued
  // param in this namespace accepts (CANONICAL_CHAIN_SENTENCE), and the
  // resolver does match `nativeChainId`; comparing the raw "1" against
  // `chain.slug` matched nothing and answered `returned: 0, chains: []` with a
  // confident summary reading "1 (1) with its 0 DEX identifiers". A silent
  // wrong answer in the one tool whose purpose is to stop silent wrong
  // answers. Measured live 2026-08-24 for "1" and "56".
  let resolvedSlug: string | undefined;
  if (narrowed !== undefined) {
    const resolution = resolveChainSlugs(catalog, [narrowed]);
    assertChainSlugsResolved(resolution);
    resolvedSlug = resolution.valid[0];
  }

  const chains =
    resolvedSlug === undefined
      ? catalog.chains
      : catalog.chains.filter((chain) => chain.slug === resolvedSlug);

  const dexTotal = chains.reduce((sum, chain) => sum + chain.dexes.length, 0);

  return ok({
    summary:
      narrowed === undefined
        ? `${chains.length} chains DexScreener indexes, carrying ${dexTotal.toLocaleString("en-US")} DEX identifiers between them. These slugs are the accepted vocabulary for chainIds and dexIds everywhere else in this namespace.`
        : `${chains[0]?.name ?? resolvedSlug ?? narrowed} (${resolvedSlug ?? narrowed})`
          + `${resolvedSlug === undefined || resolvedSlug === narrowed ? "" : `, resolved from the "${narrowed}" you passed,`}`
          + ` with its ${dexTotal} DEX identifiers, explorer templates and audit integrations.`,
    returned: chains.length,
    totalChains: catalog.chains.length,
    // The catalog is a complete document, not a page: there is nothing beyond
    // it to continue to, and saying so is different from staying silent.
    hasMore: false,
    chains: chains.map(catalogRow),
    sourceObservation: {
      transport: transport.name,
      fetchedAtMs: catalog.fetchedAtMs,
      cacheState: catalog.cacheHit ? "cache_hit" : "cache_miss",
      cacheAgeMs: catalog.cacheAgeMs,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Handler map                                                         */
/* ------------------------------------------------------------------ */

/**
 * Wrap a board so a typed site failure reaches the agent as its real cause and
 * remedy rather than as an unhandled throw.
 *
 * Only OUR typed failures are converted. Anything else keeps propagating, so an
 * unexpected defect stays visible instead of being flattened into a tool
 * rejection that reads like a provider problem.
 */
function guarded(
  publicName: string,
  run: (
    params: Record<string, unknown>,
    signal: AbortSignal | undefined
  ) => Promise<ReturnType<typeof ok>>
): ProtocolHandler {
  return async (params, context) => {
    try {
      return await run(params, context.abortSignal);
    } catch (error) {
      if (isDexScreenerSiteError(error)) {
        return fail(
          `${publicName}: ${error.message}${error.hint === undefined ? "" : ` ${error.hint}`}`
        );
      }
      throw error;
    }
  };
}

export const DEXSCREENER_SCREENING_HANDLERS: Record<string, ProtocolHandler> = {
  "dexscreener.pairs.trending": guarded(TRENDING.publicName, (p, s) =>
    runBoard(TRENDING, p, s)
  ),
  "dexscreener.pairs.top": guarded(TOP.publicName, (p, s) =>
    runBoard({ ...TOP, preset: topPreset(p) }, p, s)
  ),
  "dexscreener.gainers": guarded(GAINERS.publicName, (p, s) =>
    runBoard(GAINERS, p, s)
  ),
  "dexscreener.losers": guarded(LOSERS.publicName, (p, s) =>
    runBoard(LOSERS, p, s)
  ),
  "dexscreener.pairs.new": guarded(NEW.publicName, (p, s) =>
    runBoard(NEW, p, s)
  ),
  "dexscreener.launchpad.pairs": guarded(LAUNCHPAD.publicName, (p, s) =>
    runBoard(launchpadSpec(p), p, s)
  ),
  "dexscreener.chains": guarded("dexscreener__chains_list", (p, s) =>
    runChains(p, s)
  ),
  "dexscreener.tokens.screen": guarded(TOKENS.publicName, (p, s) =>
    runBoard(TOKENS, p, s)
  ),
};
