import { formatUnits } from "viem";

import { ErrorCodes, VexError } from "../../../../errors.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import type { LighterWithdrawalIntentRow } from "@vex-agent/db/repos/lighter-withdrawal-intents.js";

export const LIGHTER_WITHDRAWAL_CRITICAL_ARG_KEYS = [
  "toolId", "intentId", "previewId", "matchHash", "environment", "operationClass",
  "accountIndex", "apiKeyIndex", "walletAddress", "destinationAddress", "signingChainId",
  "settlementChainId", "settlementNetworkName", "assetIndex", "assetSymbol", "assetDecimals",
  "settlementTokenAddress", "routeType", "route", "amountUnits", "amountDisplay",
  "minimumWithdrawalUnits", "availableBalanceUnits", "collateralUnits", "initialMarginUnits",
  "pendingOrderCount", "openPositionCount", "activeOrderCount", "withdrawalDelaySeconds",
  "estimatedClaimableAt", "gatewayAddress", "gatewayImplementation", "gatewayCodeHash",
  "settlementTokenCodeHash", "preflightObservedAt", "summary", "scopeNote",
] as const;

export async function assertLighterCoreWithdrawalApprovalBinding(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly intent: LighterWithdrawalIntentRow;
}): Promise<void> {
  const approval = await approvalsRepo.getByIdForSession(input.approvalId, input.sessionId);
  if (
    approval === null
    || approval.status !== "approved"
    || !targetsIntent(approval.toolCall, input.intent.intentId)
  ) throw refusal();
  const audit = await approvalIntentsRepo.getByApprovalId(input.approvalId);
  if (
    audit === null
    || audit.sessionId !== input.sessionId
    || audit.decision !== "approved"
    || audit.actionKind !== "external_post"
    || audit.executionStatus !== "dispatching"
    || !previewMatches(audit.previewJson, input.intent)
  ) throw refusal();
}

function targetsIntent(toolCall: Record<string, unknown>, intentId: string): boolean {
  if ((toolCall.command ?? toolCall.name) !== "execute_tool") return false;
  const args = record(toolCall.args ?? toolCall.arguments);
  const params = record(args?.params);
  return args?.toolId === "lighter.withdraw"
    && params !== null
    && Object.keys(params).join(",") === "intentId"
    && params.intentId === intentId;
}

function previewMatches(preview: Record<string, unknown>, intent: LighterWithdrawalIntentRow): boolean {
  if (preview.toolName !== "withdraw" || preview.namespace !== "lighter") return false;
  const args = record(preview.criticalArgs);
  if (
    args === null
    || Object.keys(args).sort().join(",") !== [...LIGHTER_WITHDRAWAL_CRITICAL_ARG_KEYS].sort().join(",")
  ) return false;
  const observedAtMs = Date.parse(intent.preflightObservedAt);
  return args.toolId === "lighter.withdraw"
    && args.intentId === intent.intentId
    && args.previewId === intent.previewId
    && args.matchHash === intent.matchHash
    && args.environment === "core"
    && args.operationClass === "secure_l2_withdrawal"
    && args.accountIndex === intent.accountIndex
    && args.apiKeyIndex === intent.apiKeyIndex
    && args.walletAddress === intent.walletAddress
    && args.destinationAddress === intent.destinationAddress
    && args.signingChainId === 304
    && args.settlementChainId === 1
    && args.settlementNetworkName === "Ethereum mainnet"
    && args.assetIndex === 3
    && args.assetSymbol === "USDC"
    && args.assetDecimals === 6
    && args.settlementTokenAddress === intent.settlementTokenAddress
    && args.routeType === 0
    && args.route === "secure"
    && args.amountUnits === intent.amountUnits
    && args.amountDisplay === `${formatUnits(BigInt(intent.amountUnits), 6)} USDC`
    && args.minimumWithdrawalUnits === intent.minimumWithdrawalUnits
    && args.availableBalanceUnits === intent.availableBalanceUnits
    && args.collateralUnits === intent.collateralUnits
    && args.initialMarginUnits === intent.initialMarginUnits
    && args.pendingOrderCount === intent.pendingOrderCount
    && args.openPositionCount === intent.openPositionCount
    && args.activeOrderCount === intent.activeOrderCount
    && args.withdrawalDelaySeconds === intent.withdrawalDelaySeconds
    && args.estimatedClaimableAt === new Date(observedAtMs + intent.withdrawalDelaySeconds * 1_000).toISOString()
    && args.gatewayAddress === intent.gatewayAddress
    && args.gatewayImplementation === intent.gatewayImplementation
    && args.gatewayCodeHash === intent.gatewayCodeHash
    && args.settlementTokenCodeHash === intent.settlementTokenCodeHash
    && args.preflightObservedAt === intent.preflightObservedAt
    && nonEmpty(args.summary)
    && nonEmpty(args.scopeNote);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function refusal(): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    "Approved Core withdrawal refused because the trusted approval record does not exactly match the durable withdrawal intent. Nothing was signed or submitted.",
    "Open the matching approval card or prepare a fresh Core USDC withdrawal.",
  );
}
