/**
 * CARD SPARKLINE BARS - the second seam between the data lane and the grid.
 *
 * Same shape and same reason as `board-safety-surface.ts`: the grid needs one
 * thing (bars per pool, in pool order), the pipeline that produces them is a
 * bounded, progressive, cancellable candles fetch owned by the data lane
 * (A7), and naming the shape here let the card be written against a contract
 * instead of a fetch.
 *
 * ONE CALL FOR THE WHOLE BOARD, AND THE RENDERER OWNS NONE OF ITS BOUNDS.
 * `boardSparkline.hydrate` takes the board's pools and a resolution; main
 * owns the progressive queue of two, the per-pool timeout, the thirty second
 * board-wide deadline and the transport. Eight independent invocations could
 * not have been given a shared deadline, could not have been stopped
 * together, and would have taken a share of the bridge from the agent the
 * reader is actually talking to. There is deliberately no way to ask from
 * here for more work than a board's worth.
 *
 * A PARTIAL ANSWER IS AN ANSWER, and the three outcome families map onto the
 * card's designed states without collapsing:
 *
 *   series       bars, drawn.
 *   absent       settled: this pool genuinely has no drawable line right now
 *                (minutes old, or bars without a USD price). The card shows
 *                its dim baseline, which claims nothing.
 *   unavailable  nothing was learned. `deadline` in particular means the pool
 *                was never reached, so the card stays PENDING rather than
 *                claiming the absence of a line it was never asked about.
 *
 * SNAPSHOT FOR WAVE A, and that is the scheduler's contract rather than an
 * omission. `card-sparkline` is a one-shot channel in
 * `shared/board/live-channels.ts` (no cadence, and the live overlay carries
 * ROWS, never bars), so there is nothing publishing fresh bars for a card to
 * extend a line from. The renderer therefore does not poll and does not
 * invent a cadence of its own: a sparkline is the line as of the moment the
 * board was opened, which is exactly what the price row's own "24h" label
 * already describes. When the scheduler starts publishing bars, this hook
 * reads them; nothing else in this directory moves.
 *
 * CANCELLATION IS UNMOUNT, and it is real rather than a courtesy. The modal
 * host unmounts its slot children on every close path; TanStack cancels a
 * fetch whose last observer left, and because the query function consumes the
 * `AbortSignal`, that reaches `cancel()` on the bridge and fires main's own
 * `ctx.signal` - which is what stops the queue admitting the pools behind the
 * reads already in flight.
 *
 * ORDER AND LENGTH ARE THE CONTRACT. Index `i` is `spec.pools[i]` and the
 * array is always `pools.length` long. Entries are paired by KEY, so a
 * reordering can never draw one pool's line on another pool's card.
 */

import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { BoardSpecV1 } from "@vex-lib/board/index.js";
import type { Result } from "@shared/ipc/result.js";
import {
  type BoardSparklineHydrateResult,
  type BoardSparklineSubject,
} from "@shared/schemas/board-sparkline.js";
import { boardSparklineKeys } from "../../../lib/api/queryKeys.js";
import type { BoardSparklineData } from "./BoardSparkline.js";

export const BOARD_SPARKLINE_PENDING: BoardSparklineData = { status: "pending" };
const BOARD_SPARKLINE_UNAVAILABLE: BoardSparklineData = { status: "unavailable" };

/**
 * The resolution every card sparkline is drawn at.
 *
 * MEASURED, not chosen: probe P5 timed the whole board pipeline at 15m with a
 * 50 bar page and got 50 of 50 bars on every pool, width-2 total 11.50 s. Fifty
 * 15 minute bars is a twelve hour window, which is the span that makes a
 * card's 24h delta legible as a shape rather than a number. A different
 * resolution would be a different measurement, and none has been taken.
 */
export const BOARD_SPARKLINE_RESOLUTION = "15m" as const;

/**
 * How long a hydration may be trusted.
 *
 * A drawn line is a SNAPSHOT by contract (see the head note), so it is never
 * refetched on a timer: `Number.POSITIVE_INFINITY` and no cadence at all. A
 * board that reopens gets a fresh line because the modal remounts, which is
 * the moment the reader actually asked for one.
 */
export const BOARD_SPARKLINE_STALE_MS = Number.POSITIVE_INFINITY;

/**
 * Hydrate every pool of one board.
 *
 * Exported for the tests that drive the query in isolation; surfaces use
 * {@link useBoardSparklines}, which is the seam.
 */
export function useBoardSparklineHydration(
  pools: readonly BoardSparklineSubject[],
): UseQueryResult<Result<BoardSparklineHydrateResult>> {
  const keys = useMemo(
    () => pools.map((pool) => sparklinePoolKey(pool)),
    [pools],
  );
  return useQuery({
    queryKey: boardSparklineKeys.hydrate(keys, BOARD_SPARKLINE_RESOLUTION),
    queryFn: ({ signal }) => {
      const invocation = window.vex.boardSparkline.hydrate({
        pools: [...pools],
        resolution: BOARD_SPARKLINE_RESOLUTION,
      });
      // CONSUMING THE SIGNAL IS WHAT ARMS THE CANCEL. TanStack only cancels a
      // fetch whose function touched the signal; touching it here is what
      // turns "the reader closed the board" into main's own abort.
      signal.addEventListener("abort", invocation.cancel, { once: true });
      return invocation.promise;
    },
    enabled: pools.length > 0,
    staleTime: BOARD_SPARKLINE_STALE_MS,
    refetchInterval: false,
    // A provider failure arrives as a typed `unavailable` outcome the card
    // renders; a `Result` error is input or sender trouble, which a retry
    // cannot fix. Decoration never retries.
    retry: false,
  });
}

/** The identity both sides pair a pool on. Lowercased: providers vary case. */
export function sparklinePoolKey(subject: BoardSparklineSubject): string {
  return `${subject.chain}:${subject.pairAddress}`.toLowerCase();
}

/**
 * One pool's outcome as the card's four-state union.
 *
 * `deadline` is the one `unavailable` reason that stays PENDING: the pool was
 * never reached, so nothing is known about whether it has a line, and a dim
 * baseline would be the card claiming a settled absence it was not told about.
 */
export function boardSparklineDataFrom(
  outcome: BoardSparklineHydrateResult["entries"][number]["outcome"] | null,
): BoardSparklineData {
  if (outcome === null) return BOARD_SPARKLINE_PENDING;
  if (outcome.kind === "series") {
    return {
      status: "bars",
      bars: outcome.series.bars.map((bar) => ({ tMs: bar.tMs, c: bar.c })),
    };
  }
  if (outcome.kind === "unavailable" && outcome.reason === "deadline") {
    return BOARD_SPARKLINE_PENDING;
  }
  return BOARD_SPARKLINE_UNAVAILABLE;
}

/** One sparkline's data per pool of this board, in the spec's pool order. */
export function useBoardSparklines(
  spec: BoardSpecV1,
): readonly BoardSparklineData[] {
  const pools = useMemo(
    () =>
      spec.pools.map((pool) => ({
        chain: pool.chain,
        pairAddress: pool.pairAddress,
      })),
    [spec],
  );
  const query = useBoardSparklineHydration(pools);

  return useMemo(() => {
    const result = query.data;
    const byKey = new Map(
      result !== undefined && result.ok
        ? result.data.entries.map((entry) => [entry.key, entry] as const)
        : [],
    );
    return pools.map((pool) => {
      const entry = byKey.get(sparklinePoolKey(pool));
      // No entry at all: either nothing has landed yet, or the whole call
      // failed at the boundary. The first is pending; the second is a settled
      // "no bars will land for this board".
      if (entry === undefined) {
        return result === undefined || result.ok
          ? BOARD_SPARKLINE_PENDING
          : BOARD_SPARKLINE_UNAVAILABLE;
      }
      return boardSparklineDataFrom(entry.outcome);
    });
  }, [pools, query.data]);
}
