/**
 * BOARD SPOTLIGHT SERVICE - the main-process owner of the four one-shot reads
 * behind the spotlight's lower sections.
 *
 * ONE SUBJECT, FIVE READS. Smart money, the tape, momentum, other pools and the
 * promotion-plus-narrative context are all addressed by the SAME canonical
 * `PairSubject`, resolved once and cached, rather than by five slightly
 * different tuples assembled at five call sites. That is not tidiness: the
 * subject carries `ammId` and `quoteTokenAddress`, and three endpoints answer
 * HTTP 200 with the pair SILENTLY INVERTED when the quote address is wrong,
 * absent, naming the base token, or merely the CORRECT ADDRESS LOWER-CASED.
 * Measured on ethereum PEPE/WETH: the same top maker comes back with buy and
 * sell transposed, amounts in the other token, and `netCashFlowUsd` FLIPPING
 * SIGN. There is no error and no way to tell from the rows. So the subject is
 * resolved by the provider's own resolver, passed through byte for byte, and
 * never re-cased anywhere below.
 *
 * WHAT EACH SECTION IS, AND THE MEASUREMENT THAT SHAPED IT
 * (`board-v3-probes/PROBES.md`, captured 2026-08-26):
 *
 *  - SMART MONEY is a 30-DAY PAIR-LOCAL CASH FLOW leaderboard and is labelled
 *    as one. The window is the provider's own ceiling
 *    (`TOP_TRADERS_LOOKBACK_DAYS_MAX`, a machine artifact) and every money
 *    figure is RECOMPUTED over it rather than filtered by it: probe P3
 *    measured a 28x difference for one wallet between a 30-day and a 1-day
 *    window. The ranking is FROZEN at read time, and nothing here claims
 *    accumulation, distribution, profit or smart money: the provider cannot see
 *    transfers or other venues, which its own envelope says.
 *  - MOMENTUM is a VIEW-TIME sidecar, not hydration. The board's persisted row
 *    carries h1 and h24 price plus h24 volume and trades, which cannot answer
 *    "is this accelerating". So the four windows are read from one live pair
 *    snapshot at view time and normalized by duration.
 *  - OTHER POOLS reads the provider's bounded RELEVANCE window, excludes the
 *    pool on screen BEFORE ranking, and says "seen" rather than "exist". The
 *    window is shared with other tokens and offers no continuation, so a count
 *    phrased as a fact about the token would be false.
 *  - PROMOTION reads `boostsActive` from the PAIR ROW. Probe P4: ETHCATE
 *    carried `boostsActive: 10` and was ABSENT from the bounded 30-row
 *    `spotlight` feed at the same moment, so non-membership in that feed is not
 *    evidence of zero boosts and the feed is not consulted here at all.
 *  - NARRATIVE joins `profile.metaIds` from the pair-details document to the
 *    narrative catalog's `id` (probe P6, demonstrated end to end: screening by
 *    a meta id returned a pair whose `profile.metaIds` was exactly that id).
 *    The SLUG is not the join key and matches zero pairs. An EMPTY array is the
 *    common case and is a designed state, never a missing element.
 *
 * CACHING AND LIFECYCLE are the shared cache's, not this file's: bounded LRU,
 * waiter-safe single-flight, transients never cached, and an AWAITED dispose
 * that drains in-flight reads before the transport they borrow can go away.
 * Every entry's life is short because these are view-time reads whose whole
 * value is being current; the windows below are burst absorbers for a spotlight
 * that mounts several sections in one tick, never freshness claims.
 */

import {
  TOP_TRADERS_LOOKBACK_DAYS_MAX,
  fetchTopTraders,
  type TopTraderRow,
} from "@tools/dexscreener/endpoints/top-traders.js";
import {
  fetchNarrativeCatalog,
  type NarrativeIdentity,
} from "@tools/dexscreener/endpoints/metas.js";
import { fetchPairSnapshot } from "@tools/dexscreener/endpoints/pair-live.js";
import {
  resolvePairSubject,
  type PairSubject,
} from "@tools/dexscreener/endpoints/pair-subject.js";
import {
  SEARCH_PROVIDER_WINDOW,
  searchPairs,
} from "@tools/dexscreener/endpoints/search.js";
import { projectPairRow } from "@tools/dexscreener/screen-core/project.js";
import {
  SCREEN_WINDOWS,
  type ScreenWindow,
} from "@tools/dexscreener/screen-core/request.js";
import { DexScreenerSiteErrorCodes } from "@tools/dexscreener/site-errors.js";
import { getDexScreenerTransport } from "@tools/dexscreener/transport.js";
import {
  boardSpotlightKey,
  type BoardMomentumOutcome,
  type BoardMomentumRow,
  type BoardOtherPool,
  type BoardOtherPoolsOutcome,
  type BoardSpotlightContextOutcome,
  type BoardSpotlightSubject,
  type BoardTopTrader,
  type BoardTopTradersOutcome,
} from "@shared/schemas/board-spotlight.js";
import { log } from "../logger/index.js";
import {
  createBoardReadCache,
  type BoardReadCache,
} from "./board-read-cache.js";
import {
  createBoardTapeService,
  type BoardTapeService,
} from "./board-tape-service.js";

/** Deadline for ONE provider exchange on these channels. */
const FETCH_TIMEOUT_MS = 12_000;

/** Distinct subjects read at once. Spotlight reads yield the pipe to the agent. */
const MAX_CONCURRENT_READS = 2;

/** Waiting distinct subjects. Past this a caller is refused rather than queued. */
const QUEUE_MAX = 16;

/** Settled entries held per cache. One spotlight visit plus a little history. */
const CACHE_CAPACITY = 12;

/**
 * How long a resolved subject is served from cache.
 *
 * Ten minutes, and it is the one LONG window here, because a pool's AMM id and
 * quote token are structural facts that do not change while a reader looks at
 * it. Re-resolving on every section would spend a provider exchange to learn
 * something already known.
 */
const SUBJECT_TTL_MS = 600_000;

/**
 * How long a leaderboard is served from cache. 30 s, matching the cadence the
 * plan gives the traders channel: a second section asking inside one tick gets
 * the same answer rather than a second exchange.
 */
const TRADERS_TTL_MS = 30_000;

/** How long a momentum snapshot is served. 5 s: it is the fastest-moving read. */
const MOMENTUM_TTL_MS = 5_000;

/** How long the other-pools window is served. A minute: liquidity moves slowly. */
const OTHER_POOLS_TTL_MS = 60_000;

/** How long promotion and narrative context is served. */
const CONTEXT_TTL_MS = 60_000;

/**
 * The narrative catalog's cache window.
 *
 * Five minutes and NOT keyed by subject: the catalog is one global document
 * (18 narratives at probe time) shared by every token on every board, so a
 * per-subject fetch would re-download the same document once per card.
 */
const NARRATIVE_CATALOG_TTL_MS = 300_000;

/** The display cap on the other-pools list, after ranking by depth. */
const OTHER_POOLS_MAX = 8;

/** The frozen heading the leaderboard must be shown under. */
const TRADERS_WINDOW_LABEL = `${TOP_TRADERS_LOOKBACK_DAYS_MAX}-day pair-local cash flow`;

/**
 * The frozen honesty line under the leaderboard.
 *
 * It says what the provider CAN see, because every wrong reading of this panel
 * comes from assuming it sees more.
 */
const TRADERS_SEMANTICS_NOTE =
  `Bought, sold and net are recomputed over the last ${TOP_TRADERS_LOOKBACK_DAYS_MAX} days on THIS pool only. ` +
  "The venue cannot see transfers or trades on other venues, so net is cash flow through this pool, " +
  "not profit and not a position. Ranking is the provider's own, frozen when this was read.";

/** The frozen honesty line under the promotion flag. */
const PROMOTION_NOTE =
  "A boost is paid placement on DexScreener. It buys visibility, not demand, and says nothing about the pool.";

/** The frozen honesty line under the other-pools bar. */
const OTHER_POOLS_NOTE =
  `Counted inside the provider's bounded relevance window of at most ${SEARCH_PROVIDER_WINDOW} rows, ` +
  "which is shared with other tokens and offers no continuation. This is what the window showed, " +
  "not a count of every pool this token trades in.";

/** How long each window is, in hours. The momentum normalizer's denominators. */
const WINDOW_HOURS: Readonly<Record<ScreenWindow, number>> = {
  m5: 5 / 60,
  h1: 1,
  h6: 6,
  h24: 24,
};

export interface BoardSpotlightService {
  topTraders(
    subject: BoardSpotlightSubject,
    signal?: AbortSignal,
  ): Promise<BoardTopTradersOutcome>;
  momentum(
    subject: BoardSpotlightSubject,
    signal?: AbortSignal,
  ): Promise<BoardMomentumOutcome>;
  otherPools(
    subject: BoardSpotlightSubject,
    signal?: AbortSignal,
  ): Promise<BoardOtherPoolsOutcome>;
  /**
   * Promotion and narrative together.
   *
   * `metaIds` comes from the board details bundle the caller already holds:
   * they are on the same pair-details document, so asking for them again here
   * would spend a provider exchange to learn something main read a moment ago.
   */
  context(args: {
    readonly subject: BoardSpotlightSubject;
    readonly metaIds: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<BoardSpotlightContextOutcome>;
  /** The tape, whose state machine is its own service. */
  readonly tape: BoardTapeService;
  /** Idempotent. Closes admission, aborts in flight, drains, clears. */
  dispose(): Promise<void>;
}

export interface BoardSpotlightServiceDeps {
  readonly resolveSubject: (args: {
    readonly chainId: string;
    readonly pairAddress: string;
    readonly signal: AbortSignal;
  }) => Promise<PairSubject>;
  readonly fetchTraders: (args: {
    readonly pair: PairSubject;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly rows: readonly TopTraderRow[]; readonly fetchedAtMs: number }>;
  readonly fetchRow: (args: {
    readonly subject: BoardSpotlightSubject;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly row: unknown; readonly fetchedAtMs: number }>;
  readonly fetchTokenPools: (args: {
    readonly pair: PairSubject;
    readonly signal: AbortSignal;
  }) => Promise<{
    readonly rows: readonly unknown[];
    readonly providerCapped: boolean;
    readonly fetchedAtMs: number;
  }>;
  readonly fetchNarratives: (args: {
    readonly signal: AbortSignal;
  }) => Promise<readonly NarrativeIdentity[]>;
  readonly now: () => number;
}

/* ------------------------------------------------------------------ */
/* Failure classification                                              */
/* ------------------------------------------------------------------ */

function siteCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * One failure as an unavailable outcome.
 *
 * Nothing on these channels is CACHED as a failure: a timeout, a 5xx or a torn
 * down transport says nothing about the pool, and remembering one would turn a
 * single bad second into a whole window of an empty section.
 */
function unavailableFrom(error: unknown): {
  readonly kind: "unavailable";
  readonly reason: "transport" | "provider" | "not_mounted";
} {
  const code = siteCodeOf(error);
  if (
    code === DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE ||
    code === DexScreenerSiteErrorCodes.TRANSPORT_HOST_NOT_ALLOWED
  ) {
    return { kind: "unavailable", reason: "not_mounted" };
  }
  if (code === DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT) {
    return { kind: "unavailable", reason: "transport" };
  }
  return { kind: "unavailable", reason: "provider" };
}

/* ------------------------------------------------------------------ */
/* Projections                                                         */
/* ------------------------------------------------------------------ */

/** One provider leaderboard row as the panel's row. */
function toTopTrader(row: TopTraderRow): BoardTopTrader {
  return {
    maker: row.maker,
    // WHOLE, never cut. A provider label is text a human reads; a silent
    // 120-character cut would show a different name than the provider sent.
    label: row.label,
    buys: row.buys,
    sells: row.sells,
    // Renamed to say what the column MEASURES. The provider calls these
    // `bought` and `sold`; the endpoint module already corrected the two whose
    // provider names are wrong, and this contract carries the corrections.
    boughtUsd: row.volumeUsdBuy,
    soldUsd: row.volumeUsdSell,
    netCashFlowUsd: row.netCashFlowUsd,
    providerRank: row.providerRank,
  };
}

/**
 * One window's momentum row.
 *
 * THE THREE FORMULAS, frozen:
 *
 *   volumeUsdPerHour = volumeUsd / hours
 *   tradesPerHour    = (buys + sells) / hours
 *   buySharePct      = volumeBuyUsd / (volumeBuyUsd + volumeSellUsd) * 100
 *
 * The first two divide by the window's own length so four incomparable totals
 * become four rates on one axis, which is the only way acceleration can be read
 * off the row: an h24 total is always larger than an m5 total and says nothing.
 * The third is already a share and needs no denominator of its own.
 *
 * A null input produces a null rate, never a zero. "The provider did not report
 * this window" and "nothing traded in this window" are different facts, and on
 * a momentum row the second one is a signal while the first one is a gap.
 * `buySharePct` is likewise null when both sides are zero, rather than an even
 * split nobody measured.
 */
function toMomentumRow(row: unknown, window: ScreenWindow, nowMs: number): BoardMomentumRow {
  const projected = projectPairRow(row, { window, nowMs });
  const hours = WINDOW_HOURS[window];
  const buys = projected.buys === null ? null : Number(projected.buys);
  const sells = projected.sells === null ? null : Number(projected.sells);
  const buyUsd = projected.volumeBuyUsd;
  const sellUsd = projected.volumeSellUsd;
  const bothSides = buyUsd === null || sellUsd === null ? null : buyUsd + sellUsd;
  return {
    window,
    hours,
    volumeUsd: projected.volumeUsd,
    volumeBuyUsd: buyUsd,
    volumeSellUsd: sellUsd,
    buys: buys === null || !Number.isFinite(buys) ? null : Math.max(0, Math.trunc(buys)),
    sells: sells === null || !Number.isFinite(sells) ? null : Math.max(0, Math.trunc(sells)),
    priceChangePct: projected.priceChangePct,
    volumeUsdPerHour: projected.volumeUsd === null ? null : projected.volumeUsd / hours,
    tradesPerHour:
      buys === null || sells === null || !Number.isFinite(buys) || !Number.isFinite(sells)
        ? null
        : (buys + sells) / hours,
    buySharePct:
      bothSides === null || bothSides <= 0 || buyUsd === null
        ? null
        : (buyUsd / bothSides) * 100,
  };
}

/* ------------------------------------------------------------------ */
/* The service                                                         */
/* ------------------------------------------------------------------ */

const defaultDeps: BoardSpotlightServiceDeps = {
  resolveSubject: async (args) =>
    resolvePairSubject({
      transport: getDexScreenerTransport(),
      chainId: args.chainId,
      pairAddress: args.pairAddress,
      timeoutMs: FETCH_TIMEOUT_MS,
      signal: args.signal,
    }),
  fetchTraders: async (args) => {
    const document = await fetchTopTraders({
      transport: getDexScreenerTransport(),
      chainId: args.pair.chainId,
      pairAddress: args.pair.pairAddress,
      ammId: args.pair.ammId,
      // VERBATIM from the resolver. Never re-cased: the lower-cased spelling of
      // the CORRECT address inverts the whole leaderboard and flips the sign of
      // every net figure, with no error.
      quoteTokenAddress: args.pair.quoteTokenAddress,
      // The panel is about who put money in, so the provider ranks by bought
      // and the panel says so. Frozen: a sort the renderer could choose would
      // be a knob on a channel that has none.
      sortBy: "boughtUsd",
      sortDir: "desc",
      lookbackDays: TOP_TRADERS_LOOKBACK_DAYS_MAX,
      onlyKol: false,
      timeoutMs: FETCH_TIMEOUT_MS,
      signal: args.signal,
    });
    return { rows: document.rows, fetchedAtMs: document.fetchedAtMs };
  },
  fetchRow: async (args) => {
    const snapshot = await fetchPairSnapshot({
      transport: getDexScreenerTransport(),
      chainId: args.subject.chain,
      pairAddress: args.subject.pairAddress,
      timeoutMs: FETCH_TIMEOUT_MS,
      signal: args.signal,
    });
    return { row: snapshot.row, fetchedAtMs: snapshot.fetchedAtMs };
  },
  fetchTokenPools: async (args) => {
    const result = await searchPairs({
      // The TOKEN, not the pool: the question is which other pools this token
      // trades in, and the pool address would answer with one row.
      query: args.pair.baseTokenAddress,
      chainIds: [args.pair.chainId],
      transport: getDexScreenerTransport(),
      timeoutMs: FETCH_TIMEOUT_MS,
      signal: args.signal,
    });
    return {
      rows: result.rows,
      providerCapped: result.providerCapped,
      fetchedAtMs: result.fetchedAtMs,
    };
  },
  fetchNarratives: async (args) =>
    fetchNarrativeCatalog({
      transport: getDexScreenerTransport(),
      timeoutMs: FETCH_TIMEOUT_MS,
      signal: args.signal,
    }),
  now: Date.now,
};

export function createBoardSpotlightService(
  overrides: Partial<BoardSpotlightServiceDeps> = {},
): BoardSpotlightService {
  const deps: BoardSpotlightServiceDeps = { ...defaultDeps, ...overrides };

  function cacheFor<T>(capacity = CACHE_CAPACITY): BoardReadCache<T | {
    readonly kind: "unavailable";
    readonly reason: "busy" | "not_mounted" | "cancelled";
  }> {
    return createBoardReadCache({
      capacity,
      maxConcurrent: MAX_CONCURRENT_READS,
      queueMax: QUEUE_MAX,
      now: deps.now,
      refusal: (reason) => ({ kind: "unavailable", reason }),
    });
  }

  const subjects = createBoardReadCache<PairSubject | { readonly failed: unknown }>({
    capacity: CACHE_CAPACITY,
    maxConcurrent: MAX_CONCURRENT_READS,
    queueMax: QUEUE_MAX,
    now: deps.now,
    refusal: (reason) => ({ failed: { code: reason } }),
  });
  const traders = cacheFor<BoardTopTradersOutcome>();
  const momentum = cacheFor<BoardMomentumOutcome>();
  const otherPools = cacheFor<BoardOtherPoolsOutcome>();
  const context = cacheFor<BoardSpotlightContextOutcome>();
  const narratives = createBoardReadCache<readonly NarrativeIdentity[]>({
    capacity: 1,
    maxConcurrent: 1,
    queueMax: QUEUE_MAX,
    now: deps.now,
    // A refused catalog is an EMPTY join, never a failed section: a token with
    // no resolvable narrative renders the same designed "no narrative" state
    // that the common empty case does.
    refusal: () => [],
  });

  /**
   * The canonical subject for one pool, resolved once and shared.
   *
   * A failure is returned rather than thrown so each section can turn it into
   * its own typed outcome, and it is NOT cached: nothing was learned about the
   * pool, and remembering that would keep every section of a spotlight empty
   * for the whole window after one bad second.
   */
  async function subjectFor(
    subject: BoardSpotlightSubject,
    signal: AbortSignal,
  ): Promise<PairSubject | { readonly failed: unknown }> {
    return subjects.read(
      boardSpotlightKey(subject),
      async (readSignal) => {
        try {
          const pair = await deps.resolveSubject({
            chainId: subject.chain,
            pairAddress: subject.pairAddress,
            signal: readSignal,
          });
          return { value: pair, expiresAtMs: deps.now() + SUBJECT_TTL_MS };
        } catch (error) {
          return { value: { failed: error }, expiresAtMs: null };
        }
      },
      signal,
    );
  }

  function resolutionFailed(
    value: PairSubject | { readonly failed: unknown },
  ): value is { readonly failed: unknown } {
    return "failed" in value;
  }

  const tape = createBoardTapeService({
    resolveSubject: async (args) => {
      const pair = await subjectFor(args.subject, args.signal);
      if (resolutionFailed(pair)) throw pair.failed;
      return pair;
    },
  });

  return {
    async topTraders(subject, signal): Promise<BoardTopTradersOutcome> {
      return traders.read(
        boardSpotlightKey(subject),
        async (readSignal): Promise<{
          value: BoardTopTradersOutcome;
          expiresAtMs: number | null;
        }> => {
          const pair = await subjectFor(subject, readSignal);
          if (resolutionFailed(pair)) {
            return { value: unavailableFrom(pair.failed), expiresAtMs: null };
          }
          try {
            const document = await deps.fetchTraders({ pair, signal: readSignal });
            return {
              value: {
                kind: "traders",
                // FROZEN AT READ TIME: the provider's own order, EVERY row it
                // returned, never re-ranked and never cut here. The provider's
                // own leaderboard window is the bound (up to
                // TOP_TRADERS_PROVIDER_WINDOW = 100 rows,
                // `src/tools/dexscreener/endpoints/top-traders.ts:87`) and it
                // has no offset, cursor or page, so a row dropped here would be
                // a row no caller could ever ask for again.
                rows: document.rows.map(toTopTrader),
                rowsAvailable: document.rows.length,
                lookbackDays: TOP_TRADERS_LOOKBACK_DAYS_MAX,
                windowLabel: TRADERS_WINDOW_LABEL,
                semanticsNote: TRADERS_SEMANTICS_NOTE,
                fetchedAtMs: document.fetchedAtMs,
              },
              expiresAtMs: deps.now() + TRADERS_TTL_MS,
            };
          } catch (error) {
            log.info("[board-spotlight] top traders produced no panel");
            return { value: unavailableFrom(error), expiresAtMs: null };
          }
        },
        signal,
      ) as Promise<BoardTopTradersOutcome>;
    },

    async momentum(subject, signal): Promise<BoardMomentumOutcome> {
      return momentum.read(
        boardSpotlightKey(subject),
        async (readSignal): Promise<{
          value: BoardMomentumOutcome;
          expiresAtMs: number | null;
        }> => {
          try {
            const snapshot = await deps.fetchRow({ subject, signal: readSignal });
            const nowMs = deps.now();
            return {
              value: {
                kind: "momentum",
                // ONE row, projected FOUR times. The windows are the
                // provider's own vocabulary, taken from the endpoint module
                // rather than spelled here.
                rows: SCREEN_WINDOWS.map((window) =>
                  toMomentumRow(snapshot.row, window, nowMs),
                ),
                fetchedAtMs: snapshot.fetchedAtMs,
              },
              expiresAtMs: deps.now() + MOMENTUM_TTL_MS,
            };
          } catch (error) {
            log.info("[board-spotlight] momentum produced no panel");
            return { value: unavailableFrom(error), expiresAtMs: null };
          }
        },
        signal,
      ) as Promise<BoardMomentumOutcome>;
    },

    async otherPools(subject, signal): Promise<BoardOtherPoolsOutcome> {
      return otherPools.read(
        boardSpotlightKey(subject),
        async (readSignal): Promise<{
          value: BoardOtherPoolsOutcome;
          expiresAtMs: number | null;
        }> => {
          const pair = await subjectFor(subject, readSignal);
          if (resolutionFailed(pair)) {
            return { value: unavailableFrom(pair.failed), expiresAtMs: null };
          }
          try {
            const result = await deps.fetchTokenPools({ pair, signal: readSignal });
            const nowMs = deps.now();
            const wanted = pair.baseTokenAddress.toLowerCase();
            const here = pair.pairAddress.toLowerCase();
            let unrelated = 0;
            const matching: BoardOtherPool[] = [];
            for (const raw of result.rows) {
              let projected;
              try {
                projected = projectPairRow(raw, { window: "h24", nowMs });
              } catch {
                // A row whose SHAPE drifted is not a pool of this token as far
                // as anything here can tell, and it is counted as unrelated
                // rather than silently skipped.
                unrelated += 1;
                continue;
              }
              // The relevance window answers an address query with RELEVANCE,
              // not with an exact-match guarantee, so rows for other tokens
              // ride along. They are removed and COUNTED: a pool that does not
              // trade this token would corrupt the count the bar states.
              if (projected.chainId.toLowerCase() !== pair.chainId.toLowerCase()) {
                unrelated += 1;
                continue;
              }
              const base = projected.baseToken.address.toLowerCase();
              const quote = projected.quoteToken.address.toLowerCase();
              if (base !== wanted && quote !== wanted) {
                unrelated += 1;
                continue;
              }
              // EXCLUDED BEFORE RANKING, so the deepest OTHER pool is what the
              // bar names rather than the pool already on screen.
              if (projected.pairAddress.toLowerCase() === here) continue;
              matching.push({
                chain: projected.chainId,
                pairAddress: projected.pairAddress,
                dexId: projected.dexId,
                quoteTokenSymbol: projected.quoteToken.symbol,
                liquidityUsd: projected.liquidityUsd,
                volumeH24Usd: projected.volumeUsd,
              });
            }
            // Deepest first. A pool whose liquidity the provider did not report
            // sorts last rather than as zero: missing is not empty.
            const ranked = [...matching].sort(
              (a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1),
            );
            const shown = ranked.slice(0, OTHER_POOLS_MAX);
            return {
              value: {
                kind: "other-pools",
                pools: shown,
                poolsSeen: matching.length,
                providerCapped: result.providerCapped,
                unrelatedRowsDropped: unrelated,
                withheldByLimit: matching.length - shown.length,
                windowNote: OTHER_POOLS_NOTE,
                fetchedAtMs: result.fetchedAtMs,
              },
              expiresAtMs: deps.now() + OTHER_POOLS_TTL_MS,
            };
          } catch (error) {
            log.info("[board-spotlight] other pools produced no panel");
            return { value: unavailableFrom(error), expiresAtMs: null };
          }
        },
        signal,
      ) as Promise<BoardOtherPoolsOutcome>;
    },

    async context(args): Promise<BoardSpotlightContextOutcome> {
      const { subject, metaIds, signal } = args;
      return context.read(
        // The join depends on the ids, so two calls with different ids must not
        // serve each other's answer.
        `${boardSpotlightKey(subject)}|${[...metaIds].sort().join(",")}`,
        async (readSignal): Promise<{
          value: BoardSpotlightContextOutcome;
          expiresAtMs: number | null;
        }> => {
          try {
            const snapshot = await deps.fetchRow({ subject, signal: readSignal });
            const projected = projectPairRow(snapshot.row, {
              window: "h24",
              nowMs: deps.now(),
            });
            // THE CATALOG IS ONLY FETCHED WHEN THERE IS SOMETHING TO JOIN. An
            // empty `metaIds` is the COMMON case, and spending a global
            // document on it would be a request per card for a guaranteed
            // empty answer.
            const catalog =
              metaIds.length === 0
                ? []
                : await narratives.read(
                    "catalog",
                    async (catalogSignal) => {
                      try {
                        return {
                          value: await deps.fetchNarratives({ signal: catalogSignal }),
                          expiresAtMs: deps.now() + NARRATIVE_CATALOG_TTL_MS,
                        };
                      } catch {
                        // A FAILED JOIN IS NOT A FAILED SECTION, and the
                        // fixture caught this escaping: an unreachable catalog
                        // used to reject out of the whole context read and
                        // take the promotion flag beside it down with it. An
                        // empty catalog leaves every id UNJOINED, which the
                        // answer names, so the failure is visible rather than
                        // silently rendered as "no narrative". Not cached: the
                        // catalog is a global document and one bad second must
                        // not empty it for five minutes.
                        return { value: [], expiresAtMs: null };
                      }
                    },
                    readSignal,
                  );
            const byId = new Map(catalog.map((entry) => [entry.id, entry]));
            const joined: { id: string; name: string; slug: string }[] = [];
            const unjoined: string[] = [];
            for (const id of metaIds.slice(0, 32)) {
              const found = byId.get(id);
              // A catalog that lags is VISIBLE rather than a list that quietly
              // shrank: the id is reported unjoined instead of dropped.
              if (found === undefined) unjoined.push(id);
              else joined.push({ id: found.id, name: found.name, slug: found.slug });
            }
            return {
              value: {
                kind: "context",
                // FROM THE PAIR ROW. Null is the row carrying no boost column,
                // which is the ordinary answer and is NOT zero.
                boostsActive: projected.boostsActive,
                promotionNote: PROMOTION_NOTE,
                narratives: joined,
                unjoinedMetaIds: unjoined,
                fetchedAtMs: snapshot.fetchedAtMs,
              },
              expiresAtMs: deps.now() + CONTEXT_TTL_MS,
            };
          } catch (error) {
            log.info("[board-spotlight] context produced no panel");
            return { value: unavailableFrom(error), expiresAtMs: null };
          }
        },
        signal,
      ) as Promise<BoardSpotlightContextOutcome>;
    },

    tape,

    async dispose(): Promise<void> {
      // The tape first: it owns the longest-lived work, and draining it before
      // the subject cache means nothing is left mid-continuation against a
      // subject that has already gone.
      await tape.dispose();
      await Promise.all([
        traders.dispose(),
        momentum.dispose(),
        otherPools.dispose(),
        context.dispose(),
        narratives.dispose(),
        subjects.dispose(),
      ]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* The mounted instance                                                */
/* ------------------------------------------------------------------ */

let mounted: BoardSpotlightService | null = null;

/**
 * Mount the one production instance and return its teardown.
 *
 * THE TEARDOWN IS ASYNC AND ITS PROMISE IS THE POINT, exactly as it is for the
 * icon and details services: the reads it drains run on the DexScreener
 * bridge's transport, and dropping this promise would let that bridge be
 * disposed underneath them.
 */
export function mountBoardSpotlightService(
  overrides: Partial<BoardSpotlightServiceDeps> = {},
): () => Promise<void> {
  const service = createBoardSpotlightService(overrides);
  mounted = service;
  return async () => {
    if (mounted === service) mounted = null;
    await service.dispose();
  };
}

/** The mounted service, or null when the app never started one. */
export function getBoardSpotlightService(): BoardSpotlightService | null {
  return mounted;
}

/** Test-only: release the process slot between cases. */
export function __resetBoardSpotlightServiceForTests(): void {
  mounted = null;
}
