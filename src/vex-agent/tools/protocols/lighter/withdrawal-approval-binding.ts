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

export function buildLighterWithdrawalCriticalArgs(
  intent: LighterWithdrawalIntentRow,
): Record<string, string | number> {
  const observedAtMs = Date.parse(intent.preflightObservedAt);
  const amountDisplay = `${formatUnits(BigInt(intent.amountUnits), intent.assetDecimals)} ${intent.assetSymbol}`;
  return {
    toolId: "lighter.withdraw", intentId: intent.intentId, previewId: intent.previewId,
    matchHash: intent.matchHash, environment: intent.environment,
    operationClass: "secure_l2_withdrawal", accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex, walletAddress: intent.walletAddress,
    destinationAddress: intent.destinationAddress, signingChainId: intent.signingChainId,
    settlementChainId: intent.settlementChainId,
    settlementNetworkName: intent.settlementNetworkName, assetIndex: intent.assetIndex,
    assetSymbol: intent.assetSymbol, assetDecimals: intent.assetDecimals,
    settlementTokenAddress: intent.settlementTokenAddress, routeType: intent.routeType,
    route: "secure", amountUnits: intent.amountUnits, amountDisplay,
    minimumWithdrawalUnits: intent.minimumWithdrawalUnits,
    availableBalanceUnits: intent.availableBalanceUnits, collateralUnits: intent.collateralUnits,
    initialMarginUnits: intent.initialMarginUnits, pendingOrderCount: intent.pendingOrderCount,
    openPositionCount: intent.openPositionCount, activeOrderCount: intent.activeOrderCount,
    withdrawalDelaySeconds: intent.withdrawalDelaySeconds,
    estimatedClaimableAt: new Date(observedAtMs + intent.withdrawalDelaySeconds * 1_000).toISOString(),
    gatewayAddress: intent.gatewayAddress, gatewayImplementation: intent.gatewayImplementation,
    gatewayCodeHash: intent.gatewayCodeHash,
    settlementTokenCodeHash: intent.settlementTokenCodeHash,
    preflightObservedAt: intent.preflightObservedAt,
    summary: `Withdraw ${amountDisplay} from Lighter ${intent.environment.toUpperCase()} to ${intent.destinationAddress} on ${intent.settlementNetworkName} using the secure route.`,
    scopeNote: `This approval submits the L2 withdrawal only. Any later manual ${intent.settlementNetworkName} claim requires a separate wallet approval and network fee.`,
  };
}

export async function assertLighterCoreWithdrawalApprovalBinding(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly intent: LighterWithdrawalIntentRow;
}): Promise<void> {
  return assertLighterWithdrawalApprovalBinding(input);
}

export async function assertLighterWithdrawalApprovalBinding(input: {
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
  const expected = buildLighterWithdrawalCriticalArgs(intent);
  return LIGHTER_WITHDRAWAL_CRITICAL_ARG_KEYS.every((key) => args[key] === expected[key]);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function refusal(): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    "Approved Lighter withdrawal refused because the trusted approval record does not exactly match the durable environment-scoped withdrawal intent. Nothing was signed or submitted.",
    "Open the matching approval card or prepare a fresh exact withdrawal for the selected Lighter environment.",
  );
}
