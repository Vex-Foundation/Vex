/**
 * Evidence-only repair for unresolved Lighter Core deposit intents.
 *
 * This module has no signer, wallet client, send, retry, or replacement path.
 * It reads already-staged Ethereum transaction hashes, then advances local state
 * through hash-bound CAS updates under the
 * owning session's control lock. A missing receipt remains pending; an RPC
 * failure is surfaced as an error and is never converted into a verdict.
 */

import type { PoolClient } from "pg";
import { getAddress } from "viem";
import { ErrorCodes, VexError } from "../../errors.js";

import * as intentsRepo from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import { LIGHTER_DEPOSIT_CHAIN_ID } from "@tools/lighter/wallet-funding/constants.js";
import { LighterClient } from "@tools/lighter/client.js";
import type {
  LighterAccountsByL1AddressResponse,
  LighterTxFromL1Response,
} from "@tools/lighter/types.js";
import {
  projectLighterDepositReceipt,
  proveLighterDepositCredit,
  proveLighterDepositL1,
  type LighterDepositCreditEvidence,
  type LighterDepositL1Evidence,
  type LighterDepositReceipt,
} from "@tools/lighter/wallet-funding/deposit-evidence.js";

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
  readonly evidence: "none" | "ethereum_receipt" | "lighter_transaction" | "lighter_account";
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

export interface LighterDepositRepairDeps {
  readonly listUnresolved: () => Promise<LighterOnboardingIntentRow[]>;
  readonly readReceipt: (txHash: string) => Promise<LighterDepositReceipt | null>;
  readonly readLighterTx: (txHash: string) => Promise<LighterTxFromL1Response | null>;
  readonly readOwnedAccounts: (
    walletAddress: string,
  ) => Promise<LighterAccountsByL1AddressResponse>;
  readonly reconcileApproveReceipt: (
    intent: LighterOnboardingIntentRow,
    txHash: string,
    outcome: "confirmed" | "reverted",
  ) => Promise<LighterOnboardingIntentRow | null>;
  readonly reconcileDepositReceipt: (
    intent: LighterOnboardingIntentRow,
    txHash: string,
    outcome: "confirmed" | "reverted",
    evidence?: LighterDepositL1Evidence,
  ) => Promise<LighterOnboardingIntentRow | null>;
  readonly recordConfirmedDepositL1Evidence: (
    intent: LighterOnboardingIntentRow,
    evidence: LighterDepositL1Evidence,
  ) => Promise<LighterOnboardingIntentRow | null>;
  readonly markCredited: (
    intent: LighterOnboardingIntentRow,
    evidence: LighterDepositCreditEvidence,
  ) => Promise<LighterOnboardingIntentRow | null>;
}

export function buildProductionLighterDepositRepairDeps(): LighterDepositRepairDeps {
  const deployment = getUniswapDeployment(LIGHTER_DEPOSIT_CHAIN_ID);
  if (!deployment) {
    throw new Error("Ethereum mainnet deployment is not configured for Lighter deposit repair.");
  }
  const publicClient = getUniswapPublicClient(deployment);
  const lighter = new LighterClient();

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
        return projectLighterDepositReceipt(receipt);
      } catch (err) {
        if (isReceiptNotFound(err)) return null;
        throw err;
      }
    },
    async readLighterTx(txHash) {
      try {
        return await lighter.getTxFromL1("core", { hash: txHash });
      } catch (err) {
        if (isLighterTxNotFound(err)) return null;
        throw err;
      }
    },
    async readOwnedAccounts(walletAddress) {
      let cursor: string | undefined;
      let first: LighterAccountsByL1AddressResponse | null = null;
      const subAccounts: LighterAccountsByL1AddressResponse["sub_accounts"] = [];
      const seenCursors = new Set<string>();
      for (let page = 0; page < 20; page += 1) {
        const response = await lighter.getAccountsByL1Address("core", {
          l1Address: walletAddress,
          cursor,
        });
        if (
          response.code !== 200
          || getAddress(response.l1_address) !== getAddress(walletAddress)
        ) {
          throw new Error("Lighter account page is not bound to the requested wallet.");
        }
        first ??= response;
        subAccounts.push(...response.sub_accounts);
        const next = response.next_cursor?.trim();
        if (!next) return { ...first, sub_accounts: subAccounts, next_cursor: undefined };
        if (seenCursors.has(next)) {
          throw new Error("Lighter account pagination repeated a cursor.");
        }
        seenCursors.add(next);
        cursor = next;
      }
      throw new Error("Lighter account pagination exceeded the bounded 20-page proof limit.");
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
    reconcileDepositReceipt(intent, txHash, outcome, evidence) {
      return withIntentSessionLock(intent, (client) =>
        intentsRepo.reconcileDepositReceiptWith(client, {
          intentId: intent.intentId,
          txHash,
          outcome,
          evidence,
        }),
      );
    },
    recordConfirmedDepositL1Evidence(intent, evidence) {
      return withIntentSessionLock(intent, (client) =>
        intentsRepo.recordConfirmedDepositL1EvidenceWith(
          client,
          intent.intentId,
          evidence,
        ));
    },
    markCredited(intent, evidence) {
      return withIntentSessionLock(intent, (client) =>
        intentsRepo.markDepositCreditedWith(client, intent.intentId, evidence));
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
    receipt.status === "success" ? "confirmed" : "reverted",
  );
  if (updated === null) return superseded(intent, txHash);
  return report(
    updated,
    receipt.status === "success" ? "approve_confirmed" : "failed",
    "ethereum_receipt",
    txHash,
    null,
    receipt.status === "success"
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
  let advancedFromReceipt = false;
  let l1 = l1EvidenceFromIntent(intent);
  if (intent.executionState !== "deposit_confirmed" || l1 === null) {
    const receipt = await deps.readReceipt(txHash);
    if (receipt === null) {
      return report(intent, "awaiting_chain", "none", txHash, null,
        "No Ethereum receipt exists yet. Wait and reconcile again; never rebroadcast the deposit.");
    }
    if (receipt.status === "reverted") {
      const updated = await deps.reconcileDepositReceipt(intent, txHash, "reverted");
      if (updated === null) return superseded(intent, txHash);
      return report(updated, "failed", "ethereum_receipt", txHash, null,
        "Ethereum proves the deposit reverted. The intent is terminally failed.", intent.executionState);
    }
    try {
      l1 = proveLighterDepositL1(receipt, expectedDeposit(intent, txHash));
    } catch (err) {
      return report(intent, "manual_review", "ethereum_receipt", txHash, null,
        evidenceErrorGuidance(err));
    }
    if (intent.executionState === "deposit_confirmed") {
      const updated = await deps.recordConfirmedDepositL1Evidence(intent, l1);
      if (updated === null) return superseded(intent, txHash);
      confirmed = updated;
    } else {
      const updated = await deps.reconcileDepositReceipt(intent, txHash, "confirmed", l1);
      if (updated === null) return superseded(intent, txHash);
      confirmed = updated;
      advancedFromReceipt = true;
    }
  }

  const lighterTx = await deps.readLighterTx(txHash);
  if (lighterTx === null || lighterTx.status !== 3 || lighterTx.executed_at <= 0) {
    return report(
      confirmed,
      advancedFromReceipt ? "deposit_confirmed" : "awaiting_lighter",
      "ethereum_receipt",
      txHash,
      l1.accountIndex,
      "Ethereum confirms the deposit, but Lighter has not exposed the exact executed transaction yet. Wait; do not retry the deposit.",
      intent.executionState,
    );
  }

  const accounts = await deps.readOwnedAccounts(intent.walletAddress);
  const candidate = accounts.sub_accounts.filter((account) => account.index === l1.accountIndex);
  if (candidate.length === 0) {
    return report(confirmed, "awaiting_lighter", "lighter_transaction", txHash, l1.accountIndex,
      "Lighter executed the exact deposit, but its account lookup has not exposed the event-selected account yet. Wait; do not retry the deposit.", intent.executionState);
  }

  let creditEvidence: LighterDepositCreditEvidence;
  try {
    creditEvidence = proveLighterDepositCredit({ l1, tx: lighterTx, accounts });
  } catch (err) {
    return report(confirmed, "manual_review", "lighter_transaction", txHash, l1.accountIndex,
      evidenceErrorGuidance(err), intent.executionState);
  }
  const credited = await deps.markCredited(confirmed, creditEvidence);
  if (credited === null) return superseded(confirmed, txHash);
  return report(
    credited,
    "credited",
    "lighter_account",
    txHash,
    creditEvidence.accountIndex,
    "The exact Ethereum deposit, executed Lighter transaction, and wallet-owned master account all match.",
    intent.executionState,
  );
}

function expectedDeposit(intent: LighterOnboardingIntentRow, txHash: string) {
  if (
    intent.depositContract === null
    || intent.depositTo === null
    || intent.assetIndex === null
    || intent.routeType === null
    || intent.amountUnits === null
    || !/^[1-9][0-9]*$/.test(intent.amountUnits)
  ) {
    throw new Error("Stored Lighter deposit intent is incomplete.");
  }
  return {
    txHash,
    gatewayAddress: intent.depositContract,
    walletAddress: intent.walletAddress,
    recipientAddress: intent.depositTo,
    assetIndex: intent.assetIndex,
    routeType: intent.routeType,
    amountUnits: BigInt(intent.amountUnits),
  };
}

function l1EvidenceFromIntent(
  intent: LighterOnboardingIntentRow,
): LighterDepositL1Evidence | null {
  if (
    intent.depositTxHash === null
    || intent.depositL1BlockHash === null
    || intent.depositL1BlockNumber === null
    || intent.depositEventAccountIndex === null
    || intent.amountUnits === null
    || intent.assetIndex === null
    || intent.routeType === null
  ) return null;
  return {
    txHash: intent.depositTxHash,
    blockHash: intent.depositL1BlockHash,
    blockNumber: intent.depositL1BlockNumber,
    accountIndex: intent.depositEventAccountIndex,
    walletAddress: intent.walletAddress,
    assetIndex: intent.assetIndex,
    routeType: intent.routeType,
    amountUnits: intent.amountUnits,
  };
}

function evidenceErrorGuidance(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Deposit evidence did not match the approved intent: ${detail} Do not retry or register a key automatically; inspect the exact transaction.`;
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

function isLighterTxNotFound(err: unknown): boolean {
  return err instanceof VexError
    && err.code === ErrorCodes.LIGHTER_INVALID_REQUEST
    && err.httpStatus === 400
    && /transaction not found/i.test(err.message);
}
