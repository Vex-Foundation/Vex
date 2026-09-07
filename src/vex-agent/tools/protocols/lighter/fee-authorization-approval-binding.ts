import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import type { LighterFeeAuthorizationIntentRow } from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";
import { buildLighterFeeAuthorizationDisclosure } from "./fee-authorization-disclosure.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function lighterFeeAuthorizationPreviewMatches(
  preview: Record<string, unknown>,
  intent: LighterFeeAuthorizationIntentRow,
): boolean {
  if (preview.namespace !== "lighter" || preview.toolName !== "fees.approve")
    return false;
  const actual = record(preview.criticalArgs);
  const expected = buildLighterFeeAuthorizationDisclosure(intent);
  return (
    actual !== null &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value)
  );
}

export async function assertLighterFeeAuthorizationApprovalBinding(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly intent: LighterFeeAuthorizationIntentRow;
}): Promise<void> {
  const approval = await approvalsRepo.getByIdForSession(
    input.approvalId,
    input.sessionId,
  );
  const args = record(approval?.toolCall.args ?? approval?.toolCall.arguments);
  const params = record(args?.params);
  const audit = await approvalIntentsRepo.getByApprovalId(input.approvalId);
  if (
    approval?.status !== "approved" ||
    (approval.toolCall.command ?? approval.toolCall.name) !== "execute_tool" ||
    args?.toolId !== "lighter.fees.approve" ||
    params?.intentId !== input.intent.intentId ||
    Object.keys(params).join(",") !== "intentId" ||
    audit?.sessionId !== input.sessionId ||
    audit.decision !== "approved" ||
    audit.actionKind !== "user_wallet_broadcast" ||
    audit.executionStatus !== "dispatching" ||
    !lighterFeeAuthorizationPreviewMatches(audit.previewJson, input.intent)
  ) {
    throw new Error(
      "The fee approval does not match the prepared authorization. Nothing was signed or submitted.",
    );
  }
}
