/**
 * Wake watch promoter — the PUSH half of `loop_defer`'s `watch` parameter.
 *
 * Subscribes to the pending-activity bus and, when a watched row terminalizes,
 * moves the matching pending wake's deadline to now so the wake executor picks
 * it up on its next 2 s tick instead of at the model's guessed `due_at`.
 *
 * ## Why here and not in the sync fast lane
 *
 * The fast lane's job is to DETECT terminalization; it already publishes that
 * fact on the bus (ids only, post-commit). Making it also know about wake rows
 * would put the autonomy loop's scheduling policy inside the sync executor. The
 * promoter lives with the wake system, subscribes to a leaf event module, and
 * owns exactly one decision: does this resolved row advance a pending wake.
 *
 * ## Lifecycle
 *
 * Started and stopped by `startWakeExecutor`, so the subscription exists for
 * exactly as long as something is able to act on a promoted row. Unsubscribing
 * is idempotent (the bus returns an idempotent unsubscribe).
 *
 * ## Failure policy
 *
 * The bus emits synchronously and isolates a throwing listener, but a promoter
 * that threw would still lose the promotion. Every failure is logged and
 * swallowed: losing a promotion costs the session its EARLY wake, never its
 * wake — the timer the defer was enqueued with is untouched. That asymmetry is
 * the whole safety argument for the feature.
 */

import logger from "@utils/logger.js";

import {
  pendingActivityBus,
  type PendingActivityEvent,
} from "../../events/pending-activity-bus.js";
import * as loopWakeRepo from "../../db/repos/loop-wake.js";
import { isWakeWatchTriggered, type WakeWatchSignal } from "./watch-registry.js";
import { BRIDGE_ORDER_STATUS_WATCH_TYPE, registerBuiltInWakeWatchEvaluators } from "./watch/index.js";

export interface WakeWatchPromoterHandle {
  stop(): void;
}

export interface WakeWatchPromoterDeps {
  readonly subscribe: (listener: (event: PendingActivityEvent) => void) => () => void;
  readonly getPendingWithWatch: typeof loopWakeRepo.getPendingWithWatch;
  readonly promotePendingWake: typeof loopWakeRepo.promotePendingWake;
}

function productionDeps(): WakeWatchPromoterDeps {
  return {
    subscribe: (listener) => pendingActivityBus.subscribe(listener),
    getPendingWithWatch: loopWakeRepo.getPendingWithWatch,
    promotePendingWake: loopWakeRepo.promotePendingWake,
  };
}

/**
 * Translate a resolved pending-activity event into the normalized signal the
 * evaluators compare against. Ids only, stringified — the same discipline the
 * bus itself applies, so no evaluator can start depending on a richer payload
 * than the bus is willing to carry.
 */
function toSignal(event: PendingActivityEvent): WakeWatchSignal {
  return {
    type: BRIDGE_ORDER_STATUS_WATCH_TYPE,
    values: {
      activityId: String(event.activityId),
      status: event.status ?? "",
    },
  };
}

export function startWakeWatchPromoter(
  deps: WakeWatchPromoterDeps = productionDeps(),
): WakeWatchPromoterHandle {
  registerBuiltInWakeWatchEvaluators();

  const unsubscribe = deps.subscribe((event) => {
    if (event.kind !== "resolved") return;
    void promoteForEvent(event, deps).catch((err) => {
      logger.warn("wake.watch.promote_failed", {
        activityId: event.activityId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  logger.info("wake.watch.promoter_started");
  return {
    stop(): void {
      unsubscribe();
      logger.info("wake.watch.promoter_stopped");
    },
  };
}

async function promoteForEvent(
  event: PendingActivityEvent,
  deps: WakeWatchPromoterDeps,
): Promise<void> {
  const signal = toSignal(event);
  const pending = await deps.getPendingWithWatch();
  for (const wake of pending) {
    const watchId = wake.payload?.watchId;
    const conditions = wake.payload?.conditions;
    if (typeof watchId !== "string" || !Array.isArray(conditions)) continue;
    const matched = conditions.some(
      (condition) =>
        typeof condition === "object"
        && condition !== null
        && isWakeWatchTriggered(condition as Record<string, unknown>, signal),
    );
    if (!matched) continue;

    const promoted = await deps.promotePendingWake({
      sessionId: wake.sessionId,
      missionRunId: wake.missionRunId,
      watchId,
    });
    logger.info("wake.watch.promoted", {
      wakeId: wake.id,
      sessionId: wake.sessionId,
      activityId: event.activityId,
      status: event.status,
      promoted,
    });
  }
}
