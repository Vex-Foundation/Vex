/**
 * Orchestration for an approved Lighter deposit (approve -> deposit -> credited).
 *
 * The real signing/broadcast, allowance check, receipt confirmation, and
 * account-index resolution are INJECTED so this orchestration — the gate check,
 * leg ordering, durable lifecycle marks, and ambiguity handling — is fully
 * unit-testable without funds, while the live EVM signing is exercised only in a
 * gated live run. It holds no keys. It never retries a broadcast: an
 * unconfirmed leg becomes `ambiguous` and stops for explicit reconciliation.
 *
 * Order of operations mirrors the order path: gate first, then each fund-moving
 * leg persists its tx hash BEFORE broadcast (staged-broadcast doctrine).
 */

import { buildLighterDepositCalldata } from "./deposit-calldata.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";

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

export type ReceiptOutcome = "confirmed" | "reverted" | "ambiguous";

export interface LighterDepositExecutionDeps {
  /** The privileged default-closed deposit release gate. */
  readonly depositGateEnabled: () => boolean;
  /**
   * Ensure the deposit contract can pull `amountUnits` of the settlement token.
   * Returns the approve tx hash, or null when allowance already suffices.
   * Persists the hash before broadcast and confirms it internally.
   */
  readonly ensureAllowance: (input: {
    readonly walletAddress: string;
    readonly spender: string;
    readonly amountUnits: bigint;
  }) => Promise<{ readonly approveTxHash: string | null }>;
  /** Sign+broadcast the deposit; returns its tx hash after durable staging. */
  readonly sendDeposit: (input: {
    readonly walletAddress: string;
    readonly to: string;
    readonly data: string;
  }) => Promise<{ readonly depositTxHash: string }>;
  readonly confirmReceipt: (txHash: string) => Promise<ReceiptOutcome>;
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

  // Leg 1: approval (only if allowance is short).
  let approveTxHash: string | null = null;
  try {
    const { approveTxHash: hash } = await deps.ensureAllowance({
      walletAddress: intent.walletAddress,
      spender: intent.depositContract,
      amountUnits,
    });
    approveTxHash = hash;
    if (hash !== null) {
      await deps.intents.markApproveSubmitted(intent.intentId, hash);
      const outcome = await deps.confirmReceipt(hash);
      if (outcome === "reverted") {
        await deps.intents.markFailed(intent.intentId, "Settlement-asset approval reverted on chain.");
        return { status: "failed", stage: "approve", reason: "Settlement-asset approval reverted on chain." };
      }
      if (outcome === "ambiguous") {
        await deps.intents.markAmbiguous(intent.intentId, "Approval broadcast outcome is unconfirmed.");
        return { status: "ambiguous", stage: "approve", txHash: hash, reason: "Approval broadcast outcome is unconfirmed." };
      }
      await deps.intents.markApproveConfirmed(intent.intentId);
    } else {
      // Allowance already sufficient — advance through the approve states so the
      // deposit leg's precondition (approve_confirmed) holds.
      await deps.intents.markApproveConfirmed(intent.intentId);
    }
  } catch (err) {
    const reason = errText(err);
    await deps.intents.markAmbiguous(intent.intentId, `Approval leg error: ${reason}`);
    return { status: "ambiguous", stage: "approve", txHash: approveTxHash, reason };
  }

  // Leg 2: deposit.
  let depositTxHash: string;
  try {
    const sent = await deps.sendDeposit({
      walletAddress: intent.walletAddress,
      to: calldata.to,
      data: calldata.data,
    });
    depositTxHash = sent.depositTxHash;
    await deps.intents.markDepositSubmitted(intent.intentId, depositTxHash);
  } catch (err) {
    const reason = errText(err);
    await deps.intents.markFailed(intent.intentId, `Deposit sign/stage failed pre-broadcast: ${reason}`);
    return { status: "failed", stage: "deposit", reason };
  }

  const outcome = await deps.confirmReceipt(depositTxHash);
  if (outcome === "reverted") {
    await deps.intents.markFailed(intent.intentId, "Deposit transaction reverted on chain.");
    return { status: "failed", stage: "deposit", reason: "Deposit transaction reverted on chain." };
  }
  if (outcome === "ambiguous") {
    await deps.intents.markAmbiguous(intent.intentId, "Deposit broadcast outcome is unconfirmed.");
    return { status: "ambiguous", stage: "deposit", txHash: depositTxHash, reason: "Deposit broadcast outcome is unconfirmed." };
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
