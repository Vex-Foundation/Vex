import { describe, expect, it } from "vitest";
import type { ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import { isDeskFullCloseApproval, isLighterOrderApproval } from "../desk-approvals.js";

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
    expect(isLighterOrderApproval(approval("desk", "order.cancelAll"))).toBe(true);
    expect(isLighterOrderApproval(approval("agent", "order.cancelAll"))).toBe(false);
    expect(isLighterOrderApproval(approval("agent", "order.create"))).toBe(false);
    expect(isLighterOrderApproval(approval("desk", "account.get"))).toBe(false);
  });

  it.each([
    ["0.25", "0.2500", true],
    ["0.1875", "0.25", false],
    ["0.125", "0.25", false],
    ["0.0625", "0.25", false],
    ["0", "0", false],
    ["invalid", "0.25", false],
    ["0.25", "", false],
  ] as const)("allows full-close preference only for exact positive amounts %s / %s", (baseAmount, positionAmount, expected) => {
    const full = approval("desk", "position.close");
    const preview = { namespace: "lighter", toolName: "position.close", criticalArgs: { baseAmount, positionAmount } };
    expect(isDeskFullCloseApproval({ ...full, preview })).toBe(expected);
    expect(isDeskFullCloseApproval({ ...full, origin: "agent", preview })).toBe(false);
  });

  it("does not offer the full-close preference when the amount binding is missing", () => {
    expect(isDeskFullCloseApproval(approval("desk", "position.close"))).toBe(false);
  });
});
