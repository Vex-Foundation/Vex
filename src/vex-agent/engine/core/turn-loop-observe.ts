/**
 * Puzzle-03 iteration-boundary observe for pending pause/stop
 * control requests. Extracted from `turn-loop.ts` for scaling —
 * the caller maps the discriminated outcome to a `controlStateBus`
 * emit + `stopReason` set + loop break.
 *
 * Contract preservation:
 *   - Dynamic import of `../runtime/lease-and-status.js` matches the
 *     original turn-loop site (`turn-loop.ts:269-271`). Keeps the
 *     module-load lazy so test mocks of lease-and-status install
 *     cleanly when the loop first iterates.
 *   - DB / observe error path logs `turn-loop.observe_control_failed`
 *     with identical key + payload shape and returns `observe_error`
 *     so the caller can treat it as "best-effort, continue iteration".
 *   - `correlationId` is `string | null` — matches
 *     `ControlRequest.correlationId` shape from
 *     `runtime-control-requests` repo.
 */

import logger from "@utils/logger.js";

export type ObserveControlOutcome =
  /** No request, or one that was cleared as stale (never applied to this run). */
  | { kind: "no_request" }
  | { kind: "paused_user_applied"; correlationId: string | null }
  | { kind: "stop_applied"; correlationId: string | null }
  | { kind: "observe_error" };

export async function observePendingControlRequest(args: {
  readonly sessionId: string;
  readonly missionRunId: string;
}): Promise<ObserveControlOutcome> {
  try {
    const { observeAndApplyControl } = await import(
      "../runtime/lease-and-status.js"
    );
    const outcome = await observeAndApplyControl({
      sessionId: args.sessionId,
      // Run-scoped: a request minted for an earlier run is cleared as stale
      // by the helper instead of stopping/pausing THIS run.
      missionRunId: args.missionRunId,
      kinds: ["pause_after_step", "stop_terminal"],
    });
    if (outcome.outcome === "stale_cleared") {
      logger.warn("turn-loop.stale_control_request_cleared", {
        sessionId: args.sessionId,
        missionRunId: args.missionRunId,
        requestKind: outcome.request.kind,
        requestMissionRunId: outcome.request.missionRunId,
      });
      return { kind: "no_request" };
    }
    if (outcome.outcome === "paused_user_applied") {
      return {
        kind: "paused_user_applied",
        correlationId: outcome.request.correlationId,
      };
    }
    if (outcome.outcome === "stop_applied") {
      return {
        kind: "stop_applied",
        correlationId: outcome.request.correlationId,
      };
    }
    return { kind: "no_request" };
  } catch (err) {
    // Best-effort observe — DB/observe failure must not break the
    // turn loop. Log + continue; the next iteration will retry.
    logger.warn("turn-loop.observe_control_failed", {
      sessionId: args.sessionId,
      missionRunId: args.missionRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: "observe_error" };
  }
}
