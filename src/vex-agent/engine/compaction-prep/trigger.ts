/**
 * Runtime-automatic preparation trigger — the boundary action that forks a
 * preparation once context pressure reaches the warning band (wave C3).
 *
 * Deliberately thin. Every decision that needs the truth lives in
 * `capturePreparation`, under the session row lock: whether a live preparation
 * already exists, whether it moved materially, whether branch A already
 * exhausted its attempts on this generation. This module contributes exactly
 * one thing the DB cannot know — the band the turn is running at.
 *
 * There is NO cheap pre-read here. Gate 0 removed it: pressure state and tool
 * visibility share one per-turn read owned by the pressure resolver, and
 * capture's transactional read is the authority. A third read would add turn
 * latency on the 99 % of iterations with nothing to do and still not be
 * authoritative.
 *
 * `computeBand` is recomputed rather than taking the loop's band observer:
 * that observer is a stateful logging closure and firing it twice would
 * corrupt its upward-transition log. Classification is pure, so recomputing is
 * free and side-effect-free. The token count it classifies lags by one turn —
 * that is the band system's documented behaviour and this module does not try
 * to fix it; the pre-inference byte ceiling owns the exact bound.
 */

import logger from "@utils/logger.js";
import { bandRank, computeBand } from "../core/context-band.js";
import type {
  IterationBoundaryAction,
  IterationBoundaryOutcome,
} from "../core/turn-loop-iteration-entry.js";
import { capturePreparation } from "./capture.js";

export interface PreparationTriggerArgs {
  readonly sessionId: string;
  readonly tokenCount: number;
  readonly contextLimit: number;
}

/**
 * The trigger never short-circuits the iteration: forking a preparation is
 * background work, and the turn it was measured on must still run. It returns
 * `continue` on every path, including failure.
 */
export function createPreparationTriggerAction(
  args: PreparationTriggerArgs,
): IterationBoundaryAction {
  return {
    name: "compaction_preparation_trigger",
    phase: "trigger",
    async run(): Promise<IterationBoundaryOutcome> {
      const band = computeBand(args.tokenCount, args.contextLimit);
      if (bandRank(band) < bandRank("warning")) {
        return { kind: "continue" };
      }

      try {
        await capturePreparation({
          sessionId: args.sessionId,
          source: "warning_band_auto",
        });
      } catch (error) {
        // The seam would swallow this too, but logging here keeps the band
        // that provoked the fork attached to the failure.
        logger.error("compaction.preparation.trigger_failed", {
          sessionId: args.sessionId,
          band,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { kind: "continue" };
    },
  };
}
