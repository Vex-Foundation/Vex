/**
 * Evidence-only repair for unresolved Lighter Core deposit intents.
 *
 * This module has no signer, wallet client, send, retry, or replacement path.
 * It reads already-staged Ethereum transaction hashes and public Lighter account
 * state, then advances local state through hash-bound CAS updates under the
 * owning session's control lock. A missing receipt remains pending; an RPC
 * failure is surfaced as an error and is never converted into a verdict.
 */

import type { PoolClient } from "pg";

import * as intentsRepo from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import { buildLighterOnboardingReaders } from "@tools/lighter/wallet-funding/onboarding-readers.js";
import { LIGHTER_DEPOSIT_CHAIN_ID } from "@tools/lighter/wallet-funding/constants.js";

export type LighterDepositRepairResolution =
  | "awaiting_approval"
  | "awaiting_chain"
  | "awaiting_lighter"
  | "approve_confirmed"
  | "deposit_confirmed"
  | "credited"
  | "failed"
  | "manual_review"
  | "terminal"
  | "superseded";

export interface LighterDepositRepairReport {
  readonly intentId: string;
  readonly stateBefore: string;
  readonly stateAfter: string;
  readonly resolution: LighterDepositRepairResolution;
  readonly evidence: "none" | "ethereum_receipt" | "lighter_account";
  readonly txHash: string | null;
  readonly accountIndex: number | null;
  readonly guidance: string;
}

export interface LighterDepositRepairSweepReport {
  readonly examined: number;
  readonly advanced: number;
  readonly awaiting: number;
  readonly failed: number;
  readonly errors: number;
  readonly reports: readonly LighterDepositRepairReport[];
}

type ReceiptStatus = "success" | "reverted";

export interface LighterDepositRepairDeps {
  readonly listUnresolved: () => Promise<LighterOnboardingIntentRow[]>;
  readonly readReceipt: (txHash: string) => Promise<ReceiptStatus | null>;
  readonly readAccountIndex: (walletAddress: string) => Promise<number | null>;
  readonly reconcileApproveReceipt: (
    intent: LighterOnboardingIntentRow,
    txHash: string,
    outcome: "confirmed" | "reverted",
  ) => Promise<LighterOnboardingIntentRow | null>;
  readonly reconcileDepositReceipt: (
    intent: LighterOnboardingIntentRow,
    txHash: string,
    outcome: "confirmed" | "reverted",
  ) => Promise<LighterOnboardingIntentRow | null>;
  readonly reconcileCredited: (
    intent: LighterOnboardingIntentRow,
    txHash: string,
    accountIndex: number,
  ) => Promise<LighterOnboardingIntentRow | null>;
}

export function buildProductionLighterDepositRepairDeps(): LighterDepositRepairDeps {
  const deployment = getUniswapDeployment(LIGHTER_DEPOSIT_CHAIN_ID);
  if (!deployment) {
    throw new Error("Ethereum mainnet deployment is not configured for Lighter deposit repair.");
  }
  const publicClient = getUniswapPublicClient(deployment);
  const readers = buildLighterOnboardingReaders();

  return {
    async listUnresolved() {
      return (await intentsRepo.listUnresolved("core")).filter(
        (intent) => intent.capability === "deposit",
      );
    },
    async readReceipt(txHash) {
      assertTxHash(txHash);
      try {
        const receipt = await publicClient.getTransactionReceipt({
          hash: txHash as `0x${string}`,
        });
        return receipt.status;
      } catch (err) {
        if (isReceiptNotFound(err)) return null;
        throw err;
      }
    },
    async readAccountIndex(walletAddress) {
      const account = await readers.readLighterAccount("core", walletAddress);
      return account?.account_index ?? null;
    },
    reconcileApproveReceipt(intent, txHash, outcome) {
      return withIntentSessionLock(intent, (client) =>
        intentsRepo.reconcileApproveReceiptWith(client, {
          intentId: intent.intentId,
          txHash,
          outcome,
        }),
      );
    },
    reconcileDepositReceipt(intent, txHash, outcome) {
      return withIntentSessionLock(intent, (client) =>
        intentsRepo.reconcileDepositReceiptWith(client, {
          intentId: intent.intentId,
          txHash,
          outcome,
        }),
      );
    },
    reconcileCredited(intent, txHash, accountIndex) {
      return withIntentSessionLock(intent, (client) =>
        intentsRepo.reconcileCreditedWith(client, {
          intentId: intent.intentId,
          txHash,
          accountIndex,
        }),
      );
    },
  };
}

export async function repairLighterDepositIntent(
  intent: LighterOnboardingIntentRow,
  deps: LighterDepositRepairDeps,
): Promise<LighterDepositRepairReport> {
  if (intent.capability !== "deposit" || intent.environment !== "core") {
    return report(intent, "manual_review", "none", null, null,
      "The row is not a supported Lighter Core deposit intent; no state was changed.");
  }
  if (intent.executionState === "credited" || intent.executionState === "failed") {
    return report(intent, "terminal", "none", null, intent.resolvedAccountIndex,
      "The deposit intent is already terminal; no repair was needed.");
  }

  if (intent.depositTxHash !== null) {
    return repairDepositLeg(intent, deps);
  }
  if (intent.approveTxHash !== null) {
    return repairApproveLeg(intent, deps);
  }
  if (intent.approvalStatus === "approval_pending") {
    return report(intent, "awaiting_approval", "none", null, null,
      "The deposit is still awaiting the user's approval decision.");
  }
  return report(intent, "manual_review", "none", null, null,
    "No transaction hash was staged. Do not broadcast from repair; inspect the approved intent before deciding whether a fresh preparation is safe.");
}

export async function repairUnresolvedLighterDeposits(
  deps: LighterDepositRepairDeps = buildProductionLighterDepositRepairDeps(),
): Promise<LighterDepositRepairSweepReport> {
  const intents = await deps.listUnresolved();
  const reports: LighterDepositRepairReport[] = [];
  let errors = 0;

  for (const intent of intents) {
    try {
      reports.push(await repairLighterDepositIntent(intent, deps));
    } catch {
      errors += 1;
    }
  }

  const advancedResolutions = new Set<LighterDepositRepairResolution>([
    "approve_confirmed",
    "deposit_confirmed",
    "credited",
    "failed",
  ]);
  const awaitingResolutions = new Set<LighterDepositRepairResolution>([
    "awaiting_approval",
    "awaiting_chain",
    "awaiting_lighter",
    "manual_review",
  ]);
  return {
    examined: intents.length,
    advanced: reports.filter((item) => advancedResolutions.has(item.resolution)).length,
    awaiting: reports.filter((item) => awaitingResolutions.has(item.resolution)).length,
    failed: reports.filter((item) => item.resolution === "failed").length,
    errors,
    reports,
  };
}

async function repairApproveLeg(
  intent: LighterOnboardingIntentRow,
  deps: LighterDepositRepairDeps,
): Promise<LighterDepositRepairReport> {
  const txHash = intent.approveTxHash!;
  if (intent.executionState === "approve_confirmed") {
    return report(intent, "manual_review", "ethereum_receipt", txHash, null,
      "The approval is confirmed but no deposit hash is staged. Repair will never broadcast the missing deposit.");
  }
  const receipt = await deps.readReceipt(txHash);
  if (receipt === null) {
    return report(intent, "awaiting_chain", "none", txHash, null,
      "No Ethereum receipt exists yet. Wait and reconcile again; never rebroadcast the approval.");
  }
  const updated = await deps.reconcileApproveReceipt(
    intent,
    txHash,
    receipt === "success" ? "confirmed" : "reverted",
  );
  if (updated === null) return superseded(intent, txHash);
  return report(
    updated,
    receipt === "success" ? "approve_confirmed" : "failed",
    "ethereum_receipt",
    txHash,
    null,
    receipt === "success"
      ? "Ethereum proves the approval confirmed. No deposit was broadcast by repair."
      : "Ethereum proves the approval reverted. The intent is terminally failed.",
    intent.executionState,
  );
}

async function repairDepositLeg(
  intent: LighterOnboardingIntentRow,
  deps: LighterDepositRepairDeps,
): Promise<LighterDepositRepairReport> {
  const txHash = intent.depositTxHash!;
  let confirmed = intent;
  if (intent.executionState !== "deposit_confirmed") {
    const receipt = await deps.readReceipt(txHash);
    if (receipt === null) {
      return report(intent, "awaiting_chain", "none", txHash, null,
        "No Ethereum receipt exists yet. Wait and reconcile again; never rebroadcast the deposit.");
    }
    const updated = await deps.reconcileDepositReceipt(
      intent,
      txHash,
      receipt === "success" ? "confirmed" : "reverted",
    );
    if (updated === null) return superseded(intent, txHash);
    if (receipt === "reverted") {
      return report(updated, "failed", "ethereum_receipt", txHash, null,
        "Ethereum proves the deposit reverted. The intent is terminally failed.", intent.executionState);
    }
    confirmed = updated;
  }

  const accountIndex = await deps.readAccountIndex(intent.walletAddress);
  if (accountIndex === null) {
    return report(confirmed, "awaiting_lighter", "ethereum_receipt", txHash, null,
      "Ethereum confirms the deposit, but Lighter has not exposed the account credit yet. Wait; do not retry the deposit.", intent.executionState);
  }
  const credited = await deps.reconcileCredited(confirmed, txHash, accountIndex);
  if (credited === null) return superseded(intent, txHash);
  return report(credited, "credited", "lighter_account", txHash, accountIndex,
    "Ethereum confirms the deposit and Lighter exposes the credited account index.", intent.executionState);
}

function report(
  intent: LighterOnboardingIntentRow,
  resolution: LighterDepositRepairResolution,
  evidence: LighterDepositRepairReport["evidence"],
  txHash: string | null,
  accountIndex: number | null,
  guidance: string,
  stateBefore = intent.executionState,
): LighterDepositRepairReport {
  return {
    intentId: intent.intentId,
    stateBefore,
    stateAfter: intent.executionState,
    resolution,
    evidence,
    txHash,
    accountIndex,
    guidance,
  };
}

function superseded(
  intent: LighterOnboardingIntentRow,
  txHash: string,
): LighterDepositRepairReport {
  return report(intent, "superseded", "ethereum_receipt", txHash, null,
    "Another writer changed the intent first. Reload status; repair did not broadcast anything.");
}

function withIntentSessionLock<T>(
  intent: LighterOnboardingIntentRow,
  write: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withSessionControlLock(intent.sessionId, write);
}

function assertTxHash(txHash: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error("Stored Lighter deposit transaction hash is malformed.");
  }
}

function isReceiptNotFound(err: unknown): boolean {
  if (err instanceof Error && err.name === "TransactionReceiptNotFoundError") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /transaction receipt.*(?:not found|could not be found)/i.test(message);
}
