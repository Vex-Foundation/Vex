import type { AbortableInvocation } from "../common.js";
import type {
  BoardMomentumInput,
  BoardMomentumResult,
  BoardOtherPoolsInput,
  BoardOtherPoolsResult,
  BoardSpotlightContextInput,
  BoardSpotlightContextResult,
  BoardTapePollInput,
  BoardTapePollResult,
  BoardTopTradersInput,
  BoardTopTradersResult,
} from "../../../schemas/board-spotlight.js";

/**
 * Board SPOTLIGHT - the per-pool reads the spotlight surface adds on top of
 * the card figures.
 *
 * The renderer names the pool it is already displaying and nothing else: there
 * is no host, deadline, cadence, sort key, lookback or limit on this bridge,
 * because every one of those is a main-process constant. What comes back is
 * measurement plus the provider's own caveats, never a verdict.
 *
 * EVERY METHOD IS A ONE-SHOT THAT THE SURFACE OWNS. Leaving the spotlight cuts
 * them; none of them keeps running behind a view the reader has left.
 *
 * EVERY METHOD IS THEREFORE ABORTABLE, because that sentence is only true if
 * the cut can reach main. `cancel` fires main's own `ctx.signal`, which is
 * where the provider read is actually stopped; without it, leaving the
 * spotlight would stop the renderer LISTENING while five reads ran on to their
 * deadlines for a surface nobody is watching. What the renderer gains is the
 * ability to say "I have stopped waiting" and nothing else: it still cannot
 * name a timeout, a budget, a cadence or a limit.
 */
export interface BoardSpotlightBridge {
  /**
   * The trader leaderboard, labelled for what it is: 30-day pair-local cash
   * flow, recomputed over that whole window rather than filtered by it, with
   * the ranking frozen at read time. It is not a claim that anybody is
   * accumulating.
   */
  readonly topTraders: (
    input: BoardTopTradersInput,
  ) => AbortableInvocation<BoardTopTradersResult>;
  /** The m5/h1/h6/h24 windows, read at view time and duration-normalized. */
  readonly momentum: (
    input: BoardMomentumInput,
  ) => AbortableInvocation<BoardMomentumResult>;
  /**
   * The token's other pools, from a CAPPED relevance window with the current
   * pair excluded before ranking. The copy says "seen", not "all".
   */
  readonly otherPools: (
    input: BoardOtherPoolsInput,
  ) => AbortableInvocation<BoardOtherPoolsResult>;
  /**
   * Promotion and narrative context. `boostsActive` comes from the pair row,
   * never from the bounded global spotlight feed: a token measured carrying
   * ten active boosts was absent from that feed at the same moment.
   */
  readonly context: (
    input: BoardSpotlightContextInput,
  ) => AbortableInvocation<BoardSpotlightContextResult>;
  /**
   * One tape tick. Publication is atomic per tick and a batch that could not
   * reach its overlap block carries an explicit `gapBefore` marker, so a gap in
   * the tape is visible rather than silent.
   */
  readonly tapePoll: (
    input: BoardTapePollInput,
  ) => AbortableInvocation<BoardTapePollResult>;
}
