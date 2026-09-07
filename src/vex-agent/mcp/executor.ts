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
import { resolveInjectedProtocolTool, toInjectedToolName } from "../tools/registry/injected-protocol-tools.js";
import { validatePreparedActionFollowUp, type ValidatedPreparedActionFollowUp } from "../tools/registry/prepared-action-follow-ups.js";
import { durableApprovalCardMatches } from "../engine/core/approval-runtime/durable-approval-card.js";

export interface StudioExecution {
  readonly approvalCall?: StudioToolCall;
  readonly preparedApproval?: ValidatedPreparedActionFollowUp;
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
  let admission = await admitStudioCall(call, context);
  let approvalCall: StudioToolCall | undefined;
  const candidate = admission.result.preparedActionFollowUp;
  if (candidate !== undefined) {
    const source = resolveInjectedProtocolTool(call.name)?.toolId ?? call.name;
    const validated = admission.result.success ? validatePreparedActionFollowUp(source, candidate) : null;
    if (!validated?.ok || validated.followUp.toolName !== "execute_tool"
      || !validated.followUp.args.toolId.startsWith("lighter.")) {
      admission = { dispatched: admission.dispatched, result: { success: false, output: "This prepared action could not be handed to Studio approval. No approval card was created and nothing was executed." } };
    } else if (signal?.aborted) {
      admission = { dispatched: true, result: { success: false, output: "The request was canceled before approval. Nothing was executed." } };
    } else {
      // One validated hop, always unapproved, through the normal protocol gate.
      approvalCall = { name: toInjectedToolName(validated.followUp.args.toolId), args: validated.followUp.args.params, toolCallId: call.toolCallId };
      admission = await admitStudioCall(approvalCall, buildProjectToolContext(
        { ...scope, permission: "restricted" }, signal ? { abortSignal: signal } : {},
      ));
      if (admission.result.pendingApproval === true && (!admission.preparedApproval
        || admission.preparedApproval.expiresAt !== validated.followUp.expiresAt
        || !durableApprovalCardMatches(validated.followUp.approvalPreview, admission.preparedApproval.approvalPreview))) {
        admission = { dispatched: true, result: { success: false, output: "The prepared action changed before approval. No approval card was created. Prepare a fresh action." } };
      }
    }
  }
  // Measured only for a call a real lane handled. A synthetic refusal
  // (not exported, unknown name, `configuration_unavailable` pre-check,
  // rejected search arguments) never dispatched, so there is no duration to
  // report and `undefined` says so - see `StudioExecution.durationMs`.
  const durationMs = admission.dispatched ? Date.now() - startedAt : undefined;
  return {
    result: admission.result,
    ...(approvalCall === undefined ? {} : { approvalCall }),
    ...(admission.preparedApproval === undefined ? {} : { preparedApproval: admission.preparedApproval }),
    ...(durationMs === undefined ? {} : { durationMs }),
    toolCallId: call.toolCallId,
  };
}
