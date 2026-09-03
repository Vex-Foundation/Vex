/**
 * `CompactApply` tool handler - a deliberately thin shell over `requestApply`.
 *
 * Everything that could go wrong in a cutover (the lease, the lock order, the
 * money gate, the two-phase FSM) lives behind `requestApply` and the runner's
 * boundary consumer. This handler's ONLY jobs are to name the caller
 * (`agent_tool`) and to translate the outcome into something the model can act
 * on truthfully.
 *
 * That second job is the one worth being careful about. Every outcome here is
 * reported as what it is:
 *
 *   - a queued request is NOT a completed compaction, and the copy must not
 *     imply the context is already smaller - the agent would then plan the next
 *     turn against a budget it does not have;
 *   - `queued_no_live_runner` is an honest, durable "it will happen later",
 *     never an error and never a success claim;
 *   - `not_ready` / `no_preparation` are refusals, not failures of the agent.
 *     They are `success: false` so the model does not read them as "done", with
 *     copy that tells it to simply carry on rather than retry in a loop.
 *
 * No `engineSignal` is returned on any path. `compact_committed` aborts the
 * rest of the tool batch, and nothing has been committed here - emitting it
 * would discard the agent's remaining calls for a cutover that has not
 * happened yet.
 */

import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { requestApply } from "@vex-agent/engine/compaction/apply/index.js";
import logger from "@utils/logger.js";

/**
 * The tool declares NO parameters, and nothing here reads one - the whole call
 * is `{ sessionId, source }` from the context. There used to be a
 * `z.object({}).passthrough()` guard with a rejection branch; passthrough
 * accepts every object, models only ever emit an object, and the branch's data
 * was never used, so it could not fail and could not inform anything. Deleted
 * rather than kept as decoration (dead-code decree).
 */
export async function handleCompactApply(
  _args: unknown,
  context: InternalToolContext,
): Promise<ToolResult> {
  const outcome = await requestApply({
    sessionId: context.sessionId,
    source: "agent_tool",
  });

  logger.info("compact.apply.tool_called", {
    sessionId: context.sessionId,
    band: context.contextUsageBand,
    outcome: outcome.kind,
  });

  switch (outcome.kind) {
    case "queued":
      return {
        success: true,
        output:
          "Compaction queued. The runtime will apply it at the next safe boundary - " +
          "possibly before your next turn, possibly a little later if a payment, approval " +
          "or on-chain action is still unresolved. Context is NOT smaller yet; keep working " +
          "and you will see the reduced pressure once it lands.",
        data: { queued: true, preparation_id: outcome.preparationId },
      };

    case "already_requested":
      return {
        success: true,
        output:
          "A compaction was already queued for this conversation - this call added nothing. " +
          "It will apply at the next safe boundary; no further action is needed from you.",
        data: { queued: true, already_requested: true, preparation_id: outcome.preparationId },
      };

    case "queued_no_live_runner":
      return {
        success: true,
        output:
          "Compaction queued and stored durably, but no runner is currently active for this " +
          "conversation, so nothing will consume it until the agent next runs. The request is " +
          "not lost.",
        data: {
          queued: true,
          no_live_runner: true,
          preparation_id: outcome.preparationId,
        },
      };

    case "not_ready":
      return {
        success: false,
        output:
          `No compaction is ready to apply right now (preparation state: ${outcome.status}). ` +
          "The runtime prepares one in the background and applies it automatically when needed. " +
          "Continue with your work - do not retry this call.",
        data: { applied: false, status: outcome.status },
      };

    case "no_preparation":
      return {
        success: false,
        output:
          "There is no prepared compaction for this conversation. The runtime forks one " +
          "automatically once context pressure reaches the warning band, and falls back to a " +
          "deterministic compaction if that fails. Continue with your work - do not retry this call.",
        data: { applied: false },
      };
  }
}
