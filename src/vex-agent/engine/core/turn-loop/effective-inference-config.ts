/**
 * The session's EFFECTIVE inference config for one loop iteration.
 *
 * WHY THE LOOP CANNOT JUST USE THE CONFIG IT WAS HANDED. Endpoint failover can
 * move a session onto a different endpoint of the same model — mid-turn, on a
 * capacity failure — and sibling endpoints differ in BOTH price and context
 * window. Two concrete failures follow from banding against the config captured
 * before the loop started:
 *
 * 1. SAFETY. A session switched from a 256k endpoint to a 128k one keeps
 *    measuring pressure against 256k, so every band sits below the real ceiling,
 *    graceful compaction never fires, and the loop happily assembles a request
 *    the endpoint must reject on a hard `context_length_exceeded`.
 * 2. ACCOUNTING. The local price table stays on the old endpoint's rates, so a
 *    response without an authoritative `usage.cost` is billed wrong.
 *
 * Owner decision 7 makes both correctness requirements, so the loop resolves the
 * effective config at the top of EVERY iteration rather than once at entry.
 *
 * Cost: nothing on the common path. `resolveSessionInferenceConfig` returns the
 * same object until the session has actually switched, and the failover's
 * durable read-through is memoised per session per process.
 */

import type { InferenceConfig, InferenceProvider } from "@vex-agent/inference/types.js";
import {
  endpointFailoverDepsFrom,
  resolveSessionInferenceConfig,
} from "@vex-agent/inference/openrouter/endpoint-failover.js";

export interface EffectiveIterationConfig {
  /** Config for the request, the pre-inference ceiling and cost. */
  readonly config: InferenceConfig;
  /**
   * Window every band consumer measures against: the loop's OWN configured
   * limit, further clamped by the switched endpoint's window. Never raised — the
   * caller's limit stays an upper bound.
   */
  readonly contextLimit: number;
}

/**
 * Resolve the config this iteration must use for the request, the pre-inference
 * ceiling, banding and cost.
 *
 * `loopContextLimit` is passed separately and ON PURPOSE. `TurnLoopConfig`
 * carries its own `contextLimit`, and it is NOT merely a copy of
 * `config.contextLimit` — callers set it independently, so substituting the
 * config's value would silently change which limit the loop bands against. The
 * loop's value stays the authority and the endpoint can only narrow it.
 *
 * `provider` is the candidate source: a real `OpenRouterProvider` exposes its
 * own endpoint catalogue, and anything else degrades to routing-only resolution
 * (see `endpointFailoverDepsFrom`).
 */
export async function resolveEffectiveInferenceConfig(
  config: InferenceConfig,
  loopContextLimit: number,
  sessionId: string,
  provider: InferenceProvider,
): Promise<EffectiveIterationConfig> {
  const effective = await resolveSessionInferenceConfig(
    config,
    sessionId,
    endpointFailoverDepsFrom(provider),
  );
  // `min`, not "take the endpoint's": a switch may only ever TIGHTEN the loop's
  // ceiling. Unswitched, `effective === config` and this is exactly the loop's
  // own limit, so behaviour is unchanged.
  return {
    config: effective,
    contextLimit: Math.min(loopContextLimit, effective.contextLimit),
  };
}
