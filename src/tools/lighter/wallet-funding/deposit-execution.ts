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
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";

export type LegOutcome = "confirmed" | "reverted" | "ambiguous";

export type LighterDepositExecutionResult =
  | { readonly status: "gate_closed"; readonly reason: string }
  | {
      readonly status: "credited";
      readonly approveTxHash: string | null;
      readonly depositTxHash: string;
      readonly resolvedAccountIndex: number | null;
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
    | { readonly skipped: false; readonly txHash: string; readonly outcome: LegOutcome; readonly reason?: string }
  >;
  /** Sign, stage (onHashStaged before broadcast), broadcast, and confirm the deposit. */
  readonly runDepositLeg: (input: {
    readonly walletAddress: string;
    readonly to: string;
    readonly data: string;
    readonly onHashStaged: (txHash: string) => Promise<void>;
  }) => Promise<{ readonly txHash: string; readonly outcome: LegOutcome; readonly reason?: string }>;
  /** Resolve the account index Lighter credited after the deposit settles. */
  readonly resolveAccountIndex: (walletAddress: string) => Promise<number | null>;
  readonly intents: {
    markApproveSubmitted(intentId: string, hash: string): Promise<unknown>;
    markApproveConfirmed(intentId: string): Promise<unknown>;
    markDepositSubmitted(intentId: string, hash: string): Promise<unknown>;
    markDepositConfirmed(intentId: string): Promise<unknown>;
    markCredited(intentId: string, accountIndex: number): Promise<unknown>;
    markAmbiguous(intentId: string, reason: string): Promise<unknown>;
    markFailed(intentId: string, reason: string): Promise<unknown>;
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

  if (
    intent.capability !== "deposit"
    || intent.amountUnits === null
    || intent.depositTo === null
    || intent.depositContract === null
  ) {
    return { status: "failed", stage: "approve", reason: "Deposit intent is missing required fields." };
  }

  const amountUnits = BigInt(intent.amountUnits);
  // Rebuild calldata from the persisted intent; validates recipient/amount/index.
  const calldata = buildLighterDepositCalldata({
    to: intent.depositTo,
    amountUnits,
    route: intent.routeType === 1 ? "spot" : "perps",
    assetIndex: intent.assetIndex ?? undefined,
  });

  // Leg 1: approval (only if allowance is short). Hash persists before broadcast.
  let approveTxHash: string | null = null;
  try {
    const approve = await deps.runApproveLegIfNeeded({
      walletAddress: intent.walletAddress,
      spender: intent.depositContract,
      amountUnits,
      onHashStaged: async (hash) => {
        await deps.intents.markApproveSubmitted(intent.intentId, hash);
      },
    });
    if (!approve.skipped) {
      approveTxHash = approve.txHash;
      if (approve.outcome === "reverted") {
        const reason = approve.reason ?? "Settlement-asset approval reverted on chain.";
        await deps.intents.markFailed(intent.intentId, reason);
        return { status: "failed", stage: "approve", reason };
      }
      if (approve.outcome === "ambiguous") {
        const reason = approve.reason ?? "Approval broadcast outcome is unconfirmed.";
        await deps.intents.markAmbiguous(intent.intentId, reason);
        return { status: "ambiguous", stage: "approve", txHash: approve.txHash, reason };
      }
    }
    await deps.intents.markApproveConfirmed(intent.intentId);
  } catch (err) {
    const reason = errText(err);
    await deps.intents.markAmbiguous(intent.intentId, `Approval leg error: ${reason}`);
    return { status: "ambiguous", stage: "approve", txHash: approveTxHash, reason };
  }

  // Leg 2: deposit. Hash persists before broadcast.
  let depositTxHash: string;
  try {
    const deposit = await deps.runDepositLeg({
      walletAddress: intent.walletAddress,
      to: calldata.to,
      data: calldata.data,
      onHashStaged: async (hash) => {
        await deps.intents.markDepositSubmitted(intent.intentId, hash);
      },
    });
    depositTxHash = deposit.txHash;
    if (deposit.outcome === "reverted") {
      const reason = deposit.reason ?? "Deposit transaction reverted on chain.";
      await deps.intents.markFailed(intent.intentId, reason);
      return { status: "failed", stage: "deposit", reason };
    }
    if (deposit.outcome === "ambiguous") {
      const reason = deposit.reason ?? "Deposit broadcast outcome is unconfirmed.";
      await deps.intents.markAmbiguous(intent.intentId, reason);
      return { status: "ambiguous", stage: "deposit", txHash: deposit.txHash, reason };
    }
  } catch (err) {
    // A throw from runDepositLeg is a sign/stage failure — nothing broadcast.
    const reason = errText(err);
    await deps.intents.markFailed(intent.intentId, `Deposit sign/stage failed pre-broadcast: ${reason}`);
    return { status: "failed", stage: "deposit", reason };
  }

  await deps.intents.markDepositConfirmed(intent.intentId);

  // The deposit is on-chain; L2 crediting is asynchronous, so a null index is
  // not a failure — the account index may resolve on a later status check.
  const resolvedAccountIndex = await deps.resolveAccountIndex(intent.walletAddress).catch(() => null);
  if (resolvedAccountIndex !== null) {
    await deps.intents.markCredited(intent.intentId, resolvedAccountIndex);
  }

  return { status: "credited", approveTxHash, depositTxHash, resolvedAccountIndex };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
