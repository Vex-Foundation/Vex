/**
 * `InternalToolContext` -> `ProtocolExecutionContext`, the ONE mapper.
 *
 * Extracted MOVE-ONLY from `dispatcher/protocol-route.ts` (Vex Studio stage
 * A2). The in-app protocol lanes and the Studio MCP admission path must build
 * the SAME shape: a field added for one lane (the C0 provenance trio, the Stop
 * signal) can never be threaded through some lanes and silently dropped by
 * another. It lives under `protocols/` rather than under the dispatcher so the
 * MCP surface can reach it without importing the in-app dispatcher lane at all
 * (`src/__tests__/architecture/mcp-boundary.test.ts` pins that direction).
 *
 * `approvalSurface` is the ONLY addition to the pre-extraction body. It states
 * WHICH consent surface this dispatch can actually show a human, and the
 * approval gate normalizes an omitted value to `in_app_form` so every direct
 * `executeProtocolTool` caller in the tree keeps today's behaviour.
 */

import type { ToolCallRequest } from "../types.js";
import type { InternalToolContext } from "../internal/types.js";
import type { ApprovalSurface, ProtocolExecutionContext } from "./types.js";

/**
 * Build the protocol execution context for one call.
 *
 * `call` carries the provider's id for THIS tool call: `trench.launch_request_form`
 * parks the turn and its later result must address exactly this id (section C3b),
 * so the id travels with the context rather than being re-derived downstream.
 */
export function toProtocolExecutionContext(
  call: Pick<ToolCallRequest, "toolCallId">,
  context: InternalToolContext,
  approvalSurface: ApprovalSurface,
): ProtocolExecutionContext {
  return {
    sessionPermission: context.sessionPermission,
    approved: context.approved,
    sessionId: context.sessionId,
    contextUsageBand: context.contextUsageBand,
    preparationBypassesBarrier: context.preparationBypassesBarrier === true,
    walletResolution: context.walletResolution,
    walletPolicy: context.walletPolicy,
    // Trusted provenance (C0) - host-side evidence, never model input.
    missionId: context.missionId,
    missionRunId: context.missionRunId,
    approvalId: context.approvalId,
    // ...and WHICH QUOTE that approval bound. Threaded here, with the rest of
    // the provenance, so no lane can carry the approval id while dropping the
    // snapshot it authorized.
    approvedQuoteAuthority: context.approvedQuoteAuthority ?? null,
    // ...and WHICH PREQUOTE ROW, with the digest of what it disclosed. Same
    // lane, same reason: a context that carried the approval id while dropping
    // the row it approved would let the gate re-decide which quote is current.
    approvedPrequoteAuthority: context.approvedPrequoteAuthority ?? null,
    // The call this dispatch answers.
    toolCallId: call.toolCallId,
    // Which consent surface exists for this dispatch. See `runtime/gates.ts`.
    approvalSurface,
    // Operator Stop. EVERY protocol lane must carry it - passing it on only
    // some silently un-cancels part of the protocol surface.
    ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
  };
}
