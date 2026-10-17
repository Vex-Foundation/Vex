/**
 * Fixtures for the presence model's tests: one session row and one pending
 * approval, each with every required field and a plain override seam. Names
 * and amounts here are neutral test data.
 */

import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";

let sequence = 0;

/** A deterministic UUID-shaped id: the schemas require the shape, not randomness. */
export function testId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

export function session(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: testId(),
    mode: "mission",
    permission: "restricted",
    title: "Weekly rebalance",
    initialGoal: null,
    startedAt: "2026-10-17T10:00:00.000Z",
    endedAt: null,
    missionStatus: null,
    pinnedAt: null,
    ...overrides,
  };
}

export function approval(
  overrides: Partial<ApprovalPendingGlobalDto> = {},
): ApprovalPendingGlobalDto {
  return {
    id: `approval-${String(++sequence)}`,
    sessionId: testId(),
    toolCallId: null,
    toolName: "execute_tool",
    status: "pending",
    permissionAtEnqueue: "restricted",
    createdAt: "2026-10-17T12:00:00.000Z",
    resolvedAt: null,
    reasoningPreview: "",
    actionKind: "user_wallet_broadcast",
    riskLevel: "high",
    preview: null,
    expiresAt: null,
    decision: null,
    decisionReason: null,
    executionStatus: null,
    origin: "agent",
    projectId: null,
    requestedByClient: null,
    sessionTitle: "Treasury chat",
    projectName: null,
    ...overrides,
  };
}
