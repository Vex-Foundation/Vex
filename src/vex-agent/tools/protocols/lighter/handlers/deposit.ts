import { getAddress, type Hex } from "viem";

import * as onboardingIntentsRepo from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import {
  getLighterOnboardingWorkflow,
  type LighterOnboardingWorkflowRow,
} from "@vex-agent/db/repos/lighter-onboarding-workflows.js";
import {
  isLighterIntegrationEnabled,
  setLighterIntegrationEnabled,
} from "@vex-agent/db/repos/lighter-integration-settings.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import {
  resolveSelectedAddress,
  resolveSigningWallet,
  walletScopeErrorToResult,
} from "@vex-agent/tools/internal/wallet/resolve.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import {
  LIGHTER_DEPOSIT_MIN_USDC,
  LIGHTER_DEPOSIT_ROUTE_TYPE,
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
} from "@tools/lighter/wallet-funding/constants.js";
import { buildLighterDepositApprovalDisclosure } from "@tools/lighter/wallet-funding/deposit-approval-disclosure.js";
import {
  isLighterDepositFeePreflightComplete,
  readLighterDepositPreflight,
  type LighterDepositPreflightSnapshot,
} from "@tools/lighter/wallet-funding/deposit-preflight.js";
import { assertLighterDepositPreflightWithinApproval } from "@tools/lighter/wallet-funding/deposit-pre-sign.js";
import { decimalToBaseUnits } from "@tools/lighter/wallet-funding/onboarding-plan.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";
import { buildLighterDepositExecutionDeps } from "@tools/lighter/wallet-funding/deposit-execution-deps.js";
import {
  executeApprovedLighterDeposit,
  type LighterDepositExecutionResult,
} from "@tools/lighter/wallet-funding/deposit-execution.js";
import { acquireLighterDepositExecutionLease } from "@tools/lighter/wallet-funding/execution-lease.js";
import { assertLighterDepositApprovalBinding } from "../deposit-approval-binding.js";
import {
  withSessionControlLock,
  withSessionControlLocks,
} from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import {
  buildProductionLighterDepositRepairDeps,
  repairLighterDepositIntent,
  type LighterDepositRepairReport,
} from "@vex-agent/sync/lighter-deposit-repair.js";
import logger from "@utils/logger.js";
import type { ApprovalPreviewScalar, PreparedActionFollowUp } from "../../../types.js";
import type { ProtocolHandler } from "../../types.js";
import { fail, ok } from "../../handler-helpers.js";
import { readEnvironment } from "../params.js";

const INTENT_TTL_MS = 15 * 60 * 1000;

function buildDepositApprovalFollowUp(intent: LighterOnboardingIntentRow): PreparedActionFollowUp {
  const disclosure = buildLighterDepositApprovalDisclosure(intent);
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {
    toolId: "lighter.deposit",
    intentId: intent.intentId,
    environment: intent.environment,
    walletAddress: intent.walletAddress,
    depositTo: intent.depositTo ?? "",
    depositContract: intent.depositContract ?? "",
    chainId: intent.chainId,
    assetIndex: intent.assetIndex ?? -1,
    routeType: intent.routeType ?? -1,
    amountUnits: intent.amountUnits ?? "",
    amountDisplay: disclosure.amountDisplay,
    settlementTokenAddress: disclosure.settlementTokenAddress,
    settlementTokenDecimals: disclosure.settlementTokenDecimals,
    preflightMinimumTransferUnits: disclosure.minimumTransferUnits,
    preflightWalletBalanceUnits: disclosure.walletBalanceUnits,
    preflightWalletAllowanceUnits: disclosure.walletAllowanceUnits,
    preflightEthereumBlockNumber: disclosure.ethereumBlockNumber,
    preflightLighterBlockNumber: disclosure.lighterBlockNumber,
    preflightObservedAt: disclosure.preflightObservedAt,
    settlementNetworkName: intent.preflightPublicSnapshot?.settlementNetworkName ?? "",
    lighterRestBaseUrl: intent.preflightPublicSnapshot?.lighterRestBaseUrl ?? "",
    beneficiaryAddress: disclosure.beneficiaryAddress,
    gatewayImplementationAddress:
      intent.preflightPublicSnapshot?.gatewayImplementationAddress ?? null,
    gatewayCodeHash: intent.preflightPublicSnapshot?.gatewayCodeHash ?? "",
    settlementTokenImplementationAddress:
      intent.preflightPublicSnapshot?.settlementTokenImplementationAddress ?? null,
    settlementTokenCodeHash:
      intent.preflightPublicSnapshot?.settlementTokenCodeHash ?? "",
    depositCalldata: disclosure.depositCalldata,
    depositValueWei: disclosure.depositValueWei,
    approvalRequired: disclosure.approvalRequired,
    summary: disclosure.summary,
    scopeNote: disclosure.scopeNote,
  };
  return {
    toolName: "execute_tool",
    args: { toolId: "lighter.deposit", params: { intentId: intent.intentId } },
    expiresAt: intent.expiresAt.toISOString(),
    approvalPreview: { toolName: "deposit", namespace: "lighter", criticalArgs },
  };
}

function depositApprovalPreparedPayload(intent: LighterOnboardingIntentRow): Record<string, unknown> {
  const disclosure = buildLighterDepositApprovalDisclosure(intent);
  return {
    source: "vex_lighter_onboarding_deposit_intent",
    status: "approval_prepared",
    message: "Lighter deposit prepared; Vex will request approval for this exact deposit.",
    intentId: intent.intentId,
    environment: intent.environment,
    amountDisplay: disclosure.amountDisplay,
    walletBalanceDisplay: disclosure.walletBalanceDisplay,
    walletAllowanceDisplay: disclosure.walletAllowanceDisplay,
    nativeBalanceDisplay: disclosure.nativeBalanceDisplay,
    approvalRequired: disclosure.approvalRequired,
    preflightObservedAt: disclosure.preflightObservedAt,
    ethereumBlockNumber: disclosure.ethereumBlockNumber,
    lighterBlockNumber: disclosure.lighterBlockNumber,
    settlementTokenAddress: disclosure.settlementTokenAddress,
    creditAddress: disclosure.creditAddress,
    beneficiaryAddress: disclosure.beneficiaryAddress,
    approvalSpender: disclosure.approvalSpender,
    depositCalldata: disclosure.depositCalldata,
    depositValueWei: disclosure.depositValueWei,
    summary: disclosure.summary,
    scopeNote: disclosure.scopeNote,
    createsAccountNote: disclosure.createsAccountNote,
    approvalUi: {
      surface: "approval_card",
      approveLabel: "Approve and deposit",
      rejectLabel: "Reject",
    },
    userGuidance:
      "An approval card is now available in the app. Tell the user to review the deposit details and click Approve and deposit only if they are correct; do not ask them to type another approval command.",
  };
}

function canReissuePristineDepositApproval(input: {
  readonly intent: LighterOnboardingIntentRow;
  readonly sessionId: string;
  readonly fresh: LighterDepositPreflightSnapshot;
  readonly now?: Date;
}): boolean {
  const { intent, sessionId, fresh } = input;
  const now = input.now ?? new Date();
  if (
    intent.sessionId !== sessionId
    || intent.capability !== "deposit"
    || intent.approvalStatus !== "approval_pending"
    || intent.executionState !== "approval_pending"
    || intent.approvalId !== null
    || intent.protocolExecutionId !== null
    || intent.decisionReason !== null
    || intent.failureReason !== null
    || intent.expiresAt.getTime() <= now.getTime()
    || intent.approveTxHash !== null
    || intent.approveTxFrom !== null
    || intent.approveTxNonce !== null
    || intent.approveReplacementTxHash !== null
    || intent.approveReplacementReason !== null
    || intent.approveReplacementObservedAt !== null
    || intent.depositTxHash !== null
    || intent.depositTxFrom !== null
    || intent.depositTxNonce !== null
    || intent.depositReplacementTxHash !== null
    || intent.depositReplacementReason !== null
    || intent.depositReplacementObservedAt !== null
    || intent.depositL1BlockHash !== null
    || intent.depositL1BlockNumber !== null
    || intent.depositEventAccountIndex !== null
    || intent.lighterTxHash !== null
    || intent.lighterTxStatus !== null
    || intent.lighterBlockHeight !== null
    || intent.lighterExecutedAt !== null
    || intent.lighterEvidenceObservedAt !== null
    || intent.resolvedAccountIndex !== null
  ) {
    return false;
  }
  try {
    assertLighterDepositPreflightWithinApproval({
      intent,
      fresh,
      stage: "execution",
      now,
    });
    return true;
  } catch {
    return false;
  }
}

function isPristineApprovedDepositIntent(
  intent: LighterOnboardingIntentRow,
): boolean {
  return intent.capability === "deposit"
    && intent.approvalStatus === "approved"
    && intent.executionState === "approved"
    && intent.approveTxHash === null
    && intent.approveTxFrom === null
    && intent.approveTxNonce === null
    && intent.approveReplacementTxHash === null
    && intent.approveReplacementReason === null
    && intent.approveReplacementObservedAt === null
    && intent.depositTxHash === null
    && intent.depositTxFrom === null
    && intent.depositTxNonce === null
    && intent.depositReplacementTxHash === null
    && intent.depositReplacementReason === null
    && intent.depositReplacementObservedAt === null
    && intent.depositL1BlockHash === null
    && intent.depositL1BlockNumber === null
    && intent.depositEventAccountIndex === null
    && intent.lighterTxHash === null
    && intent.lighterTxStatus === null
    && intent.lighterBlockHeight === null
    && intent.lighterExecutedAt === null
    && intent.lighterEvidenceObservedAt === null
    && intent.resolvedAccountIndex === null
    && intent.failureReason === null;
}

function canRenewPristineApprovedDepositApproval(input: {
  readonly intent: LighterOnboardingIntentRow;
  readonly sessionId: string;
  readonly fresh: LighterDepositPreflightSnapshot;
}): boolean {
  const { intent, sessionId, fresh } = input;
  if (intent.sessionId !== sessionId || !isPristineApprovedDepositIntent(intent)) {
    return false;
  }
  try {
    assertLighterDepositPreflightWithinApproval({
      intent,
      fresh,
      stage: "approve",
    });
    assertLighterDepositPreflightWithinApproval({
      intent,
      fresh,
      stage: "deposit",
    });
    return true;
  } catch {
    return false;
  }
}

function canRenewConfirmedApprovalDeposit(input: {
  readonly intent: LighterOnboardingIntentRow;
  readonly sessionId: string;
  readonly fresh: LighterDepositPreflightSnapshot;
}): boolean {
  const { intent, sessionId, fresh } = input;
  return intent.sessionId === sessionId
    && intent.capability === "deposit"
    && intent.approvalStatus === "approved"
    && intent.executionState === "approve_confirmed"
    && intent.approveTxHash !== null
    && intent.approveTxFrom !== null
    && intent.approveTxNonce !== null
    && intent.depositTxHash === null
    && intent.depositTxFrom === null
    && intent.depositTxNonce === null
    && intent.depositReplacementTxHash === null
    && intent.depositReplacementReason === null
    && intent.depositReplacementObservedAt === null
    && intent.depositL1BlockHash === null
    && intent.depositL1BlockNumber === null
    && intent.depositEventAccountIndex === null
    && intent.lighterTxHash === null
    && intent.lighterTxStatus === null
    && intent.lighterBlockHeight === null
    && intent.lighterExecutedAt === null
    && intent.lighterEvidenceObservedAt === null
    && intent.resolvedAccountIndex === null
    && intent.failureReason === null
    && !fresh.approvalRequired
    && getAddress(fresh.walletAddress) === getAddress(intent.walletAddress)
    && fresh.chainId === intent.chainId
    && intent.depositContract !== null
    && getAddress(fresh.gatewayAddress) === getAddress(intent.depositContract)
    && intent.depositTo !== null
    && getAddress(fresh.walletAddress) === getAddress(intent.depositTo)
    && fresh.assetIndex === intent.assetIndex
    && fresh.routeType === intent.routeType
    && fresh.amountUnits === intent.amountUnits
    && fresh.settlementTokenAddress.toLowerCase()
      === intent.settlementTokenAddress?.toLowerCase()
    && fresh.settlementTokenSymbol === intent.settlementTokenSymbol
    && fresh.settlementTokenDecimals === intent.settlementTokenDecimals;
}

function isConfirmedApprovalRecoveryPending(intent: LighterOnboardingIntentRow): boolean {
  return intent.capability === "deposit"
    && intent.approvalStatus === "approval_pending"
    && intent.executionState === "approve_confirmed"
    && intent.approveTxHash !== null
    && intent.approveTxFrom !== null
    && intent.approveTxNonce !== null
    && intent.depositTxHash === null
    && intent.depositTxFrom === null
    && intent.depositTxNonce === null
    && intent.depositReplacementTxHash === null
    && intent.depositL1BlockHash === null
    && intent.lighterTxHash === null
    && intent.failureReason === null;
}

function canSupersedePristineDepositFromAnotherSession(input: {
  readonly intent: LighterOnboardingIntentRow;
  readonly sessionId: string;
}): boolean {
  const { intent, sessionId } = input;
  if (
    intent.sessionId === sessionId
    || intent.capability !== "deposit"
    || intent.failureReason !== null
    || intent.approveTxHash !== null
    || intent.approveTxFrom !== null
    || intent.approveTxNonce !== null
    || intent.approveReplacementTxHash !== null
    || intent.approveReplacementReason !== null
    || intent.approveReplacementObservedAt !== null
    || intent.depositTxHash !== null
    || intent.depositTxFrom !== null
    || intent.depositTxNonce !== null
    || intent.depositReplacementTxHash !== null
    || intent.depositReplacementReason !== null
    || intent.depositReplacementObservedAt !== null
    || intent.depositL1BlockHash !== null
    || intent.depositL1BlockNumber !== null
    || intent.depositEventAccountIndex !== null
    || intent.lighterTxHash !== null
    || intent.lighterTxStatus !== null
    || intent.lighterBlockHeight !== null
    || intent.lighterExecutedAt !== null
    || intent.lighterEvidenceObservedAt !== null
    || intent.resolvedAccountIndex !== null
  ) {
    return false;
  }
  return (
    intent.approvalStatus === "approval_pending"
    && intent.executionState === "approval_pending"
    && intent.approvalId === null
    && intent.protocolExecutionId === null
    && intent.decisionReason === null
  ) || isPristineApprovedDepositIntent(intent);
}

function depositUserGuidance(execution: LighterDepositExecutionResult): string {
  switch (execution.status) {
    case "l2_pending":
      return "Ethereum confirmed the deposit, but Vex has not yet proven that Lighter credited this exact transaction. Tell the user the deposit is awaiting Lighter confirmation and must not be retried.";
    case "ambiguous":
      return `The ${execution.stage} transaction outcome could not be confirmed. Tell the user the state is uncertain and that it must be reconciled before any retry; do not say it succeeded or failed.`;
    case "failed":
      return `The ${execution.stage} transaction failed, so no funds moved to Lighter. Tell the user the deposit did not go through.`;
  }
}

function depositStatusNextAction(intent: LighterOnboardingIntentRow): string {
  if (intent.approvalStatus === "rejected") {
    return "The deposit was rejected. Prepare a new deposit only if the user asks again.";
  }
  if (intent.approvalStatus === "expired") {
    return "The approval expired without execution. Prepare a fresh deposit only if the user asks again.";
  }
  if (intent.approvalStatus === "approval_pending") {
    return "Wait for the user to approve or reject the existing approval card.";
  }
  switch (intent.executionState) {
    case "credited":
      return "The deposit is credited; no retry is needed. Continue managed onboarding by preparing secure trading access if the account is not already ready.";
    case "failed":
      return "The deposit is terminally failed. Verify the reason before preparing a new deposit.";
    case "approval_pending":
    case "prepared":
      return "The deposit is waiting for approval preparation to complete.";
    case "slot_reserved":
      return "This is a key-registration reservation, not a deposit state. Continue only through the dedicated key-registration flow.";
    case "key_generated_encrypted":
      return "This is encrypted key-registration state, not a deposit state. Continue only through the dedicated key-registration flow.";
    case "approved":
      if (isPristineApprovedDepositIntent(intent)) {
        return "No transaction was staged. A new onboarding chat can safely prepare a fresh deposit approval without technical retry instructions.";
      }
      return "Reconcile the existing intent before any retry. Never rebroadcast either transaction from this status result.";
    case "allowance_verified":
    case "approve_submitted":
    case "deposit_submitted":
    case "deposit_confirmed":
    case "ambiguous":
      return "Reconcile the existing intent before any retry. Never rebroadcast either transaction from this status result.";
    case "approve_confirmed":
      return "The allowance is confirmed and no deposit was broadcast. Prepare the same deposit again to receive a fresh deposit-only approval card.";
  }
}

function projectDepositStatus(intent: LighterOnboardingIntentRow): Record<string, unknown> {
  return {
    intentId: intent.intentId,
    environment: intent.environment,
    walletAddress: intent.walletAddress,
    approvalStatus: intent.approvalStatus,
    executionState: intent.executionState,
    amountUnits: intent.amountUnits,
    settlementTokenAddress: intent.settlementTokenAddress,
    settlementTokenSymbol: intent.settlementTokenSymbol,
    settlementTokenDecimals: intent.settlementTokenDecimals,
    preflightMinimumTransferUnits: intent.preflightMinimumTransferUnits,
    preflightWalletBalanceUnits: intent.preflightWalletBalanceUnits,
    preflightWalletAllowanceUnits: intent.preflightWalletAllowanceUnits,
    preflightWalletNativeBalanceWei: intent.preflightWalletNativeBalanceWei,
    preflightEthereumBlockNumber: intent.preflightEthereumBlockNumber,
    preflightLighterBlockNumber: intent.preflightLighterBlockNumber,
    preflightObservedAt: intent.preflightObservedAt?.toISOString() ?? null,
    preflightApproveGasLimit: intent.preflightApproveGasLimit,
    preflightDepositGasLimit: intent.preflightDepositGasLimit,
    preflightMaxFeePerGasWei: intent.preflightMaxFeePerGasWei,
    preflightMaxPriorityFeePerGasWei: intent.preflightMaxPriorityFeePerGasWei,
    preflightApproveMaxFeeWei: intent.preflightApproveMaxFeeWei,
    preflightDepositMaxFeeWei: intent.preflightDepositMaxFeeWei,
    preflightTotalMaxFeeWei: intent.preflightTotalMaxFeeWei,
    preflightNativeReserveWei: intent.preflightNativeReserveWei,
    preflightRequiredNativeBalanceWei: intent.preflightRequiredNativeBalanceWei,
    approveTxHash: intent.approveTxHash,
    approveTxFrom: intent.approveTxFrom,
    approveTxNonce: intent.approveTxNonce,
    approveReplacementTxHash: intent.approveReplacementTxHash,
    approveReplacementReason: intent.approveReplacementReason,
    approveReplacementObservedAt:
      intent.approveReplacementObservedAt?.toISOString() ?? null,
    depositTxHash: intent.depositTxHash,
    depositTxFrom: intent.depositTxFrom,
    depositTxNonce: intent.depositTxNonce,
    depositReplacementTxHash: intent.depositReplacementTxHash,
    depositReplacementReason: intent.depositReplacementReason,
    depositReplacementObservedAt:
      intent.depositReplacementObservedAt?.toISOString() ?? null,
    depositL1BlockHash: intent.depositL1BlockHash,
    depositL1BlockNumber: intent.depositL1BlockNumber,
    depositEventAccountIndex: intent.depositEventAccountIndex,
    lighterTxHash: intent.lighterTxHash,
    lighterTxStatus: intent.lighterTxStatus,
    lighterBlockHeight: intent.lighterBlockHeight,
    lighterExecutedAt: intent.lighterExecutedAt,
    lighterEvidenceObservedAt: intent.lighterEvidenceObservedAt?.toISOString() ?? null,
    resolvedAccountIndex: intent.resolvedAccountIndex,
    failureReason: intent.failureReason,
    createdAt: intent.createdAt.toISOString(),
    updatedAt: intent.updatedAt.toISOString(),
    expiresAt: intent.expiresAt.toISOString(),
    nextAction: depositStatusNextAction(intent),
  };
}

function projectOnboardingWorkflow(
  workflow: LighterOnboardingWorkflowRow | null,
): Record<string, unknown> | null {
  if (workflow === null) return null;
  return {
    environment: workflow.environment,
    walletAddress: workflow.walletAddress,
    state: workflow.workflowState,
    lastStableState: workflow.lastStableState,
    activeDepositIntentId: workflow.activeDepositIntentId,
    resolvedAccountIndex: workflow.resolvedAccountIndex,
    apiKeyIndex: workflow.apiKeyIndex,
    publicKeyFingerprint: workflow.publicKeyFingerprint,
    failureCode: workflow.failureCode,
    revision: workflow.revision,
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

export const LIGHTER_DEPOSIT_HANDLERS: Record<string, ProtocolHandler> = {
  "lighter.deposit.status": async (params, context) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);

    let walletAddress: string;
    try {
      walletAddress = getAddress(
        resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
      );
    } catch (err) {
      return walletScopeErrorToResult(err);
    }

    const intentIdRaw = params.intentId;
    const intentId =
      typeof intentIdRaw === "string" && intentIdRaw.trim().length > 0
        ? intentIdRaw.trim()
        : null;
    const intents = intentId === null
      ? await onboardingIntentsRepo.listUnresolvedDepositsForWallet(
          environment.value,
          walletAddress,
        )
      : [await onboardingIntentsRepo.findByIntentId(intentId)].filter(
          (intent): intent is LighterOnboardingIntentRow => intent !== null,
        );
    if (intentId !== null && intents.length === 0) {
      return fail(`No Lighter deposit intent ${intentId} exists locally.`);
    }
    if (
      intents.some(
        (intent) =>
          intent.capability !== "deposit"
          || intent.environment !== environment.value
          || intent.walletAddress.toLowerCase() !== walletAddress.toLowerCase(),
      )
    ) {
      return fail("The requested Lighter deposit intent does not belong to this wallet and environment.");
    }

    const repairReports: LighterDepositRepairReport[] = [];
    const refreshedIntents: LighterOnboardingIntentRow[] = [];
    let reconciliationErrors = 0;
    if (intents.length > 0) {
      try {
        const repairDeps = buildProductionLighterDepositRepairDeps();
        for (const intent of intents) {
          try {
            repairReports.push(await repairLighterDepositIntent(intent, repairDeps));
          } catch {
            reconciliationErrors += 1;
          }
          refreshedIntents.push(
            (await onboardingIntentsRepo.findByIntentId(intent.intentId)) ?? intent,
          );
        }
      } catch {
        reconciliationErrors = intents.length;
        refreshedIntents.push(...intents);
      }
    }
    const workflow = await getLighterOnboardingWorkflow(
      environment.value,
      walletAddress,
    );

    return ok({
      source: "vex_lighter_local_deposit_status",
      environment: environment.value,
      walletAddress,
      workflow: projectOnboardingWorkflow(workflow),
      checkedIntents: refreshedIntents.length,
      reconciliationErrors,
      reconciliationReports: repairReports,
      intents: refreshedIntents.map(projectDepositStatus),
      riskNotes: [
        "Phase 2 reconciliation is evidence-only: it never signs, broadcasts, retries, or replaces a deposit transaction.",
        "Credited requires the exact staged L1 hash, matching Ethereum Deposit event, executed Lighter transaction, and ownership of the event-selected master account.",
        "Any submitted or ambiguous intent must be reconciled from chain and Lighter evidence before a new deposit is prepared.",
      ],
      message:
        intents.length === 0
          ? `No unresolved Lighter deposit intents exist for this ${environment.value} wallet.`
          : reconciliationErrors === 0
            ? `Checked and reconciled ${intents.length} Lighter deposit intent(s) for this wallet.`
            : `Checked ${intents.length} Lighter deposit intent(s); ${reconciliationErrors} could not be reconciled from provider evidence and remain unresolved.`,
    });
  },

  "lighter.deposit.prepare": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Lighter deposit preparation requires a host session id.");

    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const funding = getLighterFundingDeployment(environment.value);

    let walletAddress: string;
    try {
      walletAddress = getAddress(
        resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
      );
    } catch (err) {
      return walletScopeErrorToResult(err);
    }

    if (!(await isLighterIntegrationEnabled(environment.value, walletAddress))) {
      try {
        await setLighterIntegrationEnabled({
          environment: environment.value,
          walletAddress,
          enabled: true,
        });
      } catch (err) {
        return fail(
          `Vex could not start managed Lighter setup for the selected wallet: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const amountInRaw = params.amountIn;
    if (typeof amountInRaw !== "string") {
      return fail(`amountIn must be a decimal ${funding.settlementSymbol} string, for example "11".`);
    }
    let amountUnits: bigint;
    try {
      amountUnits = decimalToBaseUnits(amountInRaw, LIGHTER_SETTLEMENT_ASSET_DECIMALS);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (amountUnits < funding.minimumDepositUnits) {
      return fail(`Lighter deposit must be at least ${LIGHTER_DEPOSIT_MIN_USDC} ${funding.settlementSymbol}; a smaller deposit is not credited.`);
    }

    const routeType = LIGHTER_DEPOSIT_ROUTE_TYPE.perps;
    let preflight;
    try {
      preflight = await readLighterDepositPreflight({
        environment: environment.value,
        walletAddress,
        amountUnits,
        routeType,
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    let creation: onboardingIntentsRepo.CreateDepositIntentOutcome;
    try {
      creation = await withSessionControlLock(sessionId, (client) =>
        onboardingIntentsRepo.createOrFindLiveDepositApprovalPendingWith(client, {
          sessionId,
          environment: environment.value,
          walletAddress: preflight.walletAddress,
          chainId: preflight.chainId,
          depositContract: preflight.gatewayAddress,
          depositTo: preflight.walletAddress,
          assetIndex: preflight.assetIndex,
          routeType: preflight.routeType,
          amountUnits: preflight.amountUnits,
          preflight,
          expiresAt: new Date(Date.now() + INTENT_TTL_MS),
        }),
      );
    } catch {
      return fail(
        "Vex could not safely reserve the Lighter deposit intent. No deposit was prepared.",
      );
    }
    if (creation.outcome === "live_conflict") {
      const conflict = creation.intent;
      if (
        conflict !== null
        && canSupersedePristineDepositFromAnotherSession({ intent: conflict, sessionId })
      ) {
        try {
          const restarted = await withSessionControlLocks(
            [conflict.sessionId, sessionId],
            async (client) => {
              const superseded = await onboardingIntentsRepo.supersedePristineDepositIntentWith(
                client,
                {
                  intentId: conflict.intentId,
                  sessionId: conflict.sessionId,
                  environment: conflict.environment,
                  walletAddress: conflict.walletAddress,
                },
              );
              if (superseded === null) return null;
              const replacement = await onboardingIntentsRepo
                .createOrFindLiveDepositApprovalPendingWith(client, {
                  sessionId,
                  environment: environment.value,
                  walletAddress: preflight.walletAddress,
                  chainId: preflight.chainId,
                  depositContract: preflight.gatewayAddress,
                  depositTo: preflight.walletAddress,
                  assetIndex: preflight.assetIndex,
                  routeType: preflight.routeType,
                  amountUnits: preflight.amountUnits,
                  preflight,
                  expiresAt: new Date(Date.now() + INTENT_TTL_MS),
                });
              if (replacement.outcome !== "created") {
                throw new Error("A replacement Lighter deposit intent was not created.");
              }
              return replacement;
            },
          );
          if (restarted !== null) {
            creation = restarted;
          }
        } catch {
          return fail(
            "Vex could not safely start a fresh Lighter deposit approval. Nothing was signed or submitted; check onboarding status and try again.",
          );
        }
      }
    }
    if (creation.outcome === "live_conflict") {
      const conflict = creation.intent;
      if (
        conflict !== null
        && canReissuePristineDepositApproval({
          intent: conflict,
          sessionId,
          fresh: preflight,
        })
      ) {
        let followUp: PreparedActionFollowUp;
        try {
          followUp = buildDepositApprovalFollowUp(conflict);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
        return {
          ...ok({
            ...depositApprovalPreparedPayload(conflict),
            approvalReissued: true,
          }),
          preparedActionFollowUp: followUp,
        };
      }
      if (
        conflict !== null
        && canRenewPristineApprovedDepositApproval({
          intent: conflict,
          sessionId,
          fresh: preflight,
        })
      ) {
        const renewed = await withSessionControlLock(sessionId, (client) =>
          onboardingIntentsRepo.renewPristineApprovedDepositIntentWith(client, {
            intentId: conflict.intentId,
            sessionId,
            preflight,
            expiresAt: new Date(Date.now() + INTENT_TTL_MS),
          }),
        );
        if (renewed === null) {
          return fail(
            "The approved Lighter deposit changed before its fresh approval could be prepared. Nothing was signed or submitted; check onboarding status before retrying.",
          );
        }
        let followUp: PreparedActionFollowUp;
        try {
          followUp = buildDepositApprovalFollowUp(renewed);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
        return {
          ...ok({
            ...depositApprovalPreparedPayload(renewed),
            approvalReissued: true,
          }),
          preparedActionFollowUp: followUp,
        };
      }
      if (
        conflict !== null
        && canRenewConfirmedApprovalDeposit({
          intent: conflict,
          sessionId,
          fresh: preflight,
        })
      ) {
        const renewed = await withSessionControlLock(sessionId, (client) =>
          onboardingIntentsRepo.renewConfirmedApprovalDepositIntentWith(client, {
            intentId: conflict.intentId,
            sessionId,
            preflight,
            expiresAt: new Date(Date.now() + INTENT_TTL_MS),
          }),
        );
        if (renewed === null) {
          return fail(
            "The confirmed Lighter approval changed before recovery could be prepared. No deposit was signed or submitted; check onboarding status before retrying.",
          );
        }
        let followUp: PreparedActionFollowUp;
        try {
          followUp = buildDepositApprovalFollowUp(renewed);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
        return {
          ...ok({
            ...depositApprovalPreparedPayload(renewed),
            approvalReissued: true,
            recovery: "confirmed_allowance_deposit_only",
          }),
          preparedActionFollowUp: followUp,
        };
      }
      return fail(
        conflict === null
          ? "Another Lighter deposit preparation won the concurrency race. No second deposit was prepared; check onboarding status before retrying."
          : `Lighter deposit intent ${conflict.intentId} is already unresolved in state ${conflict.executionState}. No second deposit was prepared; resolve or reconcile it before creating another.`,
      );
    }
    const created = creation.intent;

    let followUp: PreparedActionFollowUp;
    try {
      followUp = buildDepositApprovalFollowUp(created);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    return {
      ...ok(depositApprovalPreparedPayload(created)),
      preparedActionFollowUp: followUp,
    };
  },

  "lighter.deposit": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Lighter deposit requires a host session id.");
    const intentId = params.intentId;
    if (typeof intentId !== "string" || intentId.trim().length === 0) {
      return fail("Missing required: intentId.");
    }
    if (!context.approved || !context.approvalId) {
      return {
        success: false,
        output: "Lighter deposit requires an approved Vex approval card for a prepared deposit intent.",
        pendingApproval: true,
      };
    }

    const intent = await onboardingIntentsRepo.findByIntentId(intentId.trim());
    if (!intent || intent.sessionId !== sessionId) {
      return fail(`No Lighter deposit intent ${intentId} found in this session.`);
    }
    if (intent.capability !== "deposit") {
      return fail(`Intent ${intent.intentId} is not a Lighter deposit intent.`);
    }
    if (!(await isLighterIntegrationEnabled(intent.environment, intent.walletAddress))) {
      return fail(
        "Lighter was disabled for this Vex wallet before execution. Nothing was signed or submitted; enable it again and prepare a fresh approval.",
      );
    }
    try {
      await assertLighterDepositApprovalBinding({ approvalId: context.approvalId, sessionId, intent });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const confirmedRecoveryPending = isConfirmedApprovalRecoveryPending(intent);
    if (intent.expiresAt.getTime() <= Date.now()) {
      await withSessionControlLock(sessionId, (client) =>
        confirmedRecoveryPending
          ? onboardingIntentsRepo.markConfirmedApprovalRecoveryDecisionWith(client, {
              intentId: intent.intentId,
              decision: "expired",
              approvalId: context.approvalId,
              reason: "approval resume observed an expired Lighter deposit recovery",
            })
          : onboardingIntentsRepo.markApprovalDecisionWith(client, {
              intentId: intent.intentId,
              decision: "expired",
              approvalId: context.approvalId,
              reason: "approval resume observed an expired Lighter deposit intent",
            }),
      );
      return fail(`Lighter deposit intent ${intent.intentId} expired before approval resume.`);
    }

    const approved = intent.executionState === "approval_pending"
      ? await withSessionControlLock(sessionId, (client) =>
        onboardingIntentsRepo.markApprovalDecisionWith(client, {
          intentId: intent.intentId,
          decision: "approved",
          approvalId: context.approvalId,
          reason: "user approved exact Lighter deposit intent",
        }),
      )
      : confirmedRecoveryPending
        ? await withSessionControlLock(sessionId, (client) =>
          onboardingIntentsRepo.markConfirmedApprovalRecoveryDecisionWith(client, {
            intentId: intent.intentId,
            decision: "approved",
            approvalId: context.approvalId,
            reason: "user approved exact Lighter deposit-only recovery",
          }),
        )
      : isPristineApprovedDepositIntent(intent) ? intent : null;
    if (approved === null) {
      return fail(`Lighter deposit intent ${intent.intentId} is not approval-authorized for execution.`);
    }

    if (approved.amountUnits === null) {
      return fail("The approved Lighter deposit amount is missing. Nothing was signed or submitted.");
    }
    if (!isLighterDepositFeePreflightComplete()) {
      return ok({
        source: "vex_lighter_deposit",
        status: "approval_recorded_fee_preflight_closed",
        message:
          "Lighter deposit approval was recorded, but live execution remains blocked until exact gas and fee exposure is implemented. Nothing was signed or submitted, and the signing key was not resolved.",
        intentId: approved.intentId,
        executionState: approved.executionState,
      });
    }
    try {
      if (approved.amountUnits === null || !/^[1-9][0-9]*$/.test(approved.amountUnits)) {
        throw new Error("The approved deposit amount is missing or invalid.");
      }
      const fresh = await readLighterDepositPreflight({
        environment: approved.environment,
        walletAddress: approved.walletAddress,
        amountUnits: BigInt(approved.amountUnits),
        routeType: approved.routeType ?? LIGHTER_DEPOSIT_ROUTE_TYPE.perps,
      });
      if (approved.executionState === "approve_confirmed" && fresh.approvalRequired) {
        throw new Error(
          `The confirmed ${approved.settlementTokenSymbol ?? "settlement-token"} allowance is no longer sufficient. Nothing was signed or submitted; prepare a new deposit approval.`,
        );
      }
      assertLighterDepositPreflightWithinApproval({
        intent: approved,
        fresh,
        stage: approved.executionState === "approve_confirmed" ? "deposit" : "execution",
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    const lease = await acquireLighterDepositExecutionLease({
      chainId: approved.chainId,
      walletAddress: approved.walletAddress,
      intentId: approved.intentId,
    }).catch(() => null);
    if (lease === null) {
      return fail(
        "Could not acquire the Lighter wallet execution lease. Nothing was signed; check onboarding status before retrying.",
      );
    }
    if (!lease.acquired) {
      const retryNote = lease.retryAfter === null
        ? "after the active wallet operation is reconciled"
        : `after ${lease.retryAfter.toISOString()}`;
      return fail(
        `Another Lighter operation owns this Ethereum wallet execution slot. Nothing was signed; retry ${retryNote}.`,
      );
    }

    const leaseHandle = lease.handle;
    try {
      await leaseHandle.assertOwned();

      let signer: ChainWallet;
      try {
        signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
      } catch (err) {
        return walletScopeErrorToResult(err);
      }
      if (signer.family !== "eip155") {
        return fail("Resolved wallet family mismatch for Lighter deposit.");
      }
      if (getAddress(signer.address) !== getAddress(approved.walletAddress)) {
        return fail("The resolved signing wallet does not match the prepared deposit wallet. Nothing was signed.");
      }

      const deps = buildLighterDepositExecutionDeps({
        environment: approved.environment,
        privateKey: signer.privateKey as Hex,
        sessionId,
        assertExecutionLease: () => leaseHandle.assertOwned(),
      });
      const execution = await executeApprovedLighterDeposit({ intent: approved, deps });
      return ok({
        source: "vex_lighter_live_deposit",
        ...execution,
        intentId: approved.intentId,
        userGuidance: depositUserGuidance(execution),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const ambiguous = await withSessionControlLock(sessionId, (client) =>
        onboardingIntentsRepo.markAmbiguousWith(
          client,
          approved.intentId,
          `Deposit executor error: ${reason}`,
        ),
      );
      const txHash = ambiguous?.depositReplacementTxHash
        ?? ambiguous?.depositTxHash
        ?? ambiguous?.approveReplacementTxHash
        ?? ambiguous?.approveTxHash
        ?? null;
      const stage = ambiguous?.depositReplacementTxHash || ambiguous?.depositTxHash
        ? "deposit"
        : ambiguous?.approveReplacementTxHash || ambiguous?.approveTxHash
          ? "approve"
          : "execution";
      return ok({
        source: "vex_lighter_live_deposit",
        status: "ambiguous",
        stage,
        txHash,
        reason,
        intentId: approved.intentId,
        userGuidance:
          "The deposit execution outcome is uncertain. Tell the user it must be reconciled before any retry; do not say it succeeded or failed.",
      });
    } finally {
      await leaseHandle.releaseExecutionLease().catch((err) => {
        logger.warn("lighter.deposit.execution_lease_release_failed", {
          intentId: approved.intentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  },
};
