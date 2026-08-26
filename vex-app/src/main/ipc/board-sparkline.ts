/**
 * BOARD SPARKLINE IPC - `hydrate`.
 *
 * THE BOUNDARY THIS FILE DEFENDS. The renderer names pools and a resolution
 * from the board's own frozen vocabulary. It cannot name a host, a transport, a
 * bar count, a queue width, a per-pool timeout or a board-wide deadline; every
 * one of those is a constant in `main/market/board-sparkline-service.ts`, so
 * there is no knob on this channel for a caller to turn and no way for a
 * renderer to ask the provider for more than a board's worth of work.
 *
 * ONE CALL FOR A WHOLE BOARD, deliberately. The pipeline behind it owns a
 * progressive queue of two, a thirty second budget and a concurrency share
 * negotiated with the agent, and none of those can be owned by a renderer
 * issuing eight independent invocations that nothing can stop together.
 *
 * A PARTIAL ANSWER IS AN OK ANSWER. Every requested pool comes back with its
 * own typed outcome and `deadlineHit` says whether the budget expired, so a
 * caller can tell "this pool has no line" from "we never got to this pool" and
 * ask again for the second. A `Result` error therefore means only invalid
 * input, an untrusted sender, or a cancelled request.
 *
 * CANCELLATION IS THE MODAL CLOSE. `ctx.signal` fires when the renderer issues
 * `vex:cancel` for this request; it aborts every read in flight and stops the
 * queue admitting the pools behind them, so closing a board does not leave
 * eight reads running for a surface nobody is looking at.
 *
 * ADMISSION, NOT SCHEDULING. The batch passes through the board live
 * scheduler's `admit` under the `card-sparkline` channel, so it contends for
 * the SAME two board exchanges, in the SAME priority order, as every other
 * board read. It takes ONE turn for the whole board rather than one per pool:
 * it owns its own progressive queue and budget internally, and a per-pool
 * admission inside it would wait on the slot its own caller is holding. A
 * scheduler that is not mounted is answered `not_mounted`, exactly as a
 * missing service is.
 *
 * LOGGING records counts and the correlation id. Never a pool address (it
 * identifies a token a user is looking at), never a URL, never bars.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  boardSparklineHydrateInputSchema,
  boardSparklineHydrateResultSchema,
  type BoardSparklineHydrateResult,
} from "@shared/schemas/board-sparkline.js";
import { getBoardLiveScheduler } from "../market/board-live-scheduler.js";
import {
  getBoardSparklineService,
  sparklineKey,
} from "../market/board-sparkline-service.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

export function registerBoardSparklineHandlers(): ReadonlyArray<() => void> {
  return [
    registerHandler({
      channel: CH.boardSparkline.hydrate,
      domain: "market",
      inputSchema: boardSparklineHydrateInputSchema,
      outputSchema: boardSparklineHydrateResultSchema,
      handle: async (input, ctx): Promise<Result<BoardSparklineHydrateResult>> => {
        const service = getBoardSparklineService();
        if (service === null) {
          // EVERY POOL STILL GETS AN ENTRY. A card decides whether to draw a
          // line from its own entry, so a service that is not mounted produces
          // a board's worth of typed absence rather than an empty answer the
          // card would have to interpret.
          return ok({
            entries: input.pools.map((subject) => ({
              key: sparklineKey(subject),
              subject,
              outcome: { kind: "unavailable", reason: "not_mounted" } as const,
            })),
            deadlineHit: false,
          });
        }

        const scheduler = getBoardLiveScheduler();
        if (scheduler === null) {
          return ok({
            entries: input.pools.map((subject) => ({
              key: sparklineKey(subject),
              subject,
              outcome: { kind: "unavailable", reason: "not_mounted" } as const,
            })),
            deadlineHit: false,
          });
        }
        const admission = await scheduler.admit(
          { id: "card-sparkline", owner: "modal", signal: ctx.signal },
          // The RUN's signal, not the caller's: it fires on the caller's abort
          // AND on a surface cut.
          async (run) =>
            service.hydrate({
              pools: input.pools,
              resolution: input.resolution,
              signal: run.signal,
            }),
        );
        if (admission.kind === "refused") {
          // `busy` HAS NO MEMBER on this channel and must not be smuggled in as
          // `not_mounted`, which would say the service is missing when it is
          // running. `deadline` is the honest neighbour: it already means "the
          // board's own budget expired before this pool's turn, so the pool was
          // never asked and a retry is cheap", which is exactly what a full
          // admission queue means here.
          const reason = admission.reason === "busy" ? "deadline" : admission.reason;
          return ok({
            entries: input.pools.map((subject) => ({
              key: sparklineKey(subject),
              subject,
              outcome: { kind: "unavailable", reason } as const,
            })),
            deadlineHit: reason === "deadline",
          });
        }
        const result = admission.value;
        const drawn = result.entries.filter(
          (entry) => entry.outcome.kind === "series",
        ).length;
        if (drawn < result.entries.length) {
          log.info(
            `[ipc:vex:boardSparkline:hydrate] ${drawn} of ${result.entries.length} ` +
              `lines drawn deadlineHit=${String(result.deadlineHit)} ` +
              `correlationId=${ctx.requestId}`,
          );
        }
        // Re-shaped rather than forwarded: the service's entry type is a
        // main-side type and this one is the wire contract. They agree today,
        // and this is the seam that makes a future divergence a compile error
        // instead of an unnoticed schema violation.
        return ok({
          entries: result.entries.map((entry) => ({
            key: entry.key,
            subject: entry.subject,
            outcome: entry.outcome,
          })),
          deadlineHit: result.deadlineHit,
        });
      },
    }),
  ];
}
