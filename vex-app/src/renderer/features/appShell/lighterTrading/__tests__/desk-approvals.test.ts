import { describe, expect, it } from "vitest";
import type { ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import { isLighterOrderApproval } from "../desk-approvals.js";

function approval(origin: ApprovalSummaryDto["origin"], toolName: string): ApprovalSummaryDto {
  return {
    id: `${origin}-${toolName}`,
    sessionId: "00000000-0000-0000-0000-000000000001",
    toolCallId: null,
    toolName,
    status: "pending",
    permissionAtEnqueue: "restricted",
    createdAt: "2026-09-18T00:00:00.000Z",
    resolvedAt: null,
    reasoningPreview: "",
    actionKind: "user_wallet_broadcast",
    riskLevel: "high",
    preview: { namespace: "lighter", toolName, criticalArgs: {} },
    expiresAt: null,
    decision: null,
    decisionReason: null,
    executionStatus: null,
    origin,
    projectId: null,
    requestedByClient: null,
  };
}

describe("desk approval routing", () => {
  it("keeps agent proposals in chat and only routes direct desk actions to the modal", () => {
    expect(isLighterOrderApproval(approval("desk", "order.create"))).toBe(true);
    expect(isLighterOrderApproval(approval("agent", "order.create"))).toBe(false);
    expect(isLighterOrderApproval(approval("desk", "account.get"))).toBe(false);
  });
});
