/**
 * `executeStudioTool` - the ONE entry point the Studio MCP surface calls.
 *
 * It composes the stage-A2 pieces and nothing else: validated project scope ->
 * least-privileged tool context -> admission -> the existing gates. There is no
 * transport projection here on purpose. `CallToolResult` is stage A4's job, and
 * stage A3's approval preview needs fields (`prequote`, `riskPreview`, the
 * whole pending result) that a transport projection would flatten away - so the
 * result is RETAINED WHOLE and the caller decides what to render.
 *
 * `pendingApproval: true` in stage A2 means exactly one thing: REFUSED because
 * approval is required, nothing was executed. There is no continuation yet; the
 * approval state machine lands in A3 and consumes this same raw result.
 */

import type { ToolResult } from "../tools/types.js";
import { admitStudioCall, type StudioToolCall } from "./admission.js";
import { buildProjectToolContext } from "./project-context.js";
import type { ProjectScope } from "./project-scope.js";

export interface StudioExecution {
  /** The tool result, WHOLE. Never projected, never cut. */
  readonly result: ToolResult;
  /**
   * Wall-clock milliseconds of the dispatch, when something actually ran.
   *
   * ABSENT (never `0`) for a synthetic refusal that never reached a handler -
   * a not-exported name, an unknown name, a `configuration_unavailable`
   * pre-check, a rejected `vex_ToolSearch` argument. Same semantics as
   * `ToolResult.durationMs`, which `dispatchTool` stamps for the internal lane;
   * a `0` would be rendered as "took 0 ms", which would be a lie.
   */
  readonly durationMs?: number;
  /** Echoed so a caller can correlate a result with the call it answers. */
  readonly toolCallId: string;
}

export async function executeStudioTool(
  scope: ProjectScope,
  call: StudioToolCall,
  signal?: AbortSignal,
): Promise<StudioExecution> {
  const context = buildProjectToolContext(scope, signal ? { abortSignal: signal } : {});
  const startedAt = Date.now();
  const admission = await admitStudioCall(call, context);
  // Measured only for a call a real lane handled. A synthetic refusal
  // (not exported, unknown name, `configuration_unavailable` pre-check,
  // rejected search arguments) never dispatched, so there is no duration to
  // report and `undefined` says so - see `StudioExecution.durationMs`.
  const durationMs = admission.dispatched ? Date.now() - startedAt : undefined;
  return {
    result: admission.result,
    ...(durationMs === undefined ? {} : { durationMs }),
    toolCallId: call.toolCallId,
  };
}
