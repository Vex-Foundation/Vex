import type { AbortableInvocation } from "../common.js";
import type {
  BoardSparklineHydrateInput,
  BoardSparklineHydrateResult,
} from "../../../schemas/board-sparkline.js";

/**
 * Board SPARKLINE - the cold candle hydration behind the card price rows.
 *
 * ONE CALL FOR A WHOLE BOARD, deliberately. Main owns a progressive queue, a
 * board-wide deadline and a concurrency share negotiated with the agent, and
 * none of those can be owned by a renderer issuing eight independent
 * invocations that nothing can stop together. The renderer names pools and a
 * resolution from the board's own frozen vocabulary; the bar count, the queue
 * width, the timeouts and the transport are main's.
 *
 * A PARTIAL ANSWER IS AN OK ANSWER. Every requested pool comes back with its
 * own outcome and `deadlineHit` says whether the budget expired, so a card can
 * tell "this pool has no line" from "we never got to this pool".
 */
export interface BoardSparklineBridge {
  /**
   * ABORTABLE, because the pipeline's own contract says cancellation IS the
   * modal close: `cancel` fires main's `ctx.signal`, which aborts the reads in
   * flight and stops the queue admitting the pools behind them. It is
   * idempotent, and the promise still settles with whatever main decided.
   */
  readonly hydrate: (
    input: BoardSparklineHydrateInput,
  ) => AbortableInvocation<BoardSparklineHydrateResult>;
}
