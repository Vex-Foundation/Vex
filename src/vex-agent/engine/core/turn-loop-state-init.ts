/**
 * One-shot state init for the turn loop — runs once at function entry.
 * Extracted from `turn-loop.ts` for scaling.
 *
 * Two responsibilities:
 *   1. Arm the post-compact bridge counter from
 *      `sessions.checkpoint_generation`. The counter is in-memory only,
 *      so a wake-resume or app-restart that lost it would otherwise
 *      leave the agent resuming blind after every `waiting_for_wake`
 *      pause whose forced-compact-before-wait fired (codex P2 round 3).
 *   2. Build the per-loop band-transition observer closure. The pure
 *      observer factory tracks `previousBand` internally; the wrapper
 *      adds the structured `compact.band_observed` log when the
 *      observer says emit.
 *
 * Both pieces share `sessionId` + `contextLimit` so they ship together
 * even though they are logically distinct — keeps the loop-entry
 * helper count lower without bundling unrelated state.
 */

import { createBandObserver, pressureFraction, type ContextUsageBand } from "./context-band.js";
import * as sessionsRepo from "@vex-agent/db/repos/sessions.js";
import { POST_COMPACT_BRIDGE_CYCLES } from "@vex-agent/engine/core/context-pressure-policy.js";
import logger from "@utils/logger.js";

export type BandObserveSource =
  | "iteration_start"
  | "post_forced_fallback"
  | "post_turn_text";

export interface BandObserver {
  (tokenCount: number, source: BandObserveSource): ContextUsageBand;
}

export async function armPostCompactBridge(args: {
  readonly sessionId: string;
}): Promise<number> {
  try {
    const initialSession = await sessionsRepo.getSession(args.sessionId);
    if (initialSession && initialSession.checkpointGeneration > 0) {
      return POST_COMPACT_BRIDGE_CYCLES;
    }
    return 0;
  } catch (err) {
    logger.warn("turn-loop.bridge_arm_failed", {
      sessionId: args.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

export function createBandObserverWithLog(args: {
  readonly sessionId: string;
  /**
   * Fixed window, or a GETTER when the session's effective window can change
   * mid-run — which it can, because endpoint failover may switch to an endpoint
   * with a narrower window (owner decision 7). The observer keeps its transition
   * state across such a change, so the shrink surfaces as a real upward band
   * transition instead of a silent re-baseline.
   */
  readonly contextLimit: number | (() => number);
}): BandObserver {
  const resolveLimit =
    typeof args.contextLimit === "function" ? args.contextLimit : () => args.contextLimit as number;
  const observer = createBandObserver(resolveLimit);
  return (tokenCount: number, source: BandObserveSource): ContextUsageBand => {
    const obs = observer(tokenCount);
    if (obs.emit) {
      const contextLimit = resolveLimit();
      logger.info("compact.band_observed", {
        sessionId: args.sessionId,
        fromBand: obs.fromBand,
        toBand: obs.band,
        fraction: pressureFraction(tokenCount, contextLimit),
        tokenCount,
        contextLimit,
        source,
      });
    }
    return obs.band;
  };
}
