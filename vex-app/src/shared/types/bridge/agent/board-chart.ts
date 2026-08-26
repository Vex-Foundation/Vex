import type { AbortableInvocation } from "../common.js";
import type {
  BoardChartPollInput,
  BoardChartPollResult,
} from "../../../schemas/board-chart.js";

/**
 * Board CHART - the spotlight chart's view-time candle feed.
 *
 * The renderer names the pool it is already displaying and one of four pill
 * resolutions (1H, 24H, 7D, 30D as `1m`, `15m`, `2h`, `8h`). There is no bar
 * count, deadline, cadence or transport on this bridge, because every one of
 * those is a main-process constant.
 *
 * ONE-SHOT, RENDERER-TIMED. There is no push and no main-side timer here: the
 * spotlight scope owns the clock and calls `poll` on the cadence main states in
 * `shared/board/live-channels.ts` (`chartCadenceMsFor`). Leaving the spotlight
 * stops the timer and cuts the request in flight, which is why the surface that
 * can be left is the surface that owns the thing that stops.
 *
 * ABORTABLE, and that is what makes the cut above real. Leaving the spotlight,
 * switching pill or closing the modal fires `cancel`, which fires main's own
 * `ctx.signal`; without it a cut would stop the renderer LISTENING while main
 * ran the provider read to its deadline for a surface nobody is watching. The
 * renderer still cannot name a timeout or a budget: `cancel` says only "I have
 * stopped waiting".
 *
 * EVERY POLL IS A FRESH READ. Nothing on this channel is served from a positive
 * cache: a forming bar is the whole reason the chart polls.
 */
export interface BoardChartBridge {
  /**
   * One chart tick for one pool at one pill.
   *
   * The answer echoes the resolution it was read at, so an answer belonging to
   * a pill the reader already left can be refused rather than drawn under the
   * new one. `absent` and `unavailable` are ordinary successes: every state of
   * this chart is a designed state of the same element.
   */
  readonly poll: (
    input: BoardChartPollInput,
  ) => AbortableInvocation<BoardChartPollResult>;
}
