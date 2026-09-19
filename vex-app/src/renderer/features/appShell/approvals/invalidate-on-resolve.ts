/**
 * The queries a resolved approval invalidates, in one place: the approval
 * card that the user clicks Confirm on and the Lighter desk's auto-approved
 * close card both settle through here, so the AWAITING badge, the history
 * list, the transcript and the runtime state all refresh the same way.
 */

import type { QueryClient } from "@tanstack/react-query";
import { approvalsKeys, messagesKeys, runtimeKeys } from "../../../lib/api/queryKeys.js";

export async function invalidateOnApprovalResolve(queryClient: QueryClient, sessionId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: approvalsKeys.pending(sessionId) }),
    // App-wide inbox badge: any decision (from the inline card OR the global
    // panel) must refresh the DESK RULE count.
    queryClient.invalidateQueries({ queryKey: approvalsKeys.pendingAll() }),
    // history prefix (limit varies): match every history query for this session.
    queryClient.invalidateQueries({ queryKey: ["approvals", "history", sessionId] as const }),
    queryClient.invalidateQueries({ queryKey: messagesKeys.forSession(sessionId) }),
    queryClient.invalidateQueries({ queryKey: runtimeKeys.state(sessionId) }),
  ]);
}
