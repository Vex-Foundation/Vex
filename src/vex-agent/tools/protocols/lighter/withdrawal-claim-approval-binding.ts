import { formatEther, formatUnits } from "viem";

import { ErrorCodes, VexError } from "../../../../errors.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import type { LighterWithdrawalClaimAttemptRow } from "@vex-agent/db/repos/lighter-withdrawal-claims.js";

export const LIGHTER_WITHDRAWAL_CLAIM_CRITICAL_ARG_KEYS = [
  "toolId", "claimId", "withdrawalIntentId", "previewId", "matchHash", "operationClass",
  "settlementChainId", "settlementNetworkName", "walletAddress", "ownerAddress",
  "gatewayAddress", "gatewayImplementation", "gatewayCodeHash", "settlementTokenAddress",
  "settlementTokenCodeHash", "assetIndex", "assetSymbol", "assetDecimals", "amountUnits",
  "amountDisplay", "calldata", "valueWei", "gasLimit", "quotedMaxFeePerGasWei",
  "quotedPriorityFeePerGasWei", "networkFeeCeilingWei", "networkFeeCeilingDisplay",
  "preflightBlockNumber", "preflightObservedAt", "summary", "scopeNote",
] as const;

export async function assertLighterWithdrawalClaimApprovalBinding(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly attempt: LighterWithdrawalClaimAttemptRow;
}): Promise<void> {
  const approval = await approvalsRepo.getByIdForSession(input.approvalId, input.sessionId);
  if (approval === null || approval.status !== "approved" || !targets(approval.toolCall, input.attempt.claimId)) throw refusal();
  const audit = await approvalIntentsRepo.getByApprovalId(input.approvalId);
  if (
    audit === null || audit.sessionId !== input.sessionId || audit.decision !== "approved"
    || audit.actionKind !== "user_wallet_broadcast" || audit.executionStatus !== "dispatching"
    || !matches(audit.previewJson, input.attempt)
  ) throw refusal();
}

export function buildLighterWithdrawalClaimCriticalArgs(a: LighterWithdrawalClaimAttemptRow): Record<string, string | number> {
  return {
    toolId: "lighter.withdraw.claim", claimId: a.claimId, withdrawalIntentId: a.withdrawalIntentId,
    previewId: a.previewId, matchHash: a.matchHash, operationClass: a.operationClass,
    settlementChainId: a.settlementChainId, settlementNetworkName: a.settlementNetworkName,
    walletAddress: a.walletAddress, ownerAddress: a.ownerAddress, gatewayAddress: a.gatewayAddress,
    gatewayImplementation: a.gatewayImplementation, gatewayCodeHash: a.gatewayCodeHash,
    settlementTokenAddress: a.settlementTokenAddress, settlementTokenCodeHash: a.settlementTokenCodeHash,
    assetIndex: a.assetIndex, assetSymbol: a.assetSymbol, assetDecimals: a.assetDecimals, amountUnits: a.amountUnits,
    amountDisplay: `${formatUnits(BigInt(a.amountUnits), a.assetDecimals)} ${a.assetSymbol}`, calldata: a.calldata,
    valueWei: "0", gasLimit: a.gasLimit, quotedMaxFeePerGasWei: a.quotedMaxFeePerGasWei,
    quotedPriorityFeePerGasWei: a.quotedPriorityFeePerGasWei,
    networkFeeCeilingWei: a.networkFeeCeilingWei,
    networkFeeCeilingDisplay: `${formatEther(BigInt(a.networkFeeCeilingWei))} ETH`,
    preflightBlockNumber: a.preflightBlockNumber, preflightObservedAt: a.preflightObservedAt,
    summary: `Claim ${formatUnits(BigInt(a.amountUnits), a.assetDecimals)} ${a.assetSymbol} from the reviewed Lighter gateway on ${a.settlementNetworkName} to ${a.ownerAddress}.`,
    scopeNote: `This separate approval signs one zero-value ${a.settlementNetworkName} gateway claim. It spends ETH only for gas and cannot redirect the ${a.assetSymbol} recipient.`,
  };
}

function targets(toolCall: Record<string, unknown>, claimId: string): boolean {
  if ((toolCall.command ?? toolCall.name) !== "execute_tool") return false;
  const args = record(toolCall.args ?? toolCall.arguments);
  const params = record(args?.params);
  return args?.toolId === "lighter.withdraw.claim" && params !== null
    && Object.keys(params).join(",") === "claimId" && params.claimId === claimId;
}

function matches(preview: Record<string, unknown>, attempt: LighterWithdrawalClaimAttemptRow): boolean {
  if (preview.toolName !== "claim" || preview.namespace !== "lighter") return false;
  const args = record(preview.criticalArgs);
  if (args === null || Object.keys(args).sort().join(",") !== [...LIGHTER_WITHDRAWAL_CLAIM_CRITICAL_ARG_KEYS].sort().join(",")) return false;
  const expected = buildLighterWithdrawalClaimCriticalArgs(attempt);
  return Object.entries(expected).every(([key, value]) => args[key] === value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function refusal(): VexError {
  return new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST,
    "Approved Lighter manual claim refused because the trusted approval does not exactly match the durable claim attempt. Nothing was signed or submitted.",
    "Open the matching claim approval card or prepare a fresh claim after reconciliation.");
}

export const assertLighterCoreClaimApprovalBinding = assertLighterWithdrawalClaimApprovalBinding;
export const buildLighterCoreClaimCriticalArgs = buildLighterWithdrawalClaimCriticalArgs;
