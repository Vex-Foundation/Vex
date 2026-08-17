import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";

import { ErrorCodes, VexError } from "../../../../errors.js";

const REFUSAL =
  "Approved Lighter deposit refused because the approval record does not match the prepared deposit intent. Nothing was signed or submitted.";

export const LIGHTER_DEPOSIT_CRITICAL_ARG_KEYS = [
  "toolId",
  "intentId",
  "environment",
  "walletAddress",
  "depositTo",
  "depositContract",
  "chainId",
  "assetIndex",
  "routeType",
  "amountUnits",
  "amountDisplay",
  "summary",
  "scopeNote",
] as const;

export async function assertLighterDepositApprovalBinding(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly intent: LighterOnboardingIntentRow;
}): Promise<void> {
  const approval = await approvalsRepo.getByIdForSession(input.approvalId, input.sessionId);
  if (
    approval === null
    || approval.status !== "approved"
    || !toolCallTargetsIntent(approval.toolCall, input.intent.intentId)
  ) {
    throw refusal();
  }

  const auditIntent = await approvalIntentsRepo.getByApprovalId(input.approvalId);
  if (
    auditIntent === null
    || auditIntent.sessionId !== input.sessionId
    || auditIntent.decision !== "approved"
    || auditIntent.actionKind !== "external_post"
    || auditIntent.executionStatus !== "dispatching"
    || !approvalPreviewMatchesIntent(auditIntent.previewJson, input.intent)
  ) {
    throw refusal();
  }
}

function toolCallTargetsIntent(toolCall: Record<string, unknown>, intentId: string): boolean {
  const command = toolCall.command ?? toolCall.name;
  if (command !== "execute_tool") return false;
  const args = readRecord(toolCall.args ?? toolCall.arguments);
  if (args === null || args.toolId !== "lighter.deposit") return false;
  const params = readRecord(args.params);
  if (params === null) return false;
  return Object.keys(params).join(",") === "intentId" && params.intentId === intentId;
}

function approvalPreviewMatchesIntent(
  previewJson: Record<string, unknown>,
  intent: LighterOnboardingIntentRow,
): boolean {
  if (previewJson.toolName !== "deposit" || previewJson.namespace !== "lighter") return false;
  const criticalArgs = readRecord(previewJson.criticalArgs);
  if (criticalArgs === null) return false;
  if (
    Object.keys(criticalArgs).sort().join(",")
    !== [...LIGHTER_DEPOSIT_CRITICAL_ARG_KEYS].sort().join(",")
  ) {
    return false;
  }
  return (
    criticalArgs.toolId === "lighter.deposit"
    && criticalArgs.intentId === intent.intentId
    && criticalArgs.environment === intent.environment
    && criticalArgs.walletAddress === intent.walletAddress
    && criticalArgs.depositTo === intent.depositTo
    && criticalArgs.depositContract === intent.depositContract
    && criticalArgs.chainId === intent.chainId
    && criticalArgs.assetIndex === intent.assetIndex
    && criticalArgs.routeType === intent.routeType
    && criticalArgs.amountUnits === intent.amountUnits
    && isNonEmptyString(criticalArgs.amountDisplay)
    && isNonEmptyString(criticalArgs.summary)
    && isNonEmptyString(criticalArgs.scopeNote)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function refusal(): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    REFUSAL,
    "Open the matching approval card for this prepared deposit, or prepare the deposit again.",
  );
}
