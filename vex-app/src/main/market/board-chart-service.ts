/**
 * BOARD CHART SERVICE - the main-process owner of the SPOTLIGHT chart's bars.
 *
 * ONE READ, FOUR WINDOWS. The owner's mockup offers four pills and the chart
 * contract maps them to four provider resolutions. This service owns the whole
 * of what that mapping means: which resolution each pill is, how many bars its
 * window holds, how long one read may take, and what a bar that cannot be drawn
 * does to the answer. The renderer names a pool and a pill; nothing else on
 * this path is nameable from outside this process.
 *
 * THE WINDOW TABLE IS THE PRODUCT DECISION AND IT LIVES HERE:
 *
 *     1m  ->  60 bars    one hour of one-minute candles
 *     15m ->  96 bars    twenty-four hours of quarter-hour candles
 *     2h  ->  84 bars    seven days of two-hour candles
 *     8h  ->  90 bars    thirty days of eight-hour candles
 *
 * Each count is the pill's own span divided by its bar, and every one of them
 * sits under the board's own `BOARD_MAX_CANDLES` (200), which is the ceiling
 * the persisted candle series is validated against. A table test asserts both
 * properties - span arithmetic and the shared ceiling - so a window widened
 * later cannot quietly produce a series the board's own schema would refuse.
 *
 * EVERY POLL IS A FRESH READ, AND THAT IS THE DESIGN. There is NO positive
 * cache here, unlike the details and traders channels. A forming bar is the
 * whole reason the chart polls at all: serving a cached page for even one
 * cadence would show the reader a candle that stopped moving while the "LIVE"
 * dot claimed it had not. The cache this service does use is
 * `board-read-cache.ts` in its OTHER role - waiter-safe single-flight - so two
 * surfaces asking for the same pool and pill in the same tick cost one
 * provider exchange, and every settled read is discarded immediately
 * (`expiresAtMs: null`, which is also how that cache refuses to remember a
 * transient).
 *
 * CANCELLATION OWNERSHIP IS THIS FILE'S, because the cache deliberately does
 * not hold it: it lets a departing caller stop waiting without stopping the
 * shared read, since another caller may still need the answer. So each flight
 * COUNTS its waiters and the last one out aborts the provider call. That is
 * what makes leaving the spotlight cut the read rather than merely stop
 * looking at it, without letting one surface take an answer away from another.
 *
 * MAIN OWNS THE CADENCE VOCABULARY; THE RENDERER OWNS THE CLOCK. `chartCadenceMsFor`
 * in `shared/board/live-channels.ts` states how often a pill is worth
 * re-reading (1m every 5 s, 15m every 15 s, 2h and 8h every 30 s), and that
 * function is main's answer, not the renderer's opinion. But the TIMER that
 * drives this channel is the renderer's, inside the store's spotlight scope,
 * exactly as `tapePoll` is driven: the surface that can be left is the surface
 * that must own the thing that stops. There is no push on this channel and no
 * main-side timer for it. The scheduler's `spotlight-candles` slot exists so a
 * pill switch SUPERSEDES the previous arm; it re-arms a poll, it does not send
 * one.
 *
 * THE SUBJECT IS RESOLVED FROM THE PROVIDER, NEVER ASSEMBLED. The bars route
 * answers HTTP 200 with a SILENTLY INVERTED series for a quote token that is
 * wrong, absent, or merely lower-cased, and the inverted answer is
 * indistinguishable from a correct one at the row level (measured at seventeen
 * orders of magnitude in `endpoints/bars.ts`). So `ammId` and
 * `quoteTokenAddress` come verbatim from `resolvePairSubject` on every read.
 *
 * A DROPPED BAR IS COUNTED, NEVER SILENT. A bar without all four USD prices
 * cannot be drawn, so it is removed and reported: `undrawableBars` says how
 * many, `windowedOutBars` says how many drawable bars sat beyond the window,
 * and `series.truncated` is true when either happened. That is the same rule
 * `vex-agent/tools/internal/board/hydrate.ts` and the sparkline pipeline apply,
 * so a spotlight chart and the same board's other lines never disagree about
 * which bars exist.
 *
 * COALESCENCE. The site bridge joins identical concurrent exchanges onto the
 * first caller's promise, so a board read that joined an agent tool's exchange
 * could not be cut when the reader left the spotlight. `coalesceScope` is a
 * `WsExchangeOptions` field, and all four pills of this channel are served over
 * plain HTTP (`barTransportFor` returns `http` for every resolution whose
 * `httpRes` is non-null, which is all four), so the bridge does not coalesce
 * them at all and there is nothing for an agent read to join. The isolation is
 * therefore structural rather than requested: the single-flight key below is
 * private to this service and carries a per-mount run id, so it can never name
 * the same flight as anything outside it. Pinned by a table test on
 * `barTransportFor`, so a pill that moved to the socket transport would fail
 * the test instead of silently joining somebody else's exchange.
 */

import {
  barStepMs,
  fetchBarsPage,
  type ProjectedBar,
} from "@tools/dexscreener/endpoints/bars.js";
import {
  resolvePairSubject,
  type PairSubject,
} from "@tools/dexscreener/endpoints/pair-subject.js";
import { DexScreenerSiteErrorCodes } from "@tools/dexscreener/site-errors.js";
import { getDexScreenerTransport } from "@tools/dexscreener/transport.js";
import { decimalFromProvider } from "@vex-agent/tools/internal/board/hydrate-row.js";
import {
  type BoardCandle,
  type BoardCandleSeries,
} from "@vex-lib/board/index.js";
import {
  boardChartKey,
  type BoardChartOutcome,
  type BoardChartPillResolution,
  type BoardChartSubject,
} from "@shared/schemas/board-chart.js";
import { log } from "../logger/index.js";
import {
  createBoardReadCache,
  type BoardReadCache,
} from "./board-read-cache.js";

/**
 * Bars per pill.
 *
 * Each entry is its pill's span over its own bar: one hour of minutes, a day of
 * quarter-hours, a week of two-hour bars, a month of eight-hour bars. All four
 * are under the board's `BOARD_MAX_CANDLES`; see the table test.
 */
export const BOARD_CHART_BAR_COUNTS: Readonly<
  Record<BoardChartPillResolution, number>
> = {
  "1m": 60,
  "15m": 96,
  "2h": 84,
  "8h": 90,
};

/**
 * Deadline for ONE of the two reads a poll makes.
 *
 * Eight seconds, the same budget the sparkline pipeline runs its per-pool reads
 * under, against a measured per-call mean of 2.28 s and worst case 3.67 s on
 * the same chain (subject resolution plus one bars page, probe P5). A shorter
 * deadline would not make the chart faster; it would cut off answers that were
 * about to arrive and report them as provider failures.
 */
export const BOARD_CHART_READ_TIMEOUT_MS = 8_000;

/** Distinct pool-and-pill flights this service may run at once. */
const MAX_CONCURRENT_READS = 2;

/** Waiting flights past which a caller is refused rather than queued. */
const QUEUE_MAX = 8;

/**
 * Settled entries the single-flight cache may hold.
 *
 * ONE, and it never holds anything: every load returns `expiresAtMs: null`, so
 * nothing is ever remembered. The capacity exists because the cache takes one;
 * the read policy is what makes this channel uncached.
 */
const CACHE_CAPACITY = 1;

export interface BoardChartServiceDeps {
  /** Resolve the canonical subject. Never assembled: see the file head. */
  readonly resolveSubject: (args: {
    readonly chainId: string;
    readonly pairAddress: string;
    readonly signal: AbortSignal;
  }) => Promise<PairSubject>;
  /** Fetch ONE page of bars. Throws a typed site error on any failure. */
  readonly fetchBars: (args: {
    readonly pair: PairSubject;
    readonly resolution: BoardChartPillResolution;
    readonly countBack: number;
    readonly signal: AbortSignal;
  }) => Promise<{
    readonly bars: readonly ProjectedBar[];
    readonly fetchedAtMs: number;
  }>;
  readonly now: () => number;
}

const defaultDeps: BoardChartServiceDeps = {
  resolveSubject: async (args) =>
    resolvePairSubject({
      transport: getDexScreenerTransport(),
      chainId: args.chainId,
      pairAddress: args.pairAddress,
      timeoutMs: BOARD_CHART_READ_TIMEOUT_MS,
      signal: args.signal,
    }),
  fetchBars: async (args) => {
    const page = await fetchBarsPage({
      transport: getDexScreenerTransport(),
      chainId: args.pair.chainId,
      pairAddress: args.pair.pairAddress,
      ammId: args.pair.ammId,
      // VERBATIM from the resolver, never re-cased: a lower-cased spelling of
      // the CORRECT quote address answers 200 with the series silently
      // inverted, which on a chart means every rally is drawn as a crash.
      quoteTokenAddress: args.pair.quoteTokenAddress,
      resolution: args.resolution,
      series: "price",
      inverted: false,
      countBack: args.countBack,
      timeoutMs: BOARD_CHART_READ_TIMEOUT_MS,
      signal: args.signal,
    });
    return { bars: page.bars, fetchedAtMs: page.fetchedAtMs };
  },
  now: Date.now,
};

/**
 * One drawable bar: the durable candle plus the volume that rides BESIDE it.
 *
 * The volume is not a field of `BoardCandle` on purpose - that is a persisted,
 * strict schema - so the two travel as a pair here and as positional arrays
 * on the wire.
 */
interface DrawableBar {
  readonly candle: BoardCandle;
  /**
   * USD volume as the provider spelled it, or null when it reported none.
   * MEASURED (chart-volume-probe, 2026-08-26): non-null on every bar of every
   * pill on both transports (HTTP `volumeUsd`, feed socket `volumeUSD`, both
   * projected to `volumeUsd` by `endpoints/bars.ts`); the null arm exists
   * because the projection declares it, and it is COUNTED, never drawn as a
   * zero.
   */
  readonly volumeUsd: string | null;
}

/** One provider bar as a board candle with its volume, or null when it cannot be drawn. */
function toDrawableBar(bar: ProjectedBar): DrawableBar | null {
  const o = decimalFromProvider(bar.openUsd);
  const h = decimalFromProvider(bar.highUsd);
  const l = decimalFromProvider(bar.lowUsd);
  const c = decimalFromProvider(bar.closeUsd);
  if (o === null || h === null || l === null || c === null) return null;
  if (!Number.isSafeInteger(bar.timestampMs)) return null;
  return {
    candle: { tMs: bar.timestampMs, o, h, l, c },
    volumeUsd: decimalFromProvider(bar.volumeUsd),
  };
}

function siteCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * One failure as an outcome. Nothing here is retried automatically.
 *
 * `unknown_pair` is the provider's SETTLED answer that it does not know this
 * identity, so it is an absence. Everything else says nothing about the pool
 * and stays `unavailable`, which is what tells a renderer that asking again is
 * worth doing.
 */
function classifyFailure(error: unknown): BoardChartOutcome {
  const code = siteCodeOf(error);
  if (
    code === DexScreenerSiteErrorCodes.PAIR_DETAILS_UNKNOWN ||
    code === DexScreenerSiteErrorCodes.PAIR_IDENTITY_MISSING
  ) {
    return { kind: "absent", reason: "unknown_pair" };
  }
  if (
    code === DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE ||
    code === DexScreenerSiteErrorCodes.TRANSPORT_HOST_NOT_ALLOWED
  ) {
    return { kind: "unavailable", reason: "not_mounted" };
  }
  if (code === DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT) {
    return { kind: "unavailable", reason: "transport" };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { kind: "unavailable", reason: "cancelled" };
  }
  return { kind: "unavailable", reason: "provider" };
}

export interface BoardChartService {
  /**
   * Read one pool at one pill, live.
   *
   * Never throws for a provider problem: everything that can go wrong comes
   * back as a typed `absent` or `unavailable` outcome, because every state of
   * this chart is a designed state of the same element.
   *
   * `signal` is the IPC request's own. Aborting it yields a `cancelled`
   * outcome rather than a rejection, so a reader who left the spotlight sees no
   * error at all.
   */
  poll(args: {
    readonly subject: BoardChartSubject;
    readonly resolution: BoardChartPillResolution;
    readonly signal?: AbortSignal;
  }): Promise<BoardChartOutcome>;
  /** Idempotent. Closes admission, aborts in flight, drains. */
  dispose(): Promise<void>;
}

/**
 * Run ids, minted once per mounted service.
 *
 * The single-flight key carries one so a flight of this service can never be
 * named by anything outside it. See the file head on coalescence: it is what
 * keeps a spotlight teardown from touching an identical agent read.
 */
let nextRunId = 1;

export function createBoardChartService(
  overrides: Partial<BoardChartServiceDeps> = {},
): BoardChartService {
  const deps: BoardChartServiceDeps = { ...defaultDeps, ...overrides };
  const runId = nextRunId;
  nextRunId += 1;

  /**
   * One live flight per key, and the number of callers still waiting on it.
   *
   * The read cache owns single-flight; this owns CANCELLATION OWNERSHIP, which
   * the cache deliberately does not: it lets a departing caller stop waiting
   * without stopping the shared read, because another caller may still need the
   * answer. Counting the waiters is what turns that into "the last one out cuts
   * the read", which is the behaviour a spotlight teardown needs.
   */
  interface Flight {
    readonly controller: AbortController;
    /**
     * The single-flight key THIS flight is published under in the read cache.
     *
     * It carries a monotonic epoch, so an aborted flight can never be joined
     * through the cache either: `joinFlight` already refuses an aborted
     * controller, and the cache key now expresses the same refusal. Without
     * it the two single-flight owners disagreed - this map dropped the flight
     * at abort time while the cache kept its record until the aborted load
     * settled - and a caller arriving in that window joined a dying read and
     * inherited a `cancelled` it never asked for.
     */
    readonly cacheKey: string;
    waiters: number;
  }
  const inFlight = new Map<string, Flight>();
  let nextFlightEpoch = 1;

  function joinFlight(key: string): Flight {
    const existing = inFlight.get(key);
    if (existing !== undefined && !existing.controller.signal.aborted) {
      existing.waiters += 1;
      return existing;
    }
    const epoch = nextFlightEpoch;
    nextFlightEpoch += 1;
    const fresh: Flight = {
      controller: new AbortController(),
      cacheKey: `${key}#${String(epoch)}`,
      waiters: 1,
    };
    inFlight.set(key, fresh);
    return fresh;
  }

  const flights: BoardReadCache<BoardChartOutcome> = createBoardReadCache({
    capacity: CACHE_CAPACITY,
    maxConcurrent: MAX_CONCURRENT_READS,
    queueMax: QUEUE_MAX,
    now: deps.now,
    refusal: (reason) => ({ kind: "unavailable", reason }),
  });

  async function read(args: {
    readonly subject: BoardChartSubject;
    readonly resolution: BoardChartPillResolution;
    readonly signal: AbortSignal;
  }): Promise<BoardChartOutcome> {
    const countBack = BOARD_CHART_BAR_COUNTS[args.resolution];
    try {
      const pair = await deps.resolveSubject({
        chainId: args.subject.chain,
        pairAddress: args.subject.pairAddress,
        signal: args.signal,
      });
      const page = await deps.fetchBars({
        pair,
        resolution: args.resolution,
        countBack,
        signal: args.signal,
      });

      const drawable: DrawableBar[] = [];
      for (const bar of page.bars) {
        const projected = toDrawableBar(bar);
        if (projected !== null) drawable.push(projected);
      }
      const undrawableBars = page.bars.length - drawable.length;
      // The window keeps the NEWEST bars; what it cut is counted below.
      const windowed = drawable.slice(Math.max(0, drawable.length - countBack));
      const windowedOutBars = drawable.length - windowed.length;
      const bars = windowed.map((row) => row.candle);
      const volumes = windowed.map((row) => row.volumeUsd);
      const volumelessBars = volumes.filter((volume) => volume === null).length;

      const first = bars[0];
      const last = bars[bars.length - 1];
      if (first === undefined || last === undefined) {
        // A pool minutes old, or one whose bars carry no USD price, genuinely
        // has no chart. That is an absence, not a failure to apologise for.
        return { kind: "absent", reason: "no_drawable_bars" };
      }

      const series: BoardCandleSeries = {
        bars,
        // The newest bar is still FORMING when the window it opened has not
        // closed yet. The chart draws it differently, and a poll that did not
        // say so would let the reader treat a partial bar as a settled one.
        lastBarPartial: last.tMs + barStepMs(args.resolution) > page.fetchedAtMs,
        coveredRange: { fromMs: first.tMs, toMs: last.tMs },
        resolution: args.resolution,
        // BOTH bounds are reported. A dropped bar and a windowed bar are
        // different reasons for the same flag, and neither is silent: the
        // counts beside it say which happened.
        truncated: windowedOutBars > 0 || undrawableBars > 0,
      };
      return {
        kind: "series",
        series,
        requestedBars: countBack,
        providerBars: page.bars.length,
        undrawableBars,
        windowedOutBars,
        volumes,
        volumelessBars,
        fetchedAtMs: page.fetchedAtMs,
      };
    } catch (error) {
      if (args.signal.aborted) return { kind: "unavailable", reason: "cancelled" };
      return classifyFailure(error);
    }
  }

  /**
   * One attempt at a poll: join or start the flight for this pool and pill,
   * wait on it for as long as the caller stays, and cut it when the last
   * caller leaves.
   */
  async function attempt(args: {
    readonly subject: BoardChartSubject;
    readonly resolution: BoardChartPillResolution;
    readonly signal?: AbortSignal;
  }): Promise<BoardChartOutcome> {
    // Read through a function rather than a narrowed expression: the caller's
    // signal can fire DURING the await below, and a narrowing from the guard
    // here would make the compiler treat that later read as impossible.
    const callerGone = (): boolean => args.signal?.aborted ?? false;
    if (callerGone()) {
      return { kind: "unavailable", reason: "cancelled" };
    }
    // SINGLE-FLIGHT, NEVER A POSITIVE CACHE. `expiresAtMs: null` on every
    // load is what makes each poll a fresh read: two callers in one tick join
    // one exchange, and the answer is discarded the moment they have it.
    const key = `board-chart:${boardChartKey(args.subject)}:${args.resolution}:${runId}`;
    const flight = joinFlight(key);
    let left = false;
    const leave = (): void => {
      if (left) return;
      left = true;
      // THE READ IS CUT WHEN ITS LAST READER LEAVES, and not before. One
      // surface closing must not take the answer away from another that is
      // still waiting on the same flight, which is why this counts rather
      // than aborting on the first departure.
      flight.waiters -= 1;
      if (flight.waiters <= 0) {
        flight.controller.abort();
        if (inFlight.get(key) === flight) inFlight.delete(key);
      }
    };
    args.signal?.addEventListener("abort", leave, { once: true });
    try {
      const outcome = await flights.read(
        flight.cacheKey,
        async (cacheSignal) => {
          // The cache's own signal is how DISPOSE reaches this read. Chained
          // into the flight controller so teardown cuts the provider call
          // rather than merely stopping the wait for it.
          if (cacheSignal.aborted) flight.controller.abort();
          else {
            cacheSignal.addEventListener(
              "abort",
              () => {
                flight.controller.abort();
              },
              { once: true },
            );
          }
          return {
            value: await read({
              subject: args.subject,
              resolution: args.resolution,
              signal: flight.controller.signal,
            }),
            expiresAtMs: null,
          };
        },
        args.signal,
      );
      // THE CALLER'S OWN CANCELLATION IS NAMED AS SUCH. The read cache
      // answers a departed caller with its generic refusal, and reporting a
      // reader who left the spotlight as a service that is not mounted would
      // be describing a failure that did not happen.
      return callerGone()
        ? { kind: "unavailable", reason: "cancelled" }
        : outcome;
    } finally {
      args.signal?.removeEventListener("abort", leave);
      leave();
    }
  }

  return {
    async poll(args): Promise<BoardChartOutcome> {
      let settled = await attempt(args);
      // A READ CANCELLED BY SOMEBODY ELSE IS NOT A RESULT ABOUT THE MARKET.
      // The epoch above makes joining a dying flight impossible, so this is
      // belt and braces for the one remaining way a live caller can be told
      // "cancelled": the flight it joined was cut from the cache's own side
      // (dispose) between admission and settlement. One fresh attempt, never
      // a loop, and never for a caller who has itself gone.
      if (
        settled.kind === "unavailable" &&
        settled.reason === "cancelled" &&
        !(args.signal?.aborted ?? false)
      ) {
        settled = await attempt(args);
      }
      if (settled.kind !== "series") {
        log.info(
          `[board-chart] ${args.resolution} produced ${settled.kind}` +
            `/${settled.reason}`,
        );
      }
      return settled;
    },

    async dispose(): Promise<void> {
      // Cut every live flight first, then let the cache close admission and
      // DRAIN. Aborting here rather than only inside the cache is what makes
      // the drain finite: the provider call is listening to the flight's
      // controller, not to the cache's.
      for (const flight of inFlight.values()) flight.controller.abort();
      inFlight.clear();
      await flights.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* The mounted instance                                                */
/* ------------------------------------------------------------------ */

let mounted: BoardChartService | null = null;

/** Mount the one production instance and return its AWAITED teardown. */
export function mountBoardChartService(
  overrides: Partial<BoardChartServiceDeps> = {},
): () => Promise<void> {
  const service = createBoardChartService(overrides);
  mounted = service;
  return async () => {
    if (mounted === service) mounted = null;
    await service.dispose();
  };
}

/** The mounted service, or null when the app never started one. */
export function getBoardChartService(): BoardChartService | null {
  return mounted;
}

/** Test-only: release the process slot between cases. */
export function __resetBoardChartServiceForTests(): void {
  mounted = null;
}
