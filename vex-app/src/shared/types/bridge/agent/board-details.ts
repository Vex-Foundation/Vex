import type { Result } from "../../../ipc/result.js";
import type { AbortableInvocation } from "../common.js";
import type {
  BoardDetailsPrefetchInput,
  BoardDetailsPrefetchResult,
  BoardDetailsReadInput,
  BoardDetailsReadResult,
} from "../../../schemas/board-details.js";

/**
 * Board DETAILS - the contract-safety, holder and liquidity-lock read behind a
 * card's chip and the spotlight's bottom row.
 *
 * The renderer names a chain slug and a pool address. It cannot name a host, a
 * route, a field group, a timeout or a cache policy, and it never learns one:
 * main owns the whole read and hands back a typed bundle of EVIDENCE. The
 * verdict is not on this bridge either - it is the shared classifier's, run by
 * whichever surface is rendering, so the chip in the modal and the counters on
 * the chat card are the same function over the same bytes.
 *
 * ABSENCE IS A SUCCESS. Two of four probed chains returned no lock block and
 * one returned no security block at all for a live trending pool, so those are
 * named members of the outcome union rather than errors.
 */
export interface BoardDetailsBridge {
  /**
   * One pool. Cached and single-flighted in main, so eight cards naming the
   * same token in one tick cost one provider exchange.
   */
  readonly read: (
    input: BoardDetailsReadInput,
  ) => AbortableInvocation<BoardDetailsReadResult>;
  /**
   * Every pool of one board, for the chat card's counters.
   *
   * The card states "3 clean checks - 2 high risk" BEFORE anything opens the
   * modal, and a card that opened eight conversations of its own to say that
   * would spend eight round trips on one sentence. Pools that could not be
   * read still come back with a typed outcome, so the count covers the whole
   * board rather than quietly shrinking to the pools that answered.
   *
   * ABORTABLE. It is the one board method that can open eight provider
   * conversations at once, and the surface that asked for them is one the
   * reader can close immediately. `cancel` fires main's own `ctx.signal`,
   * which is where the reads are actually stopped; it is idempotent and the
   * promise still settles with whatever main decided.
   */
  readonly prefetch: (
    input: BoardDetailsPrefetchInput,
  ) => AbortableInvocation<BoardDetailsPrefetchResult>;
}
