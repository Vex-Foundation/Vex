/**
 * Orchestration for an approved Lighter deposit (approve -> deposit -> credited).
 *
 * Each fund-moving leg is INJECTED as a runner that signs, stages its tx hash
 * BEFORE broadcast (via the `onHashStaged` callback this orchestration supplies,
 * so the durable mark lands before the send), broadcasts, and returns the
 * confirmed/reverted/ambiguous outcome. That keeps the orchestration — approval
 * binding, leg ordering, lifecycle marks, ambiguity handling — fully unit-testable
 * without funds, while the live EVM signing remains approval-gated. It holds
 * no keys and never retries a broadcast: an unconfirmed leg becomes `ambiguous`
 * and stops for explicit reconciliation.
 */

import { buildLighterDepositCalldata } from "./deposit-calldata.js";
import {
  proveLighterDepositL1,
  type LighterDepositL1Evidence,
  type LighterDepositReceipt,
} from "./deposit-evidence.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import type {
  LighterReplacementTransaction,
  LighterStagedEvmTransaction,
} from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { effectiveApproveTxHash } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import type { ReceiptReplacementEvidence } from "@tools/evm-chains/receipt-guard.js";
import {
  type LighterDepositPreSignStage,
  type LighterDepositSignedFeeCeiling,
} from "./deposit-pre-sign.js";
import { proveApprovedLighterDepositReplacement } from "./deposit-replacement.js";
import {
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
} from "./constants.js";
import {
  getLighterFundingDeployment,
  type LighterFundingDeployment,
} from "./deployments.js";

export type LegOutcome = "confirmed" | "reverted" | "ambiguous";

export type LighterDepositExecutionResult =
  | {
      readonly status: "l2_pending";
      readonly approveTxHash: string | null;
      readonly depositTxHash: string;
      readonly reason: string;
    }
  | {
      readonly status: "ambiguous";
      readonly stage: "approve" | "deposit";
      readonly txHash: string | null;
      readonly reason: string;
    }
  | { readonly status: "failed"; readonly stage: "approve" | "deposit"; readonly reason: string };

export interface LighterDepositExecutionDeps {
  /** Independent code boundary: live fee preflight must be implemented first. */
  readonly depositFeePreflightComplete: () => boolean;
  /** Re-prove the cross-process chain-wallet execution lease before each leg. */
  readonly assertExecutionLease: () => Promise<void>;
  /** Fresh public-only revalidation at the signer-adjacent boundary. */
  readonly assertFreshPreSignPreflight: (
    intent: LighterOnboardingIntentRow,
    stage: LighterDepositPreSignStage,
  ) => Promise<LighterDepositSignedFeeCeiling>;
  /**
   * Run the ERC-20 approval leg if the deposit contract's allowance is short.
   * `onHashStaged` is called with the tx hash BEFORE broadcast so the caller
   * persists it first. Returns skipped=true (with no broadcast) when allowance
   * already suffices.
   */
  readonly runApproveLegIfNeeded: (input: {
    readonly walletAddress: string;
    readonly spender: string;
    readonly amountUnits: bigint;
    readonly feeCeiling: LighterDepositSignedFeeCeiling;
    readonly onHashStaged: (transaction: LighterStagedEvmTransaction) => Promise<void>;
  }) => Promise<
    | { readonly skipped: true }
    | {
        readonly skipped: false;
        readonly txHash: string;
        readonly outcome: LegOutcome;
        readonly confirmedBlockNumber?: bigint;
        readonly replacement?: ReceiptReplacementEvidence;
        readonly reason?: string;
      }
  >;
  /** Sign, stage (onHashStaged before broadcast), broadcast, and confirm the deposit. */
  readonly runDepositLeg: (input: {
    readonly walletAddress: string;
    readonly to: string;
    readonly data: string;
    readonly confirmedApprovalBlockNumber?: bigint;
    readonly feeCeiling: LighterDepositSignedFeeCeiling;
    readonly onHashStaged: (transaction: LighterStagedEvmTransaction) => Promise<void>;
  }) => Promise<{
    readonly txHash: string;
    readonly outcome: LegOutcome;
    readonly receipt?: LighterDepositReceipt;
    readonly replacement?: ReceiptReplacementEvidence;
    readonly reason?: string;
  }>;
  readonly intents: {
    markAllowanceVerified(intentId: string): Promise<unknown | null>;
    markApproveSubmitted(
      intentId: string,
      transaction: LighterStagedEvmTransaction,
    ): Promise<unknown | null>;
    markApproveConfirmed(intentId: string, txHash: string): Promise<unknown | null>;
    markDepositSubmitted(
      intentId: string,
      transaction: LighterStagedEvmTransaction,
    ): Promise<unknown | null>;
    recordApproveReplacement(
      intentId: string,
      replacement: LighterReplacementTransaction,
    ): Promise<unknown | null>;
    recordDepositReplacement(
      intentId: string,
      replacement: LighterReplacementTransaction,
    ): Promise<unknown | null>;
    markDepositConfirmed(
      intentId: string,
      evidence: LighterDepositL1Evidence,
    ): Promise<unknown | null>;
    markAmbiguous(intentId: string, reason: string): Promise<unknown | null>;
    markFailed(intentId: string, reason: string): Promise<unknown | null>;
  };
}

export async function executeApprovedLighterDeposit(input: {
  readonly intent: LighterOnboardingIntentRow;
  readonly deps: LighterDepositExecutionDeps;
}): Promise<LighterDepositExecutionResult> {
  const { intent, deps } = input;
  const funding = getLighterFundingDeployment(intent.environment);
  const resumingAfterConfirmedApproval = intent.executionState === "approve_confirmed";

  if (!deps.depositFeePreflightComplete()) {
    return {
      status: "failed",
      stage: "approve",
      reason:
        "Lighter deposit fee preflight is not complete. Nothing was signed or submitted.",
    };
  }

  if (
    intent.capability !== "deposit"
    || intent.chainId !== funding.settlementChainId
    || intent.approvalStatus !== "approved"
    || (intent.executionState !== "approved" && !resumingAfterConfirmedApproval)
    || intent.amountUnits === null
    || intent.depositTo === null
    || intent.depositContract === null
    || intent.depositTo.toLowerCase() !== intent.walletAddress.toLowerCase()
    || intent.depositContract.toLowerCase() !== funding.gatewayProxy.toLowerCase()
    || intent.assetIndex !== funding.settlementAssetIndex
    || intent.routeType !== funding.perpsRouteType
    || !hasValidPersistedPreflight(intent, funding)
    || (
      resumingAfterConfirmedApproval
      && (
        effectiveApproveTxHash(intent) === null
        || intent.approveTxFrom === null
        || intent.approveTxNonce === null
        || intent.depositTxHash !== null
        || intent.depositReplacementTxHash !== null
      )
    )
  ) {
    return { status: "failed", stage: "approve", reason: "Deposit intent is missing required fields." };
  }

  let amountUnits: bigint;
  let calldata: ReturnType<typeof buildLighterDepositCalldata>;
  try {
    if (!/^[1-9][0-9]*$/.test(intent.amountUnits)) {
      throw new Error("Deposit amount is not a positive integer.");
    }
    amountUnits = BigInt(intent.amountUnits);
    // Rebuild calldata from the persisted intent; validates recipient/amount/index.
    calldata = buildLighterDepositCalldata({
      environment: intent.environment,
      to: intent.depositTo,
      amountUnits,
      route: "perps",
      assetIndex: intent.assetIndex,
    });
  } catch (err) {
    return { status: "failed", stage: "approve", reason: errText(err) };
  }

  // Leg 1: approval (only if allowance is short). Hash persists before broadcast.
  // A freshly re-approved recovery can resume after a previously confirmed
  // allowance transaction, but it must never sign or broadcast that leg again.
  let approveTxHash: string | null = null;
  let approveStaged: LighterStagedEvmTransaction | null = null;
  let confirmedApprovalBlockNumber: bigint | undefined;
  if (!resumingAfterConfirmedApproval) try {
    await deps.assertExecutionLease();
    const approveFeeCeiling = await deps.assertFreshPreSignPreflight(intent, "approve");
    const approve = await deps.runApproveLegIfNeeded({
      walletAddress: intent.walletAddress,
      spender: intent.depositContract,
      amountUnits,
      feeCeiling: approveFeeCeiling,
      onHashStaged: async (transaction) => {
        approveTxHash = transaction.txHash;
        approveStaged = transaction;
        const staged = await tryTransition(() =>
          deps.intents.markApproveSubmitted(intent.intentId, transaction));
        if (!staged) {
          throw new PreBroadcastPersistenceError(
            "Approval transaction hash could not be durably staged; broadcast was aborted.",
          );
        }
      },
    });
    if (approve.skipped) {
      const verified = await tryTransition(() =>
        deps.intents.markAllowanceVerified(intent.intentId));
      if (!verified) {
        return {
          status: "failed",
          stage: "approve",
          reason: "Existing allowance was sufficient, but its lifecycle state could not be recorded. Deposit was not signed or broadcast.",
        };
      }
    } else {
      if (approveTxHash === null || approve.txHash !== approveTxHash) {
        return await ambiguousResult(
          deps,
          intent.intentId,
          "approve",
          approveTxHash ?? approve.txHash,
          "Approval runner returned without the same durably staged transaction hash.",
        );
      }
      if (approve.replacement !== undefined) {
        const stagedApprove = approveStaged as LighterStagedEvmTransaction | null;
        if (stagedApprove === null) {
          return await ambiguousResult(
            deps,
            intent.intentId,
            "approve",
            approve.txHash,
            "Ethereum reported an approval replacement without staged sender and nonce evidence.",
          );
        }
        let accepted: LighterReplacementTransaction;
        try {
          accepted = proveApprovedLighterDepositReplacement({
            intent: {
              ...intent,
              approveTxHash: stagedApprove.txHash,
              approveTxFrom: stagedApprove.fromAddress,
              approveTxNonce: stagedApprove.nonce.toString(10),
            },
            stage: "approve",
            replacement: approve.replacement,
          });
        } catch (err) {
          return await ambiguousResult(
            deps,
            intent.intentId,
            "approve",
            approve.replacement.replacementTxHash,
            errText(err),
          );
        }
        const replacementRecorded = await tryTransition(() =>
          deps.intents.recordApproveReplacement(intent.intentId, accepted));
        if (!replacementRecorded) {
          return await ambiguousResult(
            deps,
            intent.intentId,
            "approve",
            accepted.replacementTxHash,
            "The exact approval replacement could not be recorded durably.",
          );
        }
        approveTxHash = accepted.replacementTxHash;
      }
      if (approve.outcome === "reverted") {
        const reason = approve.reason ?? "Settlement-asset approval reverted on chain.";
        const recorded = await tryTransition(() => deps.intents.markFailed(intent.intentId, reason));
        return {
          status: "failed",
          stage: "approve",
          reason: recorded ? reason : `${reason} Durable failure state could not be recorded.`,
        };
      }
      if (approve.outcome === "ambiguous") {
        const reason = approve.reason ?? "Approval broadcast outcome is unconfirmed.";
        return await ambiguousResult(deps, intent.intentId, "approve", approve.txHash, reason);
      }
      const confirmedTxHash = approveTxHash;
      if (confirmedTxHash === null) {
        return await ambiguousResult(
          deps,
          intent.intentId,
          "approve",
          approve.txHash,
          "Approval confirmed without a durable effective transaction hash.",
        );
      }
      const confirmed = await tryTransition(() =>
        deps.intents.markApproveConfirmed(intent.intentId, confirmedTxHash));
      if (!confirmed) {
        return await ambiguousResult(
          deps,
          intent.intentId,
          "approve",
          approve.txHash,
          "Approval confirmed on chain, but the durable lifecycle transition conflicted. Deposit was not started.",
        );
      }
      confirmedApprovalBlockNumber = approve.confirmedBlockNumber;
    }
  } catch (err) {
    const reason = errText(err);
    if (err instanceof PreBroadcastPersistenceError) {
      return { status: "failed", stage: "approve", reason };
    }
    if (approveTxHash === null) {
      const recorded = await tryTransition(() =>
        deps.intents.markFailed(intent.intentId, `Approval failed before broadcast: ${reason}`));
      return {
        status: "failed",
        stage: "approve",
        reason: recorded ? reason : `${reason} Durable failure state could not be recorded.`,
      };
    }
    return await ambiguousResult(
      deps,
      intent.intentId,
      "approve",
      approveTxHash,
      `Approval leg error after hash staging: ${reason}`,
    );
  }

  // Leg 2: deposit. Hash persists before broadcast.
  let depositTxHash: string | null = null;
  let depositStaged: LighterStagedEvmTransaction | null = null;
  let depositEvidence: LighterDepositL1Evidence | null = null;
  try {
    await deps.assertExecutionLease();
    const depositFeeCeiling = await deps.assertFreshPreSignPreflight(intent, "deposit");
    const deposit = await deps.runDepositLeg({
      walletAddress: intent.walletAddress,
      to: calldata.to,
      data: calldata.data,
      confirmedApprovalBlockNumber,
      feeCeiling: depositFeeCeiling,
      onHashStaged: async (transaction) => {
        depositTxHash = transaction.txHash;
        depositStaged = transaction;
        const staged = await tryTransition(() =>
          deps.intents.markDepositSubmitted(intent.intentId, transaction));
        if (!staged) {
          throw new PreBroadcastPersistenceError(
            "Deposit transaction hash could not be durably staged; broadcast was aborted.",
          );
        }
      },
    });
    if (depositTxHash === null || deposit.txHash !== depositTxHash) {
      return await ambiguousResult(
        deps,
        intent.intentId,
        "deposit",
        depositTxHash ?? deposit.txHash,
        "Deposit runner returned without the same durably staged transaction hash.",
      );
    }
    if (deposit.replacement !== undefined) {
      const stagedDeposit = depositStaged as LighterStagedEvmTransaction | null;
      if (stagedDeposit === null) {
        return await ambiguousResult(
          deps,
          intent.intentId,
          "deposit",
          deposit.txHash,
          "Ethereum reported a deposit replacement without staged sender and nonce evidence.",
        );
      }
      let accepted: LighterReplacementTransaction;
      try {
        accepted = proveApprovedLighterDepositReplacement({
          intent: {
            ...intent,
            depositTxHash: stagedDeposit.txHash,
            depositTxFrom: stagedDeposit.fromAddress,
            depositTxNonce: stagedDeposit.nonce.toString(10),
          },
          stage: "deposit",
          replacement: deposit.replacement,
        });
      } catch (err) {
        return await ambiguousResult(
          deps,
          intent.intentId,
          "deposit",
          deposit.replacement.replacementTxHash,
          errText(err),
        );
      }
      const replacementRecorded = await tryTransition(() =>
        deps.intents.recordDepositReplacement(intent.intentId, accepted));
      if (!replacementRecorded) {
        return await ambiguousResult(
          deps,
          intent.intentId,
          "deposit",
          accepted.replacementTxHash,
          "The exact deposit replacement could not be recorded durably.",
        );
      }
      depositTxHash = accepted.replacementTxHash;
    }
    if (deposit.outcome === "reverted") {
      const reason = deposit.reason ?? "Deposit transaction reverted on chain.";
      const recorded = await tryTransition(() => deps.intents.markFailed(intent.intentId, reason));
      return {
        status: "failed",
        stage: "deposit",
        reason: recorded ? reason : `${reason} Durable failure state could not be recorded.`,
      };
    }
    if (deposit.outcome === "ambiguous") {
      const reason = deposit.reason ?? "Deposit broadcast outcome is unconfirmed.";
      return await ambiguousResult(deps, intent.intentId, "deposit", deposit.txHash, reason);
    }
    if (deposit.receipt === undefined) {
      return await ambiguousResult(
        deps,
        intent.intentId,
        "deposit",
        deposit.txHash,
        "Deposit runner reported confirmation without an Ethereum receipt.",
      );
    }
    depositEvidence = proveLighterDepositL1(deposit.receipt, {
      txHash: depositTxHash,
      gatewayAddress: intent.depositContract,
      walletAddress: intent.walletAddress,
      recipientAddress: intent.depositTo,
      assetIndex: intent.assetIndex,
      routeType: intent.routeType,
      amountUnits,
    });
  } catch (err) {
    const reason = errText(err);
    if (err instanceof PreBroadcastPersistenceError) {
      return { status: "failed", stage: "deposit", reason };
    }
    if (depositTxHash === null) {
      const recorded = await tryTransition(() =>
        deps.intents.markFailed(intent.intentId, `Deposit failed before broadcast: ${reason}`));
      return {
        status: "failed",
        stage: "deposit",
        reason: recorded ? reason : `${reason} Durable failure state could not be recorded.`,
      };
    }
    return await ambiguousResult(
      deps,
      intent.intentId,
      "deposit",
      depositTxHash,
      `Deposit leg error after hash staging: ${reason}`,
    );
  }

  const depositConfirmed = await tryTransition(() =>
    deps.intents.markDepositConfirmed(intent.intentId, depositEvidence!));
  if (!depositConfirmed) {
    return await ambiguousResult(
      deps,
      intent.intentId,
      "deposit",
      depositTxHash,
      "Deposit confirmed on chain, but the durable lifecycle transition conflicted.",
    );
  }

  return {
    status: "l2_pending",
    approveTxHash,
    depositTxHash,
    reason:
      "Ethereum confirmed the deposit. Exact Lighter-side evidence for this L1 transaction is still required before Vex can mark it credited.",
  };
}

class PreBroadcastPersistenceError extends Error {}

async function tryTransition(action: () => Promise<unknown | null>): Promise<boolean> {
  try {
    return (await action()) != null;
  } catch {
    return false;
  }
}

async function ambiguousResult(
  deps: LighterDepositExecutionDeps,
  intentId: string,
  stage: "approve" | "deposit",
  txHash: string | null,
  reason: string,
): Promise<LighterDepositExecutionResult> {
  const recorded = await tryTransition(() => deps.intents.markAmbiguous(intentId, reason));
  return {
    status: "ambiguous",
    stage,
    txHash,
    reason: recorded ? reason : `${reason} Durable ambiguous state could not be recorded.`,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasValidPersistedPreflight(
  intent: LighterOnboardingIntentRow,
  funding: LighterFundingDeployment,
): boolean {
  if (
    intent.amountUnits === null
    || intent.settlementTokenAddress?.toLowerCase() !== funding.settlementTokenProxy.toLowerCase()
    || intent.settlementTokenSymbol !== funding.settlementSymbol
    || intent.settlementTokenDecimals !== LIGHTER_SETTLEMENT_ASSET_DECIMALS
    || intent.preflightMinimumTransferUnits === null
    || intent.preflightWalletBalanceUnits === null
    || intent.preflightWalletAllowanceUnits === null
    || intent.preflightWalletNativeBalanceWei === null
    || intent.preflightEthereumBlockNumber === null
    || intent.preflightLighterBlockNumber === null
    || intent.preflightObservedAt === null
    || intent.preflightApproveGasLimit === null
    || intent.preflightDepositGasLimit === null
    || intent.preflightMaxFeePerGasWei === null
    || intent.preflightMaxPriorityFeePerGasWei === null
    || intent.preflightApproveMaxFeeWei === null
    || intent.preflightDepositMaxFeeWei === null
    || intent.preflightTotalMaxFeeWei === null
    || intent.preflightNativeReserveWei === null
    || intent.preflightRequiredNativeBalanceWei === null
  ) return false;
  const integerFields = [
    intent.amountUnits,
    intent.preflightMinimumTransferUnits,
    intent.preflightWalletBalanceUnits,
    intent.preflightWalletAllowanceUnits,
    intent.preflightWalletNativeBalanceWei,
    intent.preflightEthereumBlockNumber,
    intent.preflightLighterBlockNumber,
    intent.preflightApproveGasLimit,
    intent.preflightDepositGasLimit,
    intent.preflightMaxFeePerGasWei,
    intent.preflightMaxPriorityFeePerGasWei,
    intent.preflightApproveMaxFeeWei,
    intent.preflightDepositMaxFeeWei,
    intent.preflightTotalMaxFeeWei,
    intent.preflightNativeReserveWei,
    intent.preflightRequiredNativeBalanceWei,
  ];
  if (!integerFields.every((value) => /^(?:0|[1-9][0-9]*)$/.test(value))) return false;
  const amount = BigInt(intent.amountUnits);
  const allowance = BigInt(intent.preflightWalletAllowanceUnits);
  const nativeBalance = BigInt(intent.preflightWalletNativeBalanceWei);
  const approveGasLimit = BigInt(intent.preflightApproveGasLimit);
  const depositGasLimit = BigInt(intent.preflightDepositGasLimit);
  const maxFeePerGas = BigInt(intent.preflightMaxFeePerGasWei);
  const maxPriorityFeePerGas = BigInt(intent.preflightMaxPriorityFeePerGasWei);
  const approveMaxFee = BigInt(intent.preflightApproveMaxFeeWei);
  const depositMaxFee = BigInt(intent.preflightDepositMaxFeeWei);
  const totalMaxFee = BigInt(intent.preflightTotalMaxFeeWei);
  const nativeReserve = BigInt(intent.preflightNativeReserveWei);
  const requiredNativeBalance = BigInt(intent.preflightRequiredNativeBalanceWei);
  return amount > 0n
    && BigInt(intent.preflightMinimumTransferUnits) > 0n
    && BigInt(intent.preflightMinimumTransferUnits) <= amount
    && BigInt(intent.preflightWalletBalanceUnits) >= amount
    && allowance >= 0n
    && nativeBalance > 0n
    && BigInt(intent.preflightEthereumBlockNumber) > 0n
    && BigInt(intent.preflightLighterBlockNumber) >= 0n
    && (allowance < amount ? approveGasLimit > 0n : approveGasLimit === 0n)
    && depositGasLimit > 0n
    && maxFeePerGas > 0n
    && maxPriorityFeePerGas >= 0n
    && maxPriorityFeePerGas <= maxFeePerGas
    && approveMaxFee === approveGasLimit * maxFeePerGas
    && depositMaxFee === depositGasLimit * maxFeePerGas
    && totalMaxFee === approveMaxFee + depositMaxFee
    && nativeReserve === (approveMaxFee > depositMaxFee ? approveMaxFee : depositMaxFee)
    && requiredNativeBalance === totalMaxFee + nativeReserve
    && nativeBalance >= requiredNativeBalance
    && Number.isFinite(intent.preflightObservedAt.getTime());
}
