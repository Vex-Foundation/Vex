import type { ProtocolExecutionContext } from "../../protocols/types.js";
import type { InternalToolContext } from "../types.js";

/** Preserve the host authority and operator signal across routed providers. */
export function tokenFindProtocolContext(
  context: InternalToolContext,
): ProtocolExecutionContext {
  return {
    sessionPermission: context.sessionPermission,
    approved: context.approved,
    sessionId: context.sessionId,
    walletResolution: context.walletResolution,
    walletPolicy: context.walletPolicy,
    ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
  };
}
