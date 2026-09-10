import { createTransitionLog } from "../../utils/transition-log.js";
import logger from "../../utils/logger.js";
import { randomUUID } from "node:crypto";

export type SwapExecutionPhase = "token_metadata" | "token_safety" | "approved_quote"
  | "fee_policy" | "route_quote" | "execution_plan" | "execute";

/** One execution owns this bounded transition log. No payloads, addresses or keys enter it. */
export function createSwapExecutionTiming(toolId: "kyberswap.swap.execute" | "uniswap.swap.execute"): {
  run<T>(phase: SwapExecutionPhase, action: () => Promise<T>): Promise<T>;
} {
  const transitions = createTransitionLog({ maxEntries: 8 });
  const operationId = randomUUID();
  return {
    async run<T>(phase: SwapExecutionPhase, action: () => Promise<T>): Promise<T> {
      transitions.observe(phase, "running");
      const start = performance.now();
      let outcome = "failed";
      try {
        const result = await action();
        outcome = "completed";
        return result;
      } finally {
        const transition = transitions.observe(phase, outcome);
        if (transition) logger.info("swap.execution.phase", {
          toolId, operationId, phase, outcome, elapsedMs: Math.round(performance.now() - start),
          suppressedCount: transition.suppressedCount,
        });
      }
    },
  };
}
