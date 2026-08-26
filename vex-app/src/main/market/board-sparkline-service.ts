/**
 * BOARD SPARKLINE SERVICE - the cold-start pipeline that draws a line on every
 * card of a board that just opened.
 *
 * THE PROBLEM, MEASURED RATHER THAN FEARED. A board carries up to eight pools
 * and each sparkline is its own provider read, so the naive shape is eight
 * sequential round trips while the reader looks at eight blank price rows. The
 * plan estimated that at roughly 160 seconds and called it inadmissible. Probe
 * P5 measured it instead, and the estimate was wrong by an order of magnitude:
 *
 *   8 pools, resolution 15m, limit 50, 50 of 50 bars returned every time
 *     strictly sequential x8 ....... 18.24 s
 *     progressive width 2 .......... 11.50 s   (a 37 percent reduction)
 *     per-call mean ................ 2.28 s    (range 0.94 s to 3.67 s)
 *
 * Those calls went through the SAME chain this service runs - resolve the pair
 * subject, then fetch one page of bars - so 2.28 s is the cost of a whole pool,
 * not of the bars alone. Quoting it against a bars-only pipeline would
 * understate the budget by a subject resolution per pool.
 *
 * WHAT THE MEASUREMENT BOUGHT:
 *  - WIDTH 2, not more. It is the measured 37 percent win, and it is also the
 *    board's whole exchange allowance: the bridge caps at four and shares them
 *    with the agent. Width 3 was never measured and is not adopted; adopting an
 *    unmeasured width here would take the pipe from the tool the user is
 *    talking to in order to speed up decoration.
 *  - A 30 SECOND GLOBAL DEADLINE, which is over twice the measured width-2
 *    total, so a slow provider day still completes and a hung one still ends.
 *    It is a BOARD-WIDE budget rather than a per-pool timeout because the
 *    reader's patience is with the board, not with its seventh card.
 *  - ONE SUBJECT BATCH. Every pool is resolved and read inside one call, under
 *    one deadline, with one cancellation, rather than eight independent
 *    conversations nobody can stop together.
 *
 * PARTIAL IS THE POINT OF THE QUEUE. Results are recorded AS THEY SETTLE, so a
 * deadline that expires after five pools returns five real series and three
 * typed `deadline` absences. Nothing waits for the slowest pool, and no pool's
 * answer is discarded because another pool was slow.
 *
 * CANCELLATION IS THE MODAL CLOSE. The handler's signal aborts every in-flight
 * read and stops the queue admitting more, so closing the modal does not leave
 * eight reads running for a board nobody is looking at.
 *
 * THE PROJECTION IS THE CANONICAL ONE. A bar without all four USD prices cannot
 * be drawn, so it is dropped and the drop is COUNTED into `truncated` rather
 * than left as a gap the reader would read as a flat candle. That is the same
 * rule `vex-agent/tools/internal/board/hydrate.ts` applies to a persisted
 * board's candles, so a card's sparkline and the same board's chart never
 * disagree about which bars exist.
 */

import {
  barStepMs,
  fetchBarsPage,
  type BarResolution,
  type ProjectedBar,
} from "@tools/dexscreener/endpoints/bars.js";
import { resolvePairSubject } from "@tools/dexscreener/endpoints/pair-subject.js";
import { DexScreenerSiteErrorCodes } from "@tools/dexscreener/site-errors.js";
import {
  getDexScreenerTransport,
  type DexScreenerTransport,
} from "@tools/dexscreener/transport.js";
import { decimalFromProvider } from "@vex-agent/tools/internal/board/hydrate-row.js";
import type { BoardCandle, BoardCandleSeries } from "@vex-lib/board/index.js";
import type {
  BoardSparklineEntry,
  BoardSparklineHydrateResult,
  BoardSparklineOutcome,
  BoardSparklineSubject,
} from "@shared/schemas/board-sparkline.js";
import { log } from "../logger/index.js";

/**
 * Bars in one sparkline.
 *
 * Fifty, which is the count probe P5 measured end to end and the count the
 * provider returned in full every time (50 of 50). It is one page by
 * construction: the provider caps a page at 999, so no walk is needed and a
 * walk would only add pages this line has no use for.
 */
export const SPARKLINE_BARS = 50;

/**
 * Pools read at once. TWO, and see the doc head: it is both the measured
 * optimum and the board's whole share of a transport the agent also uses.
 */
export const SPARKLINE_QUEUE_WIDTH = 2;

/**
 * Board-wide budget for one hydration, in milliseconds.
 *
 * Thirty seconds: over twice the 11.50 s that eight pools took at width 2 in
 * probe P5, so a provider having a slow day still finishes and a provider that
 * has stopped answering still ends.
 */
export const SPARKLINE_DEADLINE_MS = 30_000;

/**
 * Deadline for ONE pool's two reads.
 *
 * Eight seconds, against a measured per-call mean of 2.28 s and a measured
 * worst case of 3.67 s. Roughly twice the worst case observed, so an ordinary
 * slow answer still lands while one stuck pool cannot eat the board's budget.
 */
export const SPARKLINE_POOL_TIMEOUT_MS = 8_000;

export interface BoardSparklineServiceDeps {
  readonly transport: () => DexScreenerTransport;
  readonly now: () => number;
  readonly deadlineMs: number;
  readonly queueWidth: number;
  readonly barCount: number;
}

const defaultDeps: BoardSparklineServiceDeps = {
  transport: getDexScreenerTransport,
  now: Date.now,
  deadlineMs: SPARKLINE_DEADLINE_MS,
  queueWidth: SPARKLINE_QUEUE_WIDTH,
  barCount: SPARKLINE_BARS,
};

/** The identity two sides pair a pool on. Lowercased: providers vary case. */
export function sparklineKey(subject: BoardSparklineSubject): string {
  return `${subject.chain}:${subject.pairAddress}`.toLowerCase();
}

/** One provider bar as a board candle, or null when it cannot be drawn. */
function toCandle(bar: ProjectedBar): BoardCandle | null {
  const o = decimalFromProvider(bar.openUsd);
  const h = decimalFromProvider(bar.highUsd);
  const l = decimalFromProvider(bar.lowUsd);
  const c = decimalFromProvider(bar.closeUsd);
  if (o === null || h === null || l === null || c === null) return null;
  if (!Number.isSafeInteger(bar.timestampMs)) return null;
  return { tMs: bar.timestampMs, o, h, l, c };
}

function siteCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * One failure as an outcome.
 *
 * `unknown_pair` is the provider's settled answer that it does not know this
 * identity, and it is an ABSENCE: asking again would answer the same way.
 * Everything else says nothing about the pool and stays `unavailable`.
 */
function failureOutcome(error: unknown): BoardSparklineOutcome {
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

/**
 * Read ONE pool's sparkline.
 *
 * The AMM id and the pair's OWN quote token are resolved from the provider,
 * never assembled here: the bars route answers HTTP 200 with a SILENTLY
 * INVERTED series for a quote token that is wrong, absent, or merely
 * lower-cased, and the inverted answer is indistinguishable from a correct one
 * at the row level (measured at seventeen orders of magnitude).
 */
async function readOne(args: {
  readonly subject: BoardSparklineSubject;
  readonly resolution: BarResolution;
  readonly deps: BoardSparklineServiceDeps;
  readonly signal: AbortSignal;
}): Promise<BoardSparklineOutcome> {
  const transport = args.deps.transport();
  try {
    const pair = await resolvePairSubject({
      transport,
      chainId: args.subject.chain,
      pairAddress: args.subject.pairAddress,
      timeoutMs: SPARKLINE_POOL_TIMEOUT_MS,
      signal: args.signal,
    });
    const page = await fetchBarsPage({
      transport,
      chainId: pair.chainId,
      pairAddress: pair.pairAddress,
      ammId: pair.ammId,
      quoteTokenAddress: pair.quoteTokenAddress,
      resolution: args.resolution,
      series: "price",
      inverted: false,
      countBack: args.deps.barCount,
      timeoutMs: SPARKLINE_POOL_TIMEOUT_MS,
      signal: args.signal,
    });

    const drawable: BoardCandle[] = [];
    for (const bar of page.bars) {
      const candle = toCandle(bar);
      if (candle !== null) drawable.push(candle);
    }
    const undrawable = page.bars.length - drawable.length;
    const bars = drawable.slice(Math.max(0, drawable.length - args.deps.barCount));
    const overWindow = drawable.length - bars.length;

    const first = bars[0];
    const last = bars[bars.length - 1];
    if (first === undefined || last === undefined) {
      // A pool minutes old, or one whose bars carry no USD price, genuinely has
      // no line. That is an absence, not a failure the card should apologise
      // for.
      return { kind: "absent", reason: "no_drawable_bars" };
    }

    const series: BoardCandleSeries = {
      bars,
      lastBarPartial:
        last.tMs + barStepMs(args.resolution) > page.fetchedAtMs,
      coveredRange: { fromMs: first.tMs, toMs: last.tMs },
      resolution: args.resolution,
      // Both bounds are REPORTED. A dropped bar and a windowed bar are
      // different reasons for the same flag, and neither is silent.
      truncated: overWindow > 0 || undrawable > 0,
    };
    return { kind: "series", series };
  } catch (error) {
    return failureOutcome(error);
  }
}

export interface BoardSparklineService {
  /**
   * Hydrate every pool of one board.
   *
   * Resolves when every pool has an outcome or the board-wide deadline
   * expires, whichever comes first. Never throws for a provider problem: a
   * pool that could not be read carries its own typed outcome.
   */
  hydrate(args: {
    readonly pools: readonly BoardSparklineSubject[];
    readonly resolution: BarResolution;
    readonly signal?: AbortSignal;
  }): Promise<BoardSparklineHydrateResult>;
}

export function createBoardSparklineService(
  overrides: Partial<BoardSparklineServiceDeps> = {},
): BoardSparklineService {
  const deps: BoardSparklineServiceDeps = { ...defaultDeps, ...overrides };

  return {
    async hydrate(args): Promise<BoardSparklineHydrateResult> {
      const startedAtMs = deps.now();
      // Every pool starts as "not reached", so a pool the queue never got to is
      // already an honest answer rather than a hole somebody has to notice.
      const outcomes = new Map<number, BoardSparklineOutcome>();
      for (let index = 0; index < args.pools.length; index += 1) {
        outcomes.set(index, { kind: "unavailable", reason: "deadline" });
      }

      // ONE controller for the whole batch, chained to the caller's signal, so
      // a modal close aborts every read in flight AND stops the queue admitting
      // the pools behind them.
      const controller = new AbortController();
      const onAbort = (): void => {
        controller.abort();
      };
      if (args.signal !== undefined) {
        if (args.signal.aborted) controller.abort();
        else args.signal.addEventListener("abort", onAbort, { once: true });
      }
      const deadlineTimer = setTimeout(() => {
        controller.abort();
      }, deps.deadlineMs);

      let deadlineHit = false;
      let nextIndex = 0;

      /** One worker of the progressive queue. Takes the next pool until none. */
      const worker = async (): Promise<void> => {
        for (;;) {
          if (controller.signal.aborted) return;
          if (deps.now() - startedAtMs >= deps.deadlineMs) {
            deadlineHit = true;
            return;
          }
          const index = nextIndex;
          nextIndex += 1;
          const subject = args.pools[index];
          if (subject === undefined) return;
          const outcome = await readOne({
            subject,
            resolution: args.resolution,
            deps,
            signal: controller.signal,
          });
          // RECORDED AS IT SETTLES. Nothing waits for the slowest pool, which
          // is the whole reason the queue exists rather than a Promise.all.
          outcomes.set(index, outcome);
        }
      };

      try {
        await Promise.all(
          Array.from({ length: Math.max(1, deps.queueWidth) }, () => worker()),
        );
      } finally {
        clearTimeout(deadlineTimer);
        args.signal?.removeEventListener("abort", onAbort);
      }

      const cancelledByCaller = args.signal?.aborted === true;
      if (controller.signal.aborted && !cancelledByCaller) deadlineHit = true;

      const entries: BoardSparklineEntry[] = args.pools.map(
        (subject, index): BoardSparklineEntry => {
          const recorded = outcomes.get(index) ?? {
            kind: "unavailable" as const,
            reason: "deadline" as const,
          };
          // A reader who closed the modal is told their own cancellation, never
          // a provider problem that did not happen.
          const outcome: BoardSparklineOutcome =
            cancelledByCaller &&
            recorded.kind === "unavailable" &&
            recorded.reason === "deadline"
              ? { kind: "unavailable", reason: "cancelled" }
              : recorded;
          return { key: sparklineKey(subject), subject, outcome };
        },
      );

      const drawn = entries.filter(
        (entry) => entry.outcome.kind === "series",
      ).length;
      log.info(
        `[board-sparkline] ${drawn}/${entries.length} lines in ` +
          `${deps.now() - startedAtMs} ms deadlineHit=${String(deadlineHit)}`,
      );
      return { entries, deadlineHit };
    },
  };
}

/* ------------------------------------------------------------------ */
/* The mounted instance                                                */
/* ------------------------------------------------------------------ */

let mounted: BoardSparklineService | null = null;

/** Mount the one production instance and return its idempotent teardown. */
export function mountBoardSparklineService(
  overrides: Partial<BoardSparklineServiceDeps> = {},
): () => void {
  const service = createBoardSparklineService(overrides);
  mounted = service;
  return () => {
    if (mounted === service) mounted = null;
  };
}

/** The mounted service, or null when the app never started one. */
export function getBoardSparklineService(): BoardSparklineService | null {
  return mounted;
}

/** Test-only: release the process slot between cases. */
export function __resetBoardSparklineServiceForTests(): void {
  mounted = null;
}
