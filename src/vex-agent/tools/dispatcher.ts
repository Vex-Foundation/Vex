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
import { resolveToolName } from "./registry/name-resolution.js";
import { checkPressureDeny } from "./dispatcher/pressure-gate.js";
import { checkPlanAcceptanceDeny } from "./dispatcher/plan-acceptance-gate.js";
import { routeToolCall } from "./dispatcher/protocol-route.js";
import { isAbortError } from "@utils/cancellation.js";
import {
  describeFailureForLog,
  renderProtocolFailureOutput,
  summarizeProtocolError,
} from "@utils/error-summary.js";
import { TOOL_ABORTED_BY_USER_STOP_OUTPUT } from "@vex-agent/engine/core/turn-loop-tool-batch/results.js";
import logger from "@utils/logger.js";

// Compatibility façade re-exports — preserve the dispatcher's public surface.
export { checkPressureDeny } from "./dispatcher/pressure-gate.js";
export { checkPlanAcceptanceDeny } from "./dispatcher/plan-acceptance-gate.js";
export { dispatchTargetIsMutating } from "./dispatcher/mutating-targets.js";
export { INTERNAL_TOOL_LOADERS } from "./dispatcher/internal-loaders.js";

/**
 * What the model is told when it calls `execute_tool` anyway. Names the real
 * cause and the ONE way forward (rule 04) — the model's next move must be
 * `discover_tools`, whose ranked rows come back as callable functions.
 */
const MODEL_EXECUTE_TOOL_REFUSAL =
  "execute_tool is not callable. Protocol tools are called DIRECTLY by their " +
  "own name: run discover_tools with a query describing what you need, and " +
  "every tool it returns is added to your tool list as a real function " +
  "(dotted id with `.` written as `__`, e.g. `kyberswap__swap__execute`) whose " +
  "arguments ARE its parameters — no toolId, no params wrapper.";

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
  request: ToolCallRequest,
  context: InternalToolContext,
): Promise<ToolResult> {
  const startTime = Date.now();

  // ── Deprecation-alias resolution, BEFORE every gate ──
  // A retired INTERNAL tool name is mapped to its canonical name here so the
  // `execute_tool` refusal, the pressure band, the plan-acceptance gate, the
  // mutating/auto-retry classification, routing and the `actionKind` fallback
  // all see ONE name, the identity, and can never disagree about which tool
  // this call is. This is also what makes a COLD APPROVAL RESUME safe across a
  // rename: `dispatch-approved.ts` re-enters here with the name stored in
  // `approval_queue.tool_call`, which may predate the rename.
  //
  // A retired PROTOCOL name is deliberately NOT rewritten here. Its identity is
  // the immutable dotted toolId, not a name, and it is resolved to its manifest
  // by the shared catalog resolver that every gate below already consults
  // (`registry/injected-protocol-tools.ts`). See `registry/name-resolution.ts`
  // for why the two identity spaces have separate lookups.
  //
  // The request object is passed through UNCHANGED when nothing resolves, so
  // under the Batch 1 empty table this line is byte-for-byte inert. Resolution
  // is single-hop and idempotent, so the boundaries downstream that resolve
  // again are consistent with this one.
  const resolvedName = resolveToolName(request.name);
  const call: ToolCallRequest =
    resolvedName === request.name ? request : { ...request, name: resolvedName };

  // `execute_tool` is closed to the MODEL. Discovered manifests are injected as
  // real functions the model calls by their own name, so the two-level envelope
  // is now an internal calling convention with exactly one live caller: the
  // cold approval resume, whose stored call is canonicalized to `execute_tool`
  // so it survives a process restart (`approval-runtime/tool-call-envelope.ts`).
  // That caller is host-built and never carries `modelOriginated`.
  //
  // THE PLACEMENT IS THE POINT: this refusal runs BEFORE the plan-acceptance
  // gate below and therefore before `routeToolCall`'s mission auto-retry-unsafe
  // stamp. A call the model may not make at all must not durably mark the run
  // auto-retry-unsafe or be recorded as a plan-gate denial on its way out.
  if (call.name === "execute_tool" && context.modelOriginated === true) {
    logger.info("tools.dispatch.execute_tool_model_originated_refused", {
      toolId: typeof call.args.toolId === "string" ? call.args.toolId : null,
    });
    return withActionKindFallback(
      { success: false, output: MODEL_EXECUTE_TOOL_REFUSAL },
      call.name,
    );
  }

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

    // Operator Stop, BEFORE the generic wrap. A cancelled call is not a failure
    // to be dressed as one, and "Tool X failed: The operation was aborted" is
    // exactly the generic-label output the truthful-tool-error decree exists to
    // kill. Both conditions are required: the error must be a caller
    // `AbortError` (a deadline breach is a `TimeoutError` and keeps saying
    // "timed out") AND this turn's signal must actually be aborted, so a
    // provider SDK's own internal abort is never mislabelled as an operator.
    if (isAbortError(err) && context.abortSignal?.aborted === true) {
      logger.info("tools.dispatch.aborted_by_user_stop", { tool: call.name, durationMs });
      return {
        ...withActionKindFallback(
          { success: false, output: TOOL_ABORTED_BY_USER_STOP_OUTPUT },
          call.name,
        ),
        durationMs,
      };
    }

    // DEFENCE IN DEPTH (Codex final review, non-blocking 4). This is the LAST
    // catch before a thrown value becomes agent-facing text, and it is the one
    // place that never knows which venue threw. Routing it through the canonical
    // summarizer rather than interpolating `err.message` raw means an SDK error
    // that embedded a URL, a request/response body or an auth header cannot
    // reach the model or the structured logs from here either — and the agent
    // gets the classified cause plus its remediation instead of a bare string.
    const summary = summarizeProtocolError(err);

    logger.warn("tools.dispatch.failed", {
      tool: call.name,
      category: summary.category,
      error: describeFailureForLog(err),
      durationMs,
    });

    return {
      ...withActionKindFallback(
        { success: false, output: renderProtocolFailureOutput(call.name, summary) },
        call.name,
      ),
      durationMs,
    };
  }
}
