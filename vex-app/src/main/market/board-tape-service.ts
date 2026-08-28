/**
 * BOARD TAPE SERVICE - the main-process owner of the spotlight's live trade
 * tape.
 *
 * THE PROBLEM THIS FILE EXISTS TO SOLVE. DexScreener's live push for
 * transactions acknowledges a subscription and then sends nothing (re-measured
 * on the site's own protocol), so a tape has to be POLLED. A polled tape has
 * exactly one interesting failure: between two ticks more trades happen than
 * one page can carry, and a naive poll silently loses the middle. Everything
 * below is the algorithm that either does not lose them or SAYS that it did.
 *
 * THE WATERMARK AND THE OVERLAP. The watermark is the highest block this
 * service has FULLY PUBLISHED. The head poll asks `afterBlock = watermark - 1`,
 * one block lower than it needs, deliberately: the endpoint's bound is
 * STRICTLY EXCLUSIVE (measured two-sided on a boundary block carrying three
 * events, see `TradeFilters.afterBlock`), so asking for `watermark` would
 * exclude the watermark block itself and a trade that landed in it after the
 * last tick would never be seen. Asking one lower re-reads the watermark block,
 * which costs a handful of duplicate rows and is what makes a late same-block
 * trade reachable. In 12 live ticks at 5 s every tick returned at least one
 * already-seen row and no gap was ever observed (probe P2).
 *
 * IDENTITY IS THE EXACT TRIPLE `blockNumber:transactionIndex:eventIndex`,
 * verbatim from the live row (probe P2). A row missing any of the three is
 * DROPPED and COUNTED rather than shown: an undedupable row would reappear on
 * every subsequent tick, and a drop nobody can see is the forbidden kind.
 *
 * THE CONTINUATION, AND ITS BOUNDARY. A FULL page means the provider had at
 * least that many rows in the window, so the page may not reach back to the
 * overlap block. The test is whether the page's OLDEST row is still ABOVE the
 * watermark:
 *
 *     oldest.blockNumber > watermark   ->  the page has not reached the
 *                                          overlap block; continue backward.
 *
 * The `>` is the whole point and it is not `>=`. The requested bound is
 * `watermark - 1` exclusive, so the OLDEST block the provider may return is
 * `watermark`. A page whose oldest row sits at exactly `watermark + 1` has
 * therefore NOT yet reached the overlap block and MUST continue, even though it
 * is adjacent to it. That case has its own fixture, because a `>=` here would
 * pass every ordinary test and silently drop one block's trades under load.
 *
 * The continuation walks BACKWARD on `pagination.nextCursor` (measured: page 1
 * covered blocks 441850042..441850169 and page 2 covered 441849963..441850038),
 * bounded by {@link TAPE_MAX_PAGES} and by the tick deadline. Reaching the
 * overlap block is SUCCESS. Not reaching it publishes anyway, atomically, with
 * an explicit `gapBefore` marker on the oldest row of the batch: an honest gap
 * the reader can see beats a tape that pretends to be continuous.
 *
 * PUBLICATION IS ATOMIC AND THE WATERMARK MOVES ONLY WITH IT. The whole batch
 * lands or nothing does, and an abort mid-continuation leaves the ring AND the
 * watermark exactly as they were, so the next tick re-asks the same window
 * instead of stepping over the trades it was in the middle of fetching.
 *
 * THE POLL RUNS IN ITS OWN COALESCENCE SCOPE. The site bridge joins identical
 * concurrent exchanges onto the FIRST caller's promise, so the leader's signal
 * and deadline own the socket. A tape poll that joined an agent tool's exchange
 * could not be aborted when the reader leaves the spotlight; an agent tool that
 * joined the tape's would be killed by a modal it knows nothing about. The
 * scope is per subject, which is the narrowest thing that is still stable
 * across the ticks of one visit.
 *
 * DEADLINES ARE MEASURED, NOT GUESSED. Per-call latency ran 0.95 s to 4.02 s,
 * median about 2 s (probe P2), so a tick deadline below roughly 4.5 s would cut
 * real answers off mid-flight and manufacture the gaps this file is built to
 * avoid.
 */

import {
  TRADES_PER_PAGE,
  fetchTradesPage,
  tradeCursorAt,
  type ProjectedTrade,
  type TradeCursor,
  type TradesPage,
} from "@tools/dexscreener/endpoints/trades.js";
import { DexScreenerSiteErrorCodes } from "@tools/dexscreener/site-errors.js";
import { getDexScreenerTransport } from "@tools/dexscreener/transport.js";
import type { PairSubject } from "@tools/dexscreener/endpoints/pair-subject.js";
import {
  BOARD_TAPE_RING_SIZE,
  boardSpotlightKey,
  type BoardSpotlightSubject,
  type BoardTapeOutcome,
  type BoardTapeRow,
} from "@shared/schemas/board-spotlight.js";
import { log } from "../logger/index.js";

/**
 * Pages one tick may spend, INCLUDING the head page.
 *
 * Three, from A12. It is a safety valve rather than the common path: no tick in
 * the live probe reached even one full page on a busy solana pool, so a tick
 * that needs three pages is a burst, and a tick that needs more than three is
 * better reported as a gap than chased at the cost of the deadline.
 */
export const TAPE_MAX_PAGES = 3;

/**
 * Wall-clock budget for one tick, across every page it fetches.
 *
 * 12 s: three pages at the measured worst case (4.02 s) with nothing to spare
 * would be 12.06 s, so this is the honest ceiling for the page budget above.
 * The per-page deadline below is what stops one slow page eating all of it.
 */
export const TAPE_TICK_DEADLINE_MS = 12_000;

/**
 * Deadline for ONE page.
 *
 * 6 s, comfortably above the measured 4.02 s worst case. A shorter deadline
 * does not make the tape faster, it makes it lose pages that were about to
 * arrive and then report a gap for them.
 */
export const TAPE_PAGE_TIMEOUT_MS = 6_000;

/** Rows the ring holds. Re-exported from the wire contract, never re-spelled. */
export const TAPE_RING_SIZE = BOARD_TAPE_RING_SIZE;

/** The exact provider triple that identifies one event. */
function identityOf(trade: ProjectedTrade): string | null {
  if (
    trade.blockNumber === null ||
    trade.transactionIndex === null ||
    trade.eventIndex === null
  ) {
    return null;
  }
  return `${trade.blockNumber}:${trade.transactionIndex}:${trade.eventIndex}`;
}

/** One projected trade as a tape row. */
function toRow(trade: ProjectedTrade, id: string, gapBefore: boolean): BoardTapeRow {
  return {
    id,
    side: trade.eventType,
    // Non-null by construction: `identityOf` refused the row otherwise.
    blockNumber: trade.blockNumber ?? 0,
    timestampMs: trade.blockTimestampMs,
    volumeUsd: trade.volumeUsd,
    amountBase: trade.amountBase,
    priceUsd: trade.priceUsd,
    maker: trade.maker,
    gapBefore,
  };
}

/** The per-subject state one visit accumulates. Nothing here is durable. */
interface TapeState {
  /** Newest first, exactly as the tape renders. */
  rows: BoardTapeRow[];
  /** Ids currently in the ring, for O(1) dedupe against what is on screen. */
  ids: Set<string>;
  /** Highest FULLY published block, or null before the first publication. */
  watermark: number | null;
}

export interface BoardTapeService {
  /**
   * Run one tick for one subject.
   *
   * `reset` forgets the ring and the watermark first, which is what entering a
   * spotlight does: showing the previous visit's trades as if they had just
   * arrived would be a lie about time.
   */
  poll(args: {
    readonly subject: BoardSpotlightSubject;
    readonly reset: boolean;
    readonly signal?: AbortSignal;
  }): Promise<BoardTapeOutcome>;
  /** Forget one subject's ring. Called when the spotlight leaves that token. */
  cut(subject: BoardSpotlightSubject): void;
  /** Idempotent. Closes admission, aborts in flight, drains, clears. */
  dispose(): Promise<void>;
}

export interface BoardTapeServiceDeps {
  /** Resolve the canonical subject. Cached by the spotlight service. */
  readonly resolveSubject: (args: {
    readonly subject: BoardSpotlightSubject;
    readonly signal: AbortSignal;
  }) => Promise<PairSubject>;
  /** Fetch ONE page. Throws a typed site error on any failure. */
  readonly fetchPage: (args: {
    readonly pair: PairSubject;
    readonly afterBlock: number | undefined;
    readonly cursor: TradeCursor | undefined;
    readonly signal: AbortSignal;
    readonly coalesceScope: string;
  }) => Promise<TradesPage>;
  readonly now: () => number;
  readonly maxPages: number;
  readonly tickDeadlineMs: number;
}

function siteCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** One failure as an outcome. Nothing here is retried automatically. */
function classifyFailure(error: unknown): BoardTapeOutcome {
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

const defaultDeps: Omit<BoardTapeServiceDeps, "resolveSubject"> = {
  fetchPage: async (args) =>
    fetchTradesPage({
      transport: getDexScreenerTransport(),
      chainId: args.pair.chainId,
      pairAddress: args.pair.pairAddress,
      ammId: args.pair.ammId,
      // VERBATIM from the resolver, never re-cased: a lower-cased spelling of
      // the CORRECT quote address answers 200 with the pair silently inverted,
      // which on a tape means every buy is drawn as a sell.
      quoteTokenAddress: args.pair.quoteTokenAddress,
      inverted: false,
      filters: {
        eventType: "all",
        ...(args.afterBlock === undefined ? {} : { afterBlock: args.afterBlock }),
      },
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      timeoutMs: TAPE_PAGE_TIMEOUT_MS,
      signal: args.signal,
      coalesceScope: args.coalesceScope,
    }),
  now: Date.now,
  maxPages: TAPE_MAX_PAGES,
  tickDeadlineMs: TAPE_TICK_DEADLINE_MS,
};

export function createBoardTapeService(
  deps: Pick<BoardTapeServiceDeps, "resolveSubject"> &
    Partial<BoardTapeServiceDeps>,
): BoardTapeService {
  const resolved: BoardTapeServiceDeps = { ...defaultDeps, ...deps };
  const states = new Map<string, TapeState>();
  const controllers = new Set<AbortController>();
  const inFlight = new Set<Promise<unknown>>();
  let closed = false;

  function stateFor(key: string): TapeState {
    const existing = states.get(key);
    if (existing !== undefined) return existing;
    const fresh: TapeState = { rows: [], ids: new Set(), watermark: null };
    states.set(key, fresh);
    return fresh;
  }

  /**
   * Collect the rows for one tick, walking backward while the page is full and
   * its oldest row has not reached the overlap block.
   *
   * Returns the batch NEWEST FIRST plus what happened. Nothing is published
   * from in here: the caller decides, once, after this returns.
   */
  async function collect(args: {
    readonly pair: PairSubject;
    readonly watermark: number | null;
    readonly signal: AbortSignal;
    readonly coalesceScope: string;
  }): Promise<{
    readonly trades: readonly ProjectedTrade[];
    readonly dropped: number;
    readonly pages: number;
    readonly reachedOverlap: boolean;
  }> {
    const startedAt = resolved.now();
    // THE OVERLAP ANCHOR. One block BELOW the watermark, because the bound is
    // strictly exclusive and the watermark block itself must be re-read.
    const afterBlock =
      args.watermark === null ? undefined : Math.max(0, args.watermark - 1);
    const collected: ProjectedTrade[] = [];
    let dropped = 0;
    let pages = 0;
    let cursor: TradeCursor | undefined;
    let reachedOverlap = args.watermark === null;

    while (pages < resolved.maxPages) {
      if (args.signal.aborted) break;
      const page = await resolved.fetchPage({
        pair: args.pair,
        afterBlock,
        cursor,
        signal: args.signal,
        coalesceScope: args.coalesceScope,
      });
      pages += 1;

      let oldestBlock: number | null = null;
      for (const trade of page.trades) {
        if (identityOf(trade) === null) {
          // Refused, and counted. An undedupable row would reappear on every
          // later tick; the count reaches the data notes so it is visible.
          dropped += 1;
          continue;
        }
        collected.push(trade);
        if (trade.blockNumber !== null) {
          oldestBlock =
            oldestBlock === null ? trade.blockNumber : Math.min(oldestBlock, trade.blockNumber);
        }
      }

      if (args.watermark === null) {
        // A first read has nothing to join to: one page is the seed.
        reachedOverlap = true;
        break;
      }
      // THE OVERLAP TEST. Strictly greater than: the oldest block the provider
      // may return under `afterBlock = watermark - 1` is `watermark` itself, so
      // an oldest row at exactly `watermark + 1` has NOT reached the overlap
      // block and must continue. A `>=` here passes every ordinary case and
      // loses one block's trades under load.
      if (oldestBlock !== null && oldestBlock <= args.watermark) {
        reachedOverlap = true;
        break;
      }
      // A SHORT page is the provider's own end of this window: there is
      // nothing further back to fetch, so the overlap is unreachable rather
      // than merely unreached, and continuing would spend pages on nothing.
      if (page.trades.length < TRADES_PER_PAGE) break;
      const next = page.nextCursor;
      if (next === null) break;
      if (resolved.now() - startedAt >= resolved.tickDeadlineMs) break;
      cursor = next;
    }

    return { trades: collected, dropped, pages, reachedOverlap };
  }

  async function runPoll(args: {
    readonly subject: BoardSpotlightSubject;
    readonly reset: boolean;
    readonly signal?: AbortSignal;
  }): Promise<BoardTapeOutcome> {
    const key = boardSpotlightKey(args.subject);
    if (args.reset) states.delete(key);
    const state = stateFor(key);

    const controller = new AbortController();
    controllers.add(controller);
    const onAbort = (): void => {
      controller.abort();
    };
    args.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (args.signal?.aborted === true) {
        return { kind: "unavailable", reason: "cancelled" };
      }
      const pair = await resolved.resolveSubject({
        subject: args.subject,
        signal: controller.signal,
      });
      const outcome = await collect({
        pair,
        watermark: state.watermark,
        signal: controller.signal,
        coalesceScope: `board-tape:${key}`,
      });

      // AN ABORT PUBLISHES NOTHING AND MOVES NOTHING. The ring and the
      // watermark stay exactly as they were, so the next visit re-asks the
      // same window rather than stepping over the trades this tick was in the
      // middle of fetching.
      if (controller.signal.aborted) {
        return { kind: "unavailable", reason: "cancelled" };
      }

      // --- The single publication point. Whole batch or nothing. -----------
      const fresh: { trade: ProjectedTrade; id: string }[] = [];
      for (const trade of outcome.trades) {
        const id = identityOf(trade);
        if (id === null) continue;
        if (state.ids.has(id)) continue;
        if (fresh.some((entry) => entry.id === id)) continue;
        fresh.push({ trade, id });
      }
      // Newest first, on the provider's own ordering key.
      fresh.sort((a, b) => {
        const byBlock = (b.trade.blockNumber ?? 0) - (a.trade.blockNumber ?? 0);
        if (byBlock !== 0) return byBlock;
        const byTx = (b.trade.transactionIndex ?? 0) - (a.trade.transactionIndex ?? 0);
        if (byTx !== 0) return byTx;
        return (b.trade.eventIndex ?? 0) - (a.trade.eventIndex ?? 0);
      });

      const gapBefore = !outcome.reachedOverlap && fresh.length > 0;
      const appended: BoardTapeRow[] = fresh.map((entry) =>
        toRow(entry.trade, entry.id, false),
      );

      const nextRows = [...appended, ...state.rows].slice(0, TAPE_RING_SIZE);
      // THE MARKER GOES ON THE OLDEST ROW OF THIS BATCH, AFTER THE RING CUT.
      //
      // Placing it before the cut was wrong and the fixture caught it: a batch
      // larger than the ring loses its own oldest row to the slice, and with it
      // the only visible sign that trades are missing. Clamping to the ring's
      // last row keeps the marker on screen and keeps it TRUE, because
      // everything below that row is either missing or evicted, and both mean
      // the tape is not continuous below this point. For an ordinary small
      // batch the index lands exactly on the seam between this tick's rows and
      // what was already held, which is where the gap actually is.
      if (gapBefore && nextRows.length > 0) {
        const markerIndex = Math.min(appended.length - 1, nextRows.length - 1);
        const marked = nextRows[markerIndex];
        if (marked !== undefined) {
          nextRows[markerIndex] = { ...marked, gapBefore: true };
        }
      }
      state.rows = nextRows;
      state.ids = new Set(nextRows.map((row) => row.id));

      // THE WATERMARK ADVANCES ONLY NOW, and only forward. A batch that
      // arrived entirely from below the watermark (all duplicates) leaves it
      // untouched rather than dragging it backward.
      const highest = appended.reduce<number | null>(
        (max, row) => (max === null ? row.blockNumber : Math.max(max, row.blockNumber)),
        null,
      );
      if (highest !== null) {
        state.watermark =
          state.watermark === null ? highest : Math.max(state.watermark, highest);
      }

      return {
        kind: "tape",
        rows: nextRows,
        watermark: state.watermark,
        appended: appended.length,
        droppedIncompleteIdentity: outcome.dropped,
        pagesFetched: outcome.pages,
        gapBefore,
        fetchedAtMs: resolved.now(),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return { kind: "unavailable", reason: "cancelled" };
      }
      const failure = classifyFailure(error);
      log.info(
        `[board-tape] tick produced no publication reason=${failure.kind === "unavailable" ? failure.reason : "none"}`,
      );
      return failure;
    } finally {
      args.signal?.removeEventListener("abort", onAbort);
      controllers.delete(controller);
    }
  }

  return {
    async poll(args): Promise<BoardTapeOutcome> {
      if (closed) return { kind: "unavailable", reason: "not_mounted" };
      const running = runPoll(args);
      inFlight.add(running);
      try {
        return await running;
      } finally {
        inFlight.delete(running);
      }
    },

    cut(subject): void {
      states.delete(boardSpotlightKey(subject));
    },

    async dispose(): Promise<void> {
      if (closed) return;
      // Admission first, then abort, then DRAIN: a poll must not outlive the
      // transport it borrows.
      closed = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...inFlight]);
      inFlight.clear();
      controllers.clear();
      states.clear();
    },
  };
}
