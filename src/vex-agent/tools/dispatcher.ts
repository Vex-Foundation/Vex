/**
 * Tool dispatcher — routes tool calls to the correct handler.
 *
 * The engine calls dispatchTool() for every tool call from the LLM.
 * Dispatcher decides: internal tool → direct handler, or
 * discover/execute → protocol runtime.
 *
 * Internal tool handlers are lazy-imported so a dispatch for one handler
 * never forces the rest of the internal tool modules into memory. PR1
 * replaced a 25-case `switch` with a typed `INTERNAL_TOOL_LOADERS` map —
 * same lazy semantics, data-driven, and the completeness test structurally
 * catches orphaned entries.
 *
 * This module is the COMPATIBILITY FAÇADE: dispatchTool remains the
 * orchestrator here and re-exports the dispatcher's public surface. The
 * gates, mutating classification, internal-loader map, and route-selection
 * logic live in sibling modules under ./dispatcher/.
 */

import type { ToolCallRequest, ToolResult } from "./types.js";
import type { InternalToolContext } from "./internal/types.js";
import { getActionKind } from "./registry.js";
import { checkPressureDeny } from "./dispatcher/pressure-gate.js";
import { checkPlanAcceptanceDeny } from "./dispatcher/plan-acceptance-gate.js";
import { routeToolCall } from "./dispatcher/protocol-route.js";
import logger from "@utils/logger.js";

// Compatibility façade re-exports — preserve the dispatcher's public surface.
export { checkPressureDeny } from "./dispatcher/pressure-gate.js";
export { checkPlanAcceptanceDeny } from "./dispatcher/plan-acceptance-gate.js";
export { dispatchTargetIsMutating } from "./dispatcher/mutating-targets.js";
export { INTERNAL_TOOL_LOADERS } from "./dispatcher/internal-loaders.js";

/**
 * Stamp `result.actionKind` from the registry fallback when the handler did
 * not set it. Preserves a handler-set value (e.g. `executeProtocolTool` which
 * derives from the TARGET protocol manifest, not from the `execute_tool`
 * wrapper's own classification). Leaves `actionKind` undefined when the tool
 * name is not registered — the routing layer already returns an "unknown
 * tool" error in that case and policy consumers can treat absent `actionKind`
 * as the conservative "unknown" signal.
 *
 * Plan: agents_dm/plan-integration/05-approvals-wallet-policy.md §"Action taxonomy".
 */
function withActionKindFallback(result: ToolResult, toolName: string): ToolResult {
  if (result.actionKind !== undefined) return result;
  const kind = getActionKind(toolName);
  if (kind === undefined) return result;
  return { ...result, actionKind: kind };
}

/**
 * Dispatch a tool call to the appropriate handler.
 *
 * Returns a ToolResult that the engine feeds back to the LLM.
 * Never throws — errors are caught and returned as failed results.
 */
export async function dispatchTool(
  call: ToolCallRequest,
  context: InternalToolContext,
): Promise<ToolResult> {
  const startTime = Date.now();

  // Pressure-band hard-deny: at barrier/critical bands, mutating tools are
  // rejected with a synthetic error. The soft filter (LLM-visible tool catalog
  // projection) is the first layer; this is the runtime safety net for tools
  // the model emits anyway. The bypass flag is threaded through so this gate
  // and the catalog filter agree exactly — `!== true` keeps every context that
  // omits the field on today's barrier.
  if (context.contextUsageBand) {
    const denied = checkPressureDeny(
      call.name,
      context.contextUsageBand,
      context.preparationBypassesBarrier === true,
    );
    if (denied) {
      logger.info("tools.dispatch.pressure_denied", {
        tool: call.name,
        band: context.contextUsageBand,
      });
      return withActionKindFallback(denied, call.name);
    }
  }

  // Plan-mode acceptance gate: while plan-mode is on and the plan is unaccepted,
  // block side-effecting tools (live per-call read). Runs BEFORE routeToolCall
  // so a blocked tool never reaches the auto-retry-unsafe stamp / prequote gate.
  const planDenied = await checkPlanAcceptanceDeny(call, context);
  if (planDenied) {
    logger.info("tools.dispatch.plan_acceptance_denied", { tool: call.name });
    return withActionKindFallback(planDenied, call.name);
  }

  try {
    const result = await routeToolCall(call, context);
    const durationMs = Date.now() - startTime;

    logger.debug("tools.dispatch.completed", {
      tool: call.name,
      success: result.success,
      durationMs,
    });

    // `durationMs` is stamped only on the paths that actually executed —
    // the two early-deny gates above return without it (see ToolResult).
    return { ...withActionKindFallback(result, call.name), durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    logger.warn("tools.dispatch.failed", {
      tool: call.name,
      error: message,
      durationMs,
    });

    return {
      ...withActionKindFallback(
        { success: false, output: `Tool ${call.name} failed: ${message}` },
        call.name,
      ),
      durationMs,
    };
  }
}
