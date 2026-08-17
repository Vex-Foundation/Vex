/**
 * Orchestration for an approved Lighter deposit (approve -> deposit -> credited).
 *
 * Each fund-moving leg is INJECTED as a runner that signs, stages its tx hash
 * BEFORE broadcast (via the `onHashStaged` callback this orchestration supplies,
 * so the durable mark lands before the send), broadcasts, and returns the
 * confirmed/reverted/ambiguous outcome. That keeps the orchestration — gate
 * check, leg ordering, lifecycle marks, ambiguity handling — fully unit-testable
 * without funds, while the live EVM signing runs only behind the gate. It holds
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
import {
  LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS,
  LIGHTER_CORE_MAINNET_USDC_ADDRESS,
  LIGHTER_DEPOSIT_CHAIN_ID,
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
  LIGHTER_USDC_ASSET_INDEX,
} from "./constants.js";

export type LegOutcome = "confirmed" | "reverted" | "ambiguous";

export type LighterDepositExecutionResult =
  | { readonly status: "gate_closed"; readonly reason: string }
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
  /** The privileged default-closed deposit release gate. */
  readonly depositGateEnabled: () => boolean;
  /** Independent code boundary: live fee preflight must be implemented first. */
  readonly depositFeePreflightComplete: () => boolean;
  /** Re-prove the cross-process chain-wallet execution lease before each leg. */
  readonly assertExecutionLease: () => Promise<void>;
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
    readonly onHashStaged: (txHash: string) => Promise<void>;
  }) => Promise<
    | { readonly skipped: true }
    | {
        readonly skipped: false;
        readonly txHash: string;
        readonly outcome: LegOutcome;
        readonly confirmedBlockNumber?: bigint;
        readonly reason?: string;
      }
  >;
  /** Sign, stage (onHashStaged before broadcast), broadcast, and confirm the deposit. */
  readonly runDepositLeg: (input: {
    readonly walletAddress: string;
    readonly to: string;
    readonly data: string;
    readonly confirmedApprovalBlockNumber?: bigint;
    readonly onHashStaged: (txHash: string) => Promise<void>;
  }) => Promise<{
    readonly txHash: string;
    readonly outcome: LegOutcome;
    readonly receipt?: LighterDepositReceipt;
    readonly reason?: string;
  }>;
  readonly intents: {
    markAllowanceVerified(intentId: string): Promise<unknown | null>;
    markApproveSubmitted(intentId: string, hash: string): Promise<unknown | null>;
    markApproveConfirmed(intentId: string): Promise<unknown | null>;
    markDepositSubmitted(intentId: string, hash: string): Promise<unknown | null>;
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

  // Gate first: default-closed, main-process-only. No signing before it opens.
  if (!deps.depositGateEnabled()) {
    return {
      status: "gate_closed",
      reason:
        "Lighter deposit approval was recorded, but live deposits are blocked by the default-closed deposit release gate. Nothing was signed or submitted.",
    };
  }
  if (!deps.depositFeePreflightComplete()) {
    return {
      status: "failed",
      stage: "approve",
      reason:
        "Lighter deposit fee preflight is not complete. Nothing was signed or submitted even though the operator release gate was open.",
    };
  }

  if (
    intent.capability !== "deposit"
    || intent.environment !== "core"
    || intent.chainId !== LIGHTER_DEPOSIT_CHAIN_ID
    || intent.approvalStatus !== "approved"
    || intent.executionState !== "approved"
    || intent.amountUnits === null
    || intent.depositTo === null
    || intent.depositContract === null
    || intent.depositTo.toLowerCase() !== intent.walletAddress.toLowerCase()
    || intent.depositContract.toLowerCase() !== LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS.toLowerCase()
    || intent.assetIndex !== LIGHTER_USDC_ASSET_INDEX
    || intent.routeType !== 0
    || !hasValidPersistedPreflight(intent)
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
      to: intent.depositTo,
      amountUnits,
      route: "perps",
      assetIndex: intent.assetIndex,
    });
  } catch (err) {
    return { status: "failed", stage: "approve", reason: errText(err) };
  }

  // Leg 1: approval (only if allowance is short). Hash persists before broadcast.
  let approveTxHash: string | null = null;
  let confirmedApprovalBlockNumber: bigint | undefined;
  try {
    await deps.assertExecutionLease();
    const approve = await deps.runApproveLegIfNeeded({
      walletAddress: intent.walletAddress,
      spender: intent.depositContract,
      amountUnits,
      onHashStaged: async (hash) => {
        approveTxHash = hash;
        const staged = await tryTransition(() =>
          deps.intents.markApproveSubmitted(intent.intentId, hash));
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
      const confirmed = await tryTransition(() =>
        deps.intents.markApproveConfirmed(intent.intentId));
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
  let depositEvidence: LighterDepositL1Evidence | null = null;
  try {
    await deps.assertExecutionLease();
    const deposit = await deps.runDepositLeg({
      walletAddress: intent.walletAddress,
      to: calldata.to,
      data: calldata.data,
      confirmedApprovalBlockNumber,
      onHashStaged: async (hash) => {
        depositTxHash = hash;
        const staged = await tryTransition(() =>
          deps.intents.markDepositSubmitted(intent.intentId, hash));
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
      txHash: deposit.txHash,
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

function hasValidPersistedPreflight(intent: LighterOnboardingIntentRow): boolean {
  if (
    intent.amountUnits === null
    || intent.settlementTokenAddress?.toLowerCase() !== LIGHTER_CORE_MAINNET_USDC_ADDRESS.toLowerCase()
    || intent.settlementTokenSymbol !== "USDC"
    || intent.settlementTokenDecimals !== LIGHTER_SETTLEMENT_ASSET_DECIMALS
    || intent.preflightMinimumTransferUnits === null
    || intent.preflightWalletBalanceUnits === null
    || intent.preflightWalletAllowanceUnits === null
    || intent.preflightWalletNativeBalanceWei === null
    || intent.preflightEthereumBlockNumber === null
    || intent.preflightLighterBlockNumber === null
    || intent.preflightObservedAt === null
  ) return false;
  const integerFields = [
    intent.amountUnits,
    intent.preflightMinimumTransferUnits,
    intent.preflightWalletBalanceUnits,
    intent.preflightWalletAllowanceUnits,
    intent.preflightWalletNativeBalanceWei,
    intent.preflightEthereumBlockNumber,
    intent.preflightLighterBlockNumber,
  ];
  if (!integerFields.every((value) => /^(?:0|[1-9][0-9]*)$/.test(value))) return false;
  const amount = BigInt(intent.amountUnits);
  return amount > 0n
    && BigInt(intent.preflightMinimumTransferUnits) > 0n
    && BigInt(intent.preflightMinimumTransferUnits) <= amount
    && BigInt(intent.preflightWalletBalanceUnits) >= amount
    && BigInt(intent.preflightWalletAllowanceUnits) >= 0n
    && BigInt(intent.preflightWalletNativeBalanceWei) > 0n
    && BigInt(intent.preflightEthereumBlockNumber) > 0n
    && BigInt(intent.preflightLighterBlockNumber) >= 0n
    && Number.isFinite(intent.preflightObservedAt.getTime());
}
