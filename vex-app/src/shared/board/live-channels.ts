/**
 * THE BOARD'S LIVE CHANNEL VOCABULARY - one list of what may be scheduled,
 * how often, and who yields.
 *
 * TYPED AGAINST THE PROVIDER'S OWN RESOLUTION VOCABULARY, not against a bare
 * string: a mistyped pill becomes a compile error rather than a chart that
 * silently polls at the fallback rate.
 *
 * WHY IT IS IN `shared/`. The scheduler that runs these channels is a
 * main-process owner and the surfaces that arm them are the renderer; `shared/`
 * is the only tree both may import. A0 froze this vocabulary in the renderer's
 * board contracts; the same names live here so main can hold them too, and the
 * renderer contract re-exports rather than declaring a second copy. Two
 * declarations of "which channels exist" would be two answers to "was this
 * result still wanted", which is the exact question the generation fence is
 * for.
 *
 * CADENCES ARE PRODUCT DECISIONS, NOT TUNING. Each constant below carries the
 * reason it is the number it is, because a cadence is a claim about how fast
 * the reader's figures go stale AND a claim on a provider we do not own.
 *
 * PRIORITY IS SCARCITY POLICY. The board runs at most
 * {@link BOARD_LIVE_MAX_IN_FLIGHT} exchanges at once, so when several channels
 * come due together one of them waits. The order is the order a reader would
 * choose: the cards they are looking at, then the chart they opened, then the
 * tape, then the traders panel. A lower number runs first.
 */

import type { BoardChartResolution } from "@vex-lib/board/index.js";

/**
 * Every channel the scheduler may run.
 *
 * Frozen with A0. A channel not on this list cannot be armed, which is what
 * keeps "the board is polling something" an enumerable fact.
 */
export const BOARD_LIVE_CHANNEL_IDS = [
  "cards-batch",
  "card-sparkline",
  "pair-details",
  "spotlight-candles",
  "spotlight-trades",
  "spotlight-traders",
  "spotlight-context",
] as const;
export type BoardLiveChannelId = (typeof BOARD_LIVE_CHANNEL_IDS)[number];

/**
 * Which surface owns a channel.
 *
 * There is deliberately no `"app"` member. Every channel belongs to a surface
 * the reader can leave, and leaving it cuts the channel; a channel owned by
 * nothing in particular is a poll nobody can stop.
 */
export type BoardLiveChannelOwner = "modal" | "spotlight";

/**
 * Board reads in flight at once, board-wide.
 *
 * Two, not more. The site bridge's exchange cap is four and it is SHARED with
 * the agent, so a board that saturated it would make the agent wait behind a
 * sparkline. Two leaves half the pipe to the tool the user is actually talking
 * to.
 */
export const BOARD_LIVE_MAX_IN_FLIGHT = 2;

/**
 * Card metrics for the open modal.
 *
 * Five seconds, and it is measured rather than chosen: 25 of 25 polls at this
 * cadence succeeded against the live channel, p50 700 ms, max 941 ms, with no
 * rate limiting (`board-v2-probes/live-poll.json`).
 */
export const CADENCE_CARDS_MS = 5_000;

/**
 * The spotlight tape.
 *
 * Five seconds, measured: a 12-tick head poll at this cadence never observed a
 * gap and returned 1 to 16 fresh rows per tick, with per-call latency 0.95 s to
 * 4.02 s and a median near 2 s (probe P2). Faster would spend requests on an
 * empty answer; slower would let a busy pool outrun the overlap window.
 */
export const CADENCE_TAPE_MS = 5_000;

/**
 * The spotlight traders panel.
 *
 * Thirty seconds. The panel is a 30-DAY cash-flow leaderboard recomputed over
 * that whole window (probe P3), so its figures cannot meaningfully move inside
 * five seconds and polling it faster would buy nothing but load.
 */
export const CADENCE_TRADERS_MS = 30_000;

/**
 * The contract-safety, holder and lock read.
 *
 * Sixty seconds, which is the provider's OWN `max-age` on this document,
 * measured as 60 on all four probed chains (probe P1). Asking faster than the
 * provider's cache turns over cannot return a different answer.
 */
export const CADENCE_DETAILS_MS = 60_000;

/**
 * The spotlight chart's poll cadence for one resolution pill.
 *
 * The rule is "roughly a third of a bar, floored at the card cadence": a
 * one-minute bar is worth re-reading every five seconds because it is visibly
 * forming, and an eight-hour bar is not worth re-reading faster than every
 * thirty seconds no matter how long the reader watches. Anything not on the
 * board's four pills falls to the slowest cadence, which is the conservative
 * direction: it under-polls rather than hammering a resolution nobody measured.
 */
export function chartCadenceMsFor(resolution: BoardChartResolution): number {
  if (resolution === "1m") return 5_000;
  if (resolution === "15m") return 15_000;
  return 30_000;
}

/**
 * The default priority of each channel under contention.
 *
 * Cards first because they are what the reader is looking at and what the
 * "LIVE" dot claims about. Then the chart they deliberately opened, then the
 * tape, then the traders panel, whose figures move slowest of the four.
 * One-shots (`card-sparkline`, `pair-details`, `spotlight-context`) sit between
 * the chart and the tape: they finish and stop, so making them wait behind a
 * repeating poll would leave a card blank for the whole of that poll's cadence.
 */
export const BOARD_LIVE_CHANNEL_PRIORITY: Readonly<
  Record<BoardLiveChannelId, number>
> = {
  "cards-batch": 0,
  "spotlight-candles": 1,
  "card-sparkline": 2,
  "pair-details": 2,
  "spotlight-context": 2,
  "spotlight-trades": 3,
  "spotlight-traders": 4,
};

/** Which surface each channel belongs to, and therefore what cuts it. */
export const BOARD_LIVE_CHANNEL_OWNER: Readonly<
  Record<BoardLiveChannelId, BoardLiveChannelOwner>
> = {
  "cards-batch": "modal",
  "card-sparkline": "modal",
  "pair-details": "modal",
  "spotlight-candles": "spotlight",
  "spotlight-trades": "spotlight",
  "spotlight-traders": "spotlight",
  "spotlight-context": "spotlight",
};
