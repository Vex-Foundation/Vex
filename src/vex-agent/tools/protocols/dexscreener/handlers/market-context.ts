/**
 * Handler for the site MARKET-CONTEXT family: narratives.
 *
 * Thin for the same reason its siblings are: the wire grammar, the codec and
 * the chain vocabulary all have owners in `src/tools/dexscreener/`. What is
 * left here is the per-tool decision: which chain may be asked at all, how the
 * whole-population set is ordered and windowed, and what the cross-reference
 * into the screening tools is allowed to claim.
 *
 * THE THREE RULES THIS MODULE ENFORCES ITSELF.
 *
 *  1. A QUIET CHAIN IS ANSWERED, NOT REFUSED, AND THE COUNT SAYS SO. Only a
 *     slug that is not a chain at all is refused here. A real chain with no
 *     narrative activity gets a successful answer reading "0 of 18 active",
 *     because that is the true statement and a refusal was a false one: the
 *     catalog's `features.metasEnabled` is the SITE'S VISIBILITY LABEL, not a
 *     data gate. Measured live 2026-08-25,
 *     `/metas/v1/trending?chainId=robinhood` returned 7 real aggregates (cat
 *     $253.8 M over 15 tokens) with that flag false, and ton and polygon
 *     aggregate too, so the old four-chain gate refused reachable provider
 *     data with the message "DexScreener serves no narratives for robinhood".
 *     `totalNarratives` is therefore always the provider's own catalog count
 *     from `/metas/v1/all` (18 today), `activeNarratives` is how many of them
 *     had activity in THIS document, and the difference is named row by row.
 *  2. THE `id` IS THE HANDOFF VALUE AND THE `slug` IS NOT. Both are returned
 *     and the response says which one `metaIds` takes, because the screener
 *     matches zero pairs on a slug and an empty board reads as a real answer.
 *  3. `topTokens` ACCOUNTS FOR ITSELF. Enrichment is bounded, and every
 *     narrative that was not enriched is NAMED, so an empty pair list is never
 *     ambiguous between "this theme has no pairs" and "this row was not asked
 *     about".
 *
 * TRANSPORT. This channel lives on the website host, reachable only through
 * the desktop bridge. A headless caller reaches the default public-API
 * transport and gets its typed `SITE_TRANSPORT_UNAVAILABLE` with the remedy,
 * which is the honest answer rather than an empty result.
 */

import {
  fetchChainsCatalog,
  resolveChainSlugs,
  assertChainSlugsResolved,
  type ChainsCatalog,
} from "@tools/dexscreener/endpoints/chains-catalog.js";
import {
  fetchNarrativeCatalog,
  fetchNarratives,
  type NarrativeRow,
} from "@tools/dexscreener/endpoints/metas.js";
import { fetchScreenerPage } from "@tools/dexscreener/endpoints/screener.js";
import {
  buildScreenQuery,
  type ScreenWindow,
} from "@tools/dexscreener/screen-core/request.js";
import { projectPairRow } from "@tools/dexscreener/screen-core/project.js";
import {
  readCacheObservation,
  type SourceObservation,
} from "@tools/dexscreener/screen-core/envelope.js";
import {
  getDexScreenerTransport,
  type DexScreenerTransport,
} from "@tools/dexscreener/transport.js";
import { sanitizeIssuerField } from "@tools/dexscreener/sanitize.js";
import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
  siteError,
} from "@tools/dexscreener/site-errors.js";
import { fail, num, ok, str } from "../../handler-helpers.js";
import type { ProtocolHandler } from "../../types.js";
import {
  NARRATIVE_FIELD_GROUPS,
  NARRATIVE_FIELD_GROUPS_DEFAULT,
  NARRATIVE_LIMIT_DEFAULT,
  NARRATIVE_LIMIT_MIN,
  NARRATIVE_SORT_KEYS,
  NARRATIVE_MAX_ENRICHED_DEFAULT,
  NARRATIVE_MAX_ENRICHED_MIN,
  NARRATIVE_TOP_TOKENS_MIN,
  NARRATIVE_TOP_TOKENS_OFF,
  type NarrativeFieldGroup,
  type NarrativeSortKey,
} from "../manifests/market-context-params.js";

/** Deadline for one plain HTTP read. */
const HTTP_TIMEOUT_MS = 15_000;
/** Deadline for one screener channel exchange, used only by `topTokens`. */
const CHANNEL_TIMEOUT_MS = 20_000;
/** The catalog is a 63 KB document behind a 24 hour cache. */
const CATALOG_TIMEOUT_MS = 15_000;

const ALL_WINDOWS: readonly ScreenWindow[] = ["m5", "h1", "h6", "h24"];

/* ------------------------------------------------------------------ */
/* Param reading                                                       */
/* ------------------------------------------------------------------ */

function readWindow(params: Record<string, unknown>): ScreenWindow {
  const raw = str(params, "window");
  if (raw === "") return "h24";
  if (!ALL_WINDOWS.includes(raw as ScreenWindow)) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_FILTER_VALUE_INVALID,
      `"window" must be one of the change windows the provider measures; received "${raw}"`,
      `Accepted windows: ${ALL_WINDOWS.join(", ")}.`
    );
  }
  return raw as ScreenWindow;
}

function readGroups(
  params: Record<string, unknown>
): readonly NarrativeFieldGroup[] {
  const raw = str(params, "fields");
  if (raw.trim() === "") return NARRATIVE_FIELD_GROUPS_DEFAULT;
  const requested = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const unknown = requested.filter(
    (part) => !NARRATIVE_FIELD_GROUPS.includes(part as NarrativeFieldGroup)
  );
  if (unknown.length > 0) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_FIELD_GROUP_UNKNOWN,
      `"fields" named ${unknown.length === 1 ? "a row field group" : "row field groups"} that does not exist on a narrative row: ${unknown.join(", ")}`,
      `"fields" takes row field GROUPS, not individual field names. Supported groups: ${NARRATIVE_FIELD_GROUPS.join(", ")}.`
    );
  }
  const selected = new Set<NarrativeFieldGroup>(["core"]);
  for (const part of requested) selected.add(part as NarrativeFieldGroup);
  return NARRATIVE_FIELD_GROUPS.filter((group) => selected.has(group));
}

function readLimit(params: Record<string, unknown>): number {
  const raw = num(params, "limit");
  if (raw === undefined) return NARRATIVE_LIMIT_DEFAULT;
  if (!Number.isInteger(raw) || raw < NARRATIVE_LIMIT_MIN) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_SHAPING_VALUE_INVALID,
      `"limit" must be a whole number of ${NARRATIVE_LIMIT_MIN} or more; received ${String(raw)}`,
      "There is no upper bound to refuse against: the provider sends the whole set in one document, so a larger limit returns the whole set."
    );
  }
  return raw;
}

/**
 * Read `topTokens`.
 *
 * The old ceiling of 10 is gone (plan 14.6 item 4). It bounded nothing real:
 * the enriching call fetches a whole screener page either way, so this number
 * only decides how much of a page already in hand is projected, and a value
 * above the page returns the page. What costs a request is the number of
 * narratives enriched, which `maxEnrichedNarratives` owns.
 */
function readTopTokens(params: Record<string, unknown>): number {
  const raw = num(params, "topTokens");
  if (raw === undefined || raw === NARRATIVE_TOP_TOKENS_OFF) {
    return NARRATIVE_TOP_TOKENS_OFF;
  }
  if (!Number.isInteger(raw) || raw < NARRATIVE_TOP_TOKENS_MIN) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_SHAPING_VALUE_INVALID,
      `"topTokens" must be a whole number of ${NARRATIVE_TOP_TOKENS_MIN} or more, or 0 for no enrichment; received ${String(raw)}`,
      "There is no upper bound to refuse against: one screener page is already fetched per enriched narrative, so a larger value returns as much of that page as it holds. What costs a request is maxEnrichedNarratives."
    );
  }
  return raw;
}

/**
 * Read `maxEnrichedNarratives`.
 *
 * A DEFAULT with no ceiling. Each additional narrative is one additional
 * WebSocket screener exchange inside this call's deadline, which is the real
 * bound; refusing a sixth was a Vex invention with nothing behind it.
 */
function readMaxEnriched(params: Record<string, unknown>): number {
  const raw = num(params, "maxEnrichedNarratives");
  if (raw === undefined) return NARRATIVE_MAX_ENRICHED_DEFAULT;
  if (!Number.isInteger(raw) || raw < NARRATIVE_MAX_ENRICHED_MIN) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_SHAPING_VALUE_INVALID,
      `"maxEnrichedNarratives" must be a whole number of ${NARRATIVE_MAX_ENRICHED_MIN} or more; received ${String(raw)}`,
      "There is no upper bound to refuse against: each enriched narrative is one sequential WebSocket screener exchange and this call's deadline is what bounds them."
    );
  }
  return raw;
}

interface Ordering {
  readonly key: NarrativeSortKey;
  readonly direction: "asc" | "desc";
}

function readOrdering(params: Record<string, unknown>): Ordering {
  const rawKey = str(params, "sortBy");
  const key = rawKey === "" ? "marketCapUsd" : rawKey;
  if (!NARRATIVE_SORT_KEYS.includes(key as NarrativeSortKey)) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_RANK_KEY_NOT_SUPPORTED,
      `"sortBy" must name a column a narrative row carries; received "${rawKey}"`,
      `Accepted values: ${NARRATIVE_SORT_KEYS.join(", ")}.`
    );
  }
  const rawDir = str(params, "sortDir");
  if (rawDir !== "" && rawDir !== "asc" && rawDir !== "desc") {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_SHAPING_VALUE_INVALID,
      `"sortDir" must be asc or desc; received "${rawDir}"`,
      "Send desc for the largest values first, asc for the smallest."
    );
  }
  return {
    key: key as NarrativeSortKey,
    direction: rawDir === "asc" ? "asc" : "desc",
  };
}

/* ------------------------------------------------------------------ */
/* Chain resolution                                                    */
/* ------------------------------------------------------------------ */

/**
 * Every catalog slug the SITE surfaces a narratives page for, in catalog order.
 *
 * A visibility label and nothing else. It is reported so an agent can say why
 * a chain has no page on dexscreener.com; it must never decide whether a chain
 * may be asked, because chains outside it aggregate narratives (measured:
 * robinhood 7, ton 3, polygon 1).
 */
function chainsSurfacedOnSite(catalog: ChainsCatalog): readonly string[] {
  return catalog.chains
    .filter((chain) => chain.features.metasEnabled)
    .map((chain) => chain.slug);
}

/**
 * Resolve the requested chain to its canonical catalog spelling, or refuse.
 *
 * ONE refusal remains, and it is the one that is true: a slug that is not a
 * chain at all. The second refusal this function used to carry, on
 * `features.metasEnabled`, was removed after the flag was measured to be a
 * site-visibility label rather than a data gate; a real chain with no
 * narratives is now a successful "0 of 18 active" answer, which is what the
 * provider itself says.
 */
function resolveNarrativeChain(
  catalog: ChainsCatalog,
  requested: string
): string {
  // ROUTED THROUGH THE CATALOG'S OWN RESOLVER, not a second lookup beside it.
  // A bare `bySlug.get` was measured breaking two promises this surface makes
  // everywhere else: a typo ("solna") came back with no candidates at all,
  // and a numeric chain id ("8453") was refused outright even though the
  // catalog carries `nativeChainId` and the surface's own chain sentence
  // offers that spelling. `resolveChainSlugs` owns both behaviours.
  const resolution = resolveChainSlugs(catalog, [requested]);
  assertChainSlugsResolved(resolution);
  const resolved = resolution.valid[0];
  if (resolved === undefined) {
    throw siteError(
      DexScreenerSiteErrorCodes.CHAIN_SLUG_UNKNOWN,
      `"${requested}" is not a chain in the DexScreener catalog`,
      "Call dexscreener__chains_list for every accepted slug. The narratives endpoint answers an unknown chain with an empty success, which is indistinguishable from a real quiet chain, so the slug is refused here instead."
    );
  }
  return resolved;
}

/* ------------------------------------------------------------------ */
/* Row shaping                                                         */
/* ------------------------------------------------------------------ */

function sortValue(row: NarrativeRow, key: NarrativeSortKey, window: ScreenWindow): number | null {
  switch (key) {
    case "marketCapUsd":
      return row.marketCapUsd;
    case "volumeUsd":
      return row.volumeUsd;
    case "liquidityUsd":
      return row.liquidityUsd;
    case "tokenCount":
      return row.tokenCount;
    case "marketCapChangePct":
      return row.windows[window].marketCapChangePct;
    case "volumeToMarketCapRatio":
      return row.volumeToMarketCapRatio;
  }
}

/**
 * Order the whole set.
 *
 * Rows whose sort value the provider did not report sink to the END in both
 * directions: they are unranked rather than smallest, and floating a data gap
 * to the top of an `asc` ranking would present it as the extreme the caller
 * asked for.
 */
function sortRows(
  rows: readonly NarrativeRow[],
  ordering: Ordering,
  window: ScreenWindow
): readonly NarrativeRow[] {
  const sign = ordering.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = sortValue(left, ordering.key, window);
    const b = sortValue(right, ordering.key, window);
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * sign;
  });
}

function shapeRow(
  row: NarrativeRow,
  groups: readonly NarrativeFieldGroup[],
  window: ScreenWindow,
  sanitized: Set<string>
): Record<string, unknown> {
  const selected = row.windows[window];
  return {
    // Named `id` exactly as the screener filter spells it, so the handoff is a
    // copy and not a translation.
    id: row.id,
    name: sanitizeIssuerField(row.name, "name", sanitized),
    slug: row.slug,
    marketCapUsd: row.marketCapUsd,
    liquidityUsd: row.liquidityUsd,
    volumeUsd: row.volumeUsd,
    tokenCount: row.tokenCount,
    window,
    marketCapChangePct: selected.marketCapChangePct,
    marketCapDeltaUsd: selected.marketCapDeltaUsd,
    volumeToMarketCapRatio: row.volumeToMarketCapRatio,
    providerRank: row.providerRank,
    ...(groups.includes("windows") ? { windows: row.windows } : {}),
    ...(groups.includes("description")
      ? {
          description: sanitizeIssuerField(
            row.description,
            "description",
            sanitized
          ),
          iconType: row.iconType,
          iconValue: sanitizeIssuerField(row.iconValue, "iconValue", sanitized),
          alternativeSlugs: row.alternativeSlugs,
        }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* topTokens enrichment                                                */
/* ------------------------------------------------------------------ */

interface TopTokensOutcome {
  /** Narrative id to its leading pairs. Only enriched narratives appear. */
  readonly byNarrativeId: ReadonlyMap<string, readonly Record<string, unknown>[]>;
  readonly enrichedIds: readonly string[];
  readonly notEnrichedIds: readonly string[];
  readonly requestsIssued: number;
  /**
   * Per enriched narrative: what the screener page actually held against what
   * the theme matches. `topTokens` above 100 returns the page, and the answer
   * said so nowhere: a 100-row list was published for a theme whose frame
   * reported 1,034 matching pairs, and `topTokensCoverage` accounted only for
   * REQUESTS, never for rows. The reader could not tell what was left out.
   */
  readonly rowCoverage: readonly {
    readonly narrativeId: string;
    /** Rows returned in this narrative's `topTokens` list. */
    readonly returned: number;
    /** Rows the provider's page held before `topTokens` cut it. */
    readonly pageRows: number;
    /** The frame's own count of pairs matching the theme, when it sent one. */
    readonly pairsAvailable: number | null;
    readonly truncated: boolean;
  }[];
}

/**
 * Fetch each narrative's leading pairs, bounded and accounted for.
 *
 * Sequential rather than concurrent for the same reason every other fan-out on
 * this surface is: these are browser-shaped requests against one host, and the
 * fan-out is already bounded.
 */
async function enrichTopTokens(
  rows: readonly NarrativeRow[],
  options: {
    readonly topTokens: number;
    readonly maxEnriched: number;
    readonly chain: string | null;
    readonly window: ScreenWindow;
    readonly transport: DexScreenerTransport;
    readonly signal: AbortSignal | undefined;
  }
): Promise<TopTokensOutcome> {
  const targets = rows.slice(0, options.maxEnriched);
  const byNarrativeId = new Map<string, readonly Record<string, unknown>[]>();
  const enrichedIds: string[] = [];
  const rowCoverage: TopTokensOutcome["rowCoverage"][number][] = [];
  let requestsIssued = 0;

  for (const row of targets) {
    const query = buildScreenQuery({
      rankBy: { key: "volume", order: "desc" },
      window: options.window,
      metaIds: [row.id],
      ...(options.chain === null ? {} : { chainIds: [options.chain] }),
    });
    const page = await fetchScreenerPage(query, {
      page: 1,
      transport: options.transport,
      timeoutMs: CHANNEL_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    requestsIssued += 1;

    const nowMs = Date.now();
    const pairs = page.frame.rows
      .slice(0, options.topTokens)
      .map((raw: unknown) => {
        // Omitted, not null: the narratives document carries no stats block,
        // so frameVolumeUsd is absent rather than missing. See the three-state
        // contract on projectPairRow.
        const projected = projectPairRow(raw, {
          window: options.window,
          nowMs,
        });
        return {
          chainId: projected.chainId,
          dexId: projected.dexId,
          pairAddress: projected.pairAddress,
          baseTokenAddress: projected.baseToken.address,
          baseTokenSymbol: projected.baseToken.symbol,
          priceUsd: projected.priceUsd,
          priceChangePct: projected.priceChangePct,
          volumeUsd: projected.volumeUsd,
          liquidityUsd: projected.liquidityUsd,
          marketCapUsd: projected.marketCapUsd,
        };
      });
    byNarrativeId.set(row.id, pairs);
    enrichedIds.push(row.id);
    const pairsAvailable = page.frame.pairsCount;
    rowCoverage.push({
      narrativeId: row.id,
      returned: pairs.length,
      pageRows: page.frame.rows.length,
      pairsAvailable,
      truncated:
        pairs.length < page.frame.rows.length
        || (pairsAvailable !== null && pairs.length < pairsAvailable),
    });
  }

  return {
    byNarrativeId,
    enrichedIds,
    notEnrichedIds: rows.slice(options.maxEnriched).map((row) => row.id),
    requestsIssued,
    rowCoverage,
  };
}

/* ------------------------------------------------------------------ */
/* The tool                                                            */
/* ------------------------------------------------------------------ */

async function runNarratives(
  params: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<ReturnType<typeof ok>> {
  const transport = getDexScreenerTransport();
  const window = readWindow(params);
  const groups = readGroups(params);
  const ordering = readOrdering(params);
  const limit = readLimit(params);
  const topTokens = readTopTokens(params);
  const maxEnriched = readMaxEnriched(params);

  const catalog = await fetchChainsCatalog({
    transport,
    timeoutMs: CATALOG_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });

  const requestedChain = str(params, "chain");
  const chain =
    requestedChain === "" ? null : resolveNarrativeChain(catalog, requestedChain);

  const document = await fetchNarratives({
    transport,
    timeoutMs: HTTP_TIMEOUT_MS,
    chainId: chain,
    ...(signal === undefined ? {} : { signal }),
  });

  /*
   * A CHAIN-SCOPED DOCUMENT IS NOT THE CATALOG.
   *
   * `/metas/v1/trending?chainId=base` carries only the narratives with
   * activity on base: 7 of them, measured, while `/metas/v1/all` lists 18 and
   * ethereum's document carries 11. Reporting the chain document's length as
   * `totalNarratives` and calling it "an exact count of what exists" made a
   * quiet theme indistinguishable from a theme that does not exist, which is
   * the silent-absence failure this module's Rule 1 was written against, one
   * level down. `fetchNarrativeCatalog` was already exported for exactly this
   * and had no production caller.
   *
   * One extra 1.5 KB request, and only on a chain-scoped call: the unscoped
   * document IS the catalog, so asking again there would buy nothing.
   *
   * It is also what makes a QUIET chain answerable at all. With the
   * four-chain gate removed, a chain-scoped call can legitimately return zero
   * rows, and "0" is an honest answer only next to the population it is zero
   * of: the catalog supplies that 18.
   */
  const catalogNarratives =
    chain === null
      ? null
      : await fetchNarrativeCatalog({
          transport,
          timeoutMs: HTTP_TIMEOUT_MS,
          ...(signal === undefined ? {} : { signal }),
        });
  /**
   * How many narratives DexScreener defines AT ALL, from its own catalog.
   * The 18 in "N of 18 active". On an unscoped call the document IS the
   * catalog, so its own length is that same count.
   */
  const totalNarratives = catalogNarratives?.length ?? document.rows.length;
  /** How many of them had activity in THIS document. The N. */
  const activeNarratives = document.rows.length;
  const presentSlugs = new Set(document.rows.map((row) => row.slug));
  const absentSlugs =
    catalogNarratives === null
      ? []
      : catalogNarratives
          .map((identity) => identity.slug)
          .filter((slug) => !presentSlugs.has(slug))
          .sort();

  const ordered = sortRows(document.rows, ordering, window);
  const windowed = ordered.slice(0, limit);

  const enrichment =
    topTokens === 0
      ? null
      : await enrichTopTokens(windowed, {
          topTokens,
          maxEnriched,
          chain,
          window,
          transport,
          signal,
        });

  const sanitized = new Set<string>();
  const rows = windowed.map((row) => {
    const shaped = shapeRow(row, groups, window, sanitized);
    if (enrichment === null) return shaped;
    const pairs = enrichment.byNarrativeId.get(row.id);
    return {
      ...shaped,
      // Present and empty means "asked, and the screener returned nothing";
      // ABSENT means "not asked". Collapsing the two would make an unenriched
      // row indistinguishable from an empty theme.
      ...(pairs === undefined ? {} : { topTokens: pairs }),
    };
  });

  return ok({
    summary:
      (chain === null
        ? `${activeNarratives} of ${totalNarratives} DexScreener narratives active across every chain, ${rows.length} shown, `
        : `${activeNarratives} of ${totalNarratives} DexScreener narratives active on ${chain}, ${rows.length} shown, `)
      + `ordered by ${ordering.key} ${ordering.direction} over ${window}.`
      + (chain !== null && activeNarratives === 0
          ? ` ${chain} is a QUIET chain right now, not an unsupported one: the provider answered successfully with none of its ${totalNarratives} narratives active there. Ask again later or drop chain for the cross-chain document.`
          : "")
      + (absentSlugs.length === 0 || activeNarratives === 0
          ? ""
          : ` ${absentSlugs.length} narrative(s) exist but had no activity on ${chain ?? ""} in this document: ${absentSlugs.join(", ")}. That is silence, not absence.`),
    rows,
    chain,
    window,
    returned: rows.length,
    /**
     * How many narratives DexScreener defines at all, from `/metas/v1/all`.
     * The denominator in "N of 18 active", and the same number on every call
     * whatever the chain.
     */
    totalNarratives,
    /**
     * How many of them this document carried, i.e. how many are active on the
     * requested scope. ZERO IS A REAL ANSWER: a quiet chain, not a refusal.
     */
    activeNarratives,
    ...(chain === null
      ? {}
      : {
          narrativesWithoutActivityOnChain: absentSlugs,
        }),
    hasMore: false,
    pagination: {
      mode: "whole_population",
      note:
        "This channel has no pages, no cursor and no provider total, because it does not need one: the whole document arrives at once, and every narrative not shown is reachable by raising limit without another request."
        + (chain === null
          ? " On an unscoped call this document IS the catalog, so activeNarratives and totalNarratives are the same exact count."
          : " activeNarratives counts the narratives with activity on this chain, which is NOT the same as the narratives that exist: totalNarratives is that count, read from the provider's own catalog, and narrativesWithoutActivityOnChain names the difference. A narrative missing from the rows is quiet here, not non-existent, and so is a chain with no rows at all."),
    },
    ordering,
    /**
     * The site-visibility label, reported and never enforced.
     */
    siteVisibility: {
      chainsSurfacedOnSite: chainsSurfacedOnSite(catalog),
      requestedChainSurfacedOnSite:
        chain === null
          ? null
          : catalog.bySlug.get(chain)?.features.metasEnabled ?? false,
      note: "chainsSurfacedOnSite lists the chains dexscreener.com gives a narratives PAGE to, from the catalog's features.metas.isEnabled. It is a website label and NOT a data gate: this tool aggregates narratives for any chain, and chains outside the list return real aggregates (measured 2026-08-25: robinhood 7 narratives with cat at $253.8 M over 15 tokens, ton 3, polygon 1). A chain with no rows is quiet, not unsupported.",
    },
    /**
     * The whole reason this tool is the first hop for a theme question.
     */
    screenerHandoff: {
      parameter: "metaIds",
      valueField: "id",
      note: "Pass a row's `id` (NOT its `slug`) as `metaIds` on any screening tool to get that narrative's individual pairs. The slug is a site URL segment and the screener matches zero pairs on it; measured, slug \"ai\" matched 0 while its id matched 243.",
    },
    ...(enrichment === null
      ? {
          topTokensRequested: false,
        }
      : {
          topTokensRequested: true,
          topTokensCoverage: {
            perNarrative: topTokens,
            maxEnrichedNarratives: maxEnriched,
            enrichedNarrativeIds: enrichment.enrichedIds,
            notEnrichedNarrativeIds: enrichment.notEnrichedIds,
            requestsIssued: enrichment.requestsIssued,
            perNarrativeRows: enrichment.rowCoverage,
            note: `Enrichment costs one WebSocket screener exchange per narrative and was bounded at ${maxEnriched} narratives for this call, which is maxEnrichedNarratives and has no upper limit beyond the deadline. A row with no topTokens key was NOT enriched; a row with an empty topTokens list was enriched and the screener returned nothing for it. For the narratives named in notEnrichedNarrativeIds, raise maxEnrichedNarratives or call a screening tool with their id as metaIds. perNarrativeRows says, per enriched narrative, how many pairs were shown, how many the provider's single 100-row page held, and how many the frame reported matching the theme: a topTokens above the page size returns the page, so pairsAvailable is how many exist and every one of them is reachable through a screening tool with this narrative's id as metaIds.`,
          },
        }),
    classificationNote:
      "A narrative row is an aggregate over every token DexScreener assigns to the theme. How it assigns them is the provider's own opaque classification, not a measured on-chain fact, and it is not audited here. IT ALSO LAGS, BY HOURS, and that is the form the limitation takes in practice: a brand-new token trading hard on a theme is usually NOT in that theme's population yet, so a narrative board is a poor way to find one. Measured - the top boosted cat-theme token, MrCate at +504 percent over h24, was absent from the Cat metaIds population entirely, confirmed against the full window with onlyBoosted. Use a screening tool for what is moving now and this one for where the money already sits.",
    sanitizedFields: [...sanitized].sort(),
    providerWindow: {
      // S10-42: the value belongs in the echo. Rendering the bare "?chainId="
      // told the reader a scoped call had been made and not which scope.
      endpoint:
        chain === null
          ? "/metas/v1/trending"
          : `/metas/v1/trending?chainId=${chain}`,
      serverSide: chain !== null,
      responseBytes: document.bytes,
      note: chain === null
        ? "One cross-chain request. The provider sends every narrative it tracks in one document."
        : "One request scoped to the chain SERVER-side, which is the only narrowing this endpoint honours.",
    },
    /*
     * The cache state is READ from the response, never asserted.
     *
     * This channel is plain HTTP behind Cloudflare, and the edge was measured
     * serving `/metas/v1/trending` as HIT / EXPIRED / REVALIDATED under
     * `public, max-age=30` with `age` between 0 and 25 s. The hardcoded
     * `"not_cached"` that used to sit here therefore told the agent an answer
     * had touched no cache while it could be half a minute old. `not_cached`
     * remains correct for a WebSocket channel, where no cache sits between a
     * frame and its socket; it is never correct for this one.
     */
    sourceObservation: {
      transport: transport.name,
      fetchedAtMs: document.fetchedAtMs,
      ...readCacheObservation(document.headers),
    } satisfies SourceObservation,
  });
}

/* ------------------------------------------------------------------ */
/* Handler map                                                         */
/* ------------------------------------------------------------------ */

/**
 * Wrap the tool so a typed site failure reaches the agent as its real cause
 * and remedy rather than as an unhandled throw. Only OUR typed failures are
 * converted; anything else keeps propagating so a defect stays visible.
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

export const DEXSCREENER_MARKET_CONTEXT_HANDLERS: Record<string, ProtocolHandler> = {
  "dexscreener.trending": guarded("dexscreener__narratives_list", (p, s) =>
    runNarratives(p, s)
  ),
};
