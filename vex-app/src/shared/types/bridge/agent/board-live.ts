import type { Result } from "../../../ipc/result.js";
import type {
  BoardLiveCapability,
  BoardLiveEvent,
  BoardLiveSubscribeInput,
  BoardLiveSubscribeResult,
  BoardLiveUnsubscribeInput,
  BoardLiveUnsubscribeResult,
} from "../../../schemas/board-live.js";

/**
 * Board LIVE - a user-held lease that refreshes an open board's card metrics.
 *
 * The renderer names POOLS and nothing else. It cannot name a host, a channel,
 * a cadence, a ranking or a deadline, and it never learns one: main owns the
 * whole poll and hands back projected rows in the board's own shape.
 *
 * A lease is OWNED rather than observed. Exactly one window holds it, its
 * events reach only that window, and only that window can release it. Nothing
 * is persisted, and a board is never live on mount.
 */
export interface BoardLiveBridge {
  /**
   * Whether live figures are reachable in this build.
   *
   * Asked BEFORE the toggle renders so an unsupported build shows a disabled
   * control with an honest label rather than a control that fails on its first
   * click. Hiding it would be worse: the reader would never learn the
   * capability exists.
   */
  readonly capability: () => Promise<Result<BoardLiveCapability>>;
  /**
   * Claim the lease. The response CARRIES the first snapshot, so there is no
   * window between claiming the lease and hearing its first tick. A second
   * subscribe supersedes the first, which receives a terminal `closed` event
   * with reason `superseded`.
   */
  readonly subscribe: (
    input: BoardLiveSubscribeInput,
  ) => Promise<Result<BoardLiveSubscribeResult>>;
  /**
   * Release the lease. Safe to call twice and safe to call for a lease that has
   * already ended: `unknown` is an ordinary outcome, not a failure, because a
   * terminal event and an effect cleanup routinely race. A leaseId owned by a
   * different window is refused (`not-owner`) and left untouched.
   */
  readonly unsubscribe: (
    input: BoardLiveUnsubscribeInput,
  ) => Promise<Result<BoardLiveUnsubscribeResult>>;
  /**
   * Subscribe to this window's lease events. Returns an idempotent
   * unsubscribe - call it from the React effect cleanup. An off-contract
   * payload is dropped at the preload boundary before it reaches the callback.
   */
  readonly onLeaseEvent: (cb: (event: BoardLiveEvent) => void) => () => void;
}
