/**
 * Evidence-only repair for unresolved, environment-bound Lighter deposit intents.
 *
 * This module has no signer, wallet client, send, or retry-broadcast path.
 * It reads already-staged settlement-chain transaction identities, accepts only exact
 * fee-only repricings, then advances local state
 * through hash-bound CAS updates under the
 * owning session's control lock. A missing receipt remains pending; an RPC
 * failure is surfaced as an error and is never converted into a verdict.
 */

import type { PoolClient } from "pg";
import { getAddress } from "viem";
import { ErrorCodes, VexError } from "../../errors.js";

import * as intentsRepo from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import {
  effectiveApproveTxHash,
  effectiveDepositTxHash,
  type LighterOnboardingIntentRow,
  type LighterReplacementTransaction,
} from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import { LighterClient } from "@tools/lighter/client.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";
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
import {
  waitForReceiptWithReplacementEvidence,
  type ReceiptReplacementEvidence,
} from "@tools/evm-chains/receipt-guard.js";
import { proveApprovedLighterDepositReplacement } from "@tools/lighter/wallet-funding/deposit-replacement.js";

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
  readonly readReceipt: (intent: LighterOnboardingIntentRow, txHash: string) => Promise<{
    readonly receipt: LighterDepositReceipt;
    readonly replacement: ReceiptReplacementEvidence | null;
  } | null>;
  readonly readLighterTx: (
    intent: LighterOnboardingIntentRow,
    txHash: string,
  ) => Promise<LighterTxFromL1Response | null>;
  readonly readOwnedAccounts: (
    intent: LighterOnboardingIntentRow,
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
  readonly recordApproveReplacement: (
    intent: LighterOnboardingIntentRow,
    replacement: LighterReplacementTransaction,
  ) => Promise<LighterOnboardingIntentRow | null>;
  readonly recordDepositReplacement: (
    intent: LighterOnboardingIntentRow,
    replacement: LighterReplacementTransaction,
  ) => Promise<LighterOnboardingIntentRow | null>;
  readonly reconcileConfirmedDepositL1Evidence: (
    intent: LighterOnboardingIntentRow,
    evidence: LighterDepositL1Evidence,
  ) => Promise<LighterOnboardingIntentRow | null>;
  readonly markAmbiguous: (
    intent: LighterOnboardingIntentRow,
    reason: string,
  ) => Promise<LighterOnboardingIntentRow | null>;
  readonly markCredited: (
    intent: LighterOnboardingIntentRow,
    evidence: LighterDepositCreditEvidence,
  ) => Promise<LighterOnboardingIntentRow | null>;
}

export function buildProductionLighterDepositRepairDeps(): LighterDepositRepairDeps {
  const lighter = new LighterClient();
  const publicClients = new Map<"core" | "rhc", ReturnType<typeof getUniswapPublicClient>>();

  function publicClientFor(intent: LighterOnboardingIntentRow) {
    const funding = assertSupportedDepositIdentity(intent);
    const cached = publicClients.get(intent.environment);
    if (cached !== undefined) return cached;
    const deployment = getUniswapDeployment(funding.settlementChainId);
    if (!deployment || deployment.chainId !== funding.settlementChainId) {
      throw new Error(`${funding.settlementNetworkName} is not configured for Lighter deposit repair.`);
    }
    const client = getUniswapPublicClient(deployment);
    publicClients.set(intent.environment, client);
    return client;
  }

  return {
    async listUnresolved() {
      const [core, rhc] = await Promise.all([
        intentsRepo.listUnresolved("core"),
        intentsRepo.listUnresolved("rhc"),
      ]);
      return [...core, ...rhc]
        .filter((intent) => intent.capability === "deposit")
        .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime());
    },
    async readReceipt(intent, txHash) {
      assertTxHash(txHash);
      const publicClient = publicClientFor(intent);
      try {
        const receipt = await publicClient.getTransactionReceipt({
          hash: txHash as `0x${string}`,
        });
        return { receipt: projectLighterDepositReceipt(receipt), replacement: null };
      } catch (err) {
        if (!isReceiptNotFound(err)) throw err;
      }
      try {
        const read = await waitForReceiptWithReplacementEvidence(
          publicClient,
          txHash as `0x${string}`,
          { attempts: 1, delayMs: 0, timeoutMs: 5_000 },
        );
        return {
          receipt: projectLighterDepositReceipt(read.receipt),
          replacement: read.replacement,
        };
      } catch (err) {
        if (isReceiptUnavailable(err)) return null;
        throw err;
      }
    },
    async readLighterTx(intent, txHash) {
      assertSupportedDepositIdentity(intent);
      try {
        return await lighter.getTxFromL1(intent.environment, { hash: txHash });
      } catch (err) {
        if (isLighterTxNotFound(err)) return null;
        throw err;
      }
    },
    async readOwnedAccounts(intent, walletAddress) {
      assertSupportedDepositIdentity(intent);
      let cursor: string | undefined;
      let first: LighterAccountsByL1AddressResponse | null = null;
      const subAccounts: LighterAccountsByL1AddressResponse["sub_accounts"] = [];
      const seenCursors = new Set<string>();
      for (let page = 0; page < 20; page += 1) {
        const response = await lighter.getAccountsByL1Address(intent.environment, {
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
    recordApproveReplacement(intent, replacement) {
      return withIntentSessionLock(intent, (client) =>
        intentsRepo.recordApproveReplacementWith(client, intent.intentId, replacement));
    },
    recordDepositReplacement(intent, replacement) {
      return withIntentSessionLock(intent, (client) =>
        intentsRepo.recordDepositReplacementWith(client, intent.intentId, replacement));
    },
    reconcileConfirmedDepositL1Evidence(intent, evidence) {
      return withIntentSessionLock(intent, (client) =>
        intentsRepo.reconcileConfirmedDepositL1EvidenceWith(client, intent.intentId, evidence));
    },
    markAmbiguous(intent, reason) {
      return withIntentSessionLock(intent, (client) =>
        intentsRepo.markAmbiguousWith(client, intent.intentId, reason));
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
  try {
    assertSupportedDepositIdentity(intent);
  } catch (err) {
    return report(intent, "manual_review", "none", null, null,
      `The row is not a supported environment-bound Lighter deposit intent: ${errorText(err)} No state was changed.`);
  }
  if (intent.executionState === "credited" || intent.executionState === "failed") {
    return report(intent, "terminal", "none", null, intent.resolvedAccountIndex,
      "The deposit intent is already terminal; no repair was needed.");
  }

  if (effectiveDepositTxHash(intent) !== null) {
    return repairDepositLeg(intent, deps);
  }
  if (effectiveApproveTxHash(intent) !== null) {
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
  let current = intent;
  let txHash = effectiveApproveTxHash(current)!;
  if (intent.executionState === "approve_confirmed") {
    return report(intent, "manual_review", "ethereum_receipt", txHash, null,
      "The approval is confirmed but no deposit hash is staged. Repair will never broadcast the missing deposit.");
  }
  const read = await deps.readReceipt(current, txHash);
  if (read === null) {
    return report(intent, "awaiting_chain", "none", txHash, null,
      "No settlement-chain receipt exists yet. Wait and reconcile again; never rebroadcast the approval.");
  }
  if (read.replacement !== null) {
    let replacement: LighterReplacementTransaction;
    try {
      replacement = proveApprovedLighterDepositReplacement({
        intent: current,
        stage: "approve",
        replacement: read.replacement,
      });
    } catch (err) {
      return markManualReview(
        current,
        deps,
        txHash,
        `The settlement chain reported an unsafe approval replacement: ${errorText(err)}`,
      );
    }
    const updated = await deps.recordApproveReplacement(current, replacement);
    if (updated === null) return superseded(current, txHash);
    current = updated;
    txHash = replacement.replacementTxHash;
  }
  if (read.receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
    return markManualReview(
      current,
      deps,
      txHash,
      "The settlement chain returned an approval receipt for a different transaction hash.",
    );
  }
  const updated = await deps.reconcileApproveReceipt(
    current,
    txHash,
    read.receipt.status === "success" ? "confirmed" : "reverted",
  );
  if (updated === null) return superseded(intent, txHash);
  return report(
    updated,
    read.receipt.status === "success" ? "approve_confirmed" : "failed",
    "ethereum_receipt",
    txHash,
    null,
    read.receipt.status === "success"
      ? "The settlement chain proves the approval confirmed. No deposit was broadcast by repair."
      : "The settlement chain proves the approval reverted. The intent is terminally failed.",
    intent.executionState,
  );
}

async function repairDepositLeg(
  intent: LighterOnboardingIntentRow,
  deps: LighterDepositRepairDeps,
): Promise<LighterDepositRepairReport> {
  let current = intent;
  let txHash = effectiveDepositTxHash(current)!;
  let confirmed = current;
  let advancedFromReceipt = false;
  const priorL1 = l1EvidenceFromIntent(current);
  const read = await deps.readReceipt(current, txHash);
  if (read === null) {
    if (current.executionState === "deposit_confirmed" && priorL1 !== null) {
      return markManualReview(
        current,
        deps,
        txHash,
        "The previously confirmed settlement receipt is no longer canonical. Lighter credit is blocked until the exact transaction is proven again.",
        "none",
      );
    }
    return report(current, "awaiting_chain", "none", txHash, null,
      "No settlement-chain receipt exists yet. Wait and reconcile again; never rebroadcast the deposit.");
  }
  if (read.replacement !== null) {
    let replacement: LighterReplacementTransaction;
    try {
      replacement = proveApprovedLighterDepositReplacement({
        intent: current,
        stage: "deposit",
        replacement: read.replacement,
      });
    } catch (err) {
      return markManualReview(
        current,
        deps,
        txHash,
        `The settlement chain reported an unsafe deposit replacement: ${errorText(err)}`,
      );
    }
    const updated = await deps.recordDepositReplacement(current, replacement);
    if (updated === null) return superseded(current, txHash);
    current = updated;
    confirmed = updated;
    txHash = replacement.replacementTxHash;
  }
  if (read.receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
    return markManualReview(
      current,
      deps,
      txHash,
      "The settlement chain returned a deposit receipt for a different transaction hash.",
    );
  }
  if (read.receipt.status === "reverted") {
    if (current.executionState === "deposit_confirmed") {
      return markManualReview(
        current,
        deps,
        txHash,
        "The canonical settlement receipt now proves a revert after an earlier confirmation. Automatic Lighter credit is blocked.",
      );
    }
    const updated = await deps.reconcileDepositReceipt(current, txHash, "reverted");
    if (updated === null) return superseded(current, txHash);
    return report(updated, "failed", "ethereum_receipt", txHash, null,
      "The settlement chain proves the deposit reverted. The intent is terminally failed.", intent.executionState);
  }

  let l1: LighterDepositL1Evidence;
  try {
    l1 = proveLighterDepositL1(read.receipt, expectedDeposit(current, txHash));
  } catch (err) {
    return markManualReview(current, deps, txHash, evidenceErrorGuidance(err));
  }
  if (current.executionState === "deposit_confirmed") {
    if (priorL1 === null || !sameL1Evidence(priorL1, l1)) {
      const updated = await deps.reconcileConfirmedDepositL1Evidence(current, l1);
      if (updated === null) return superseded(current, txHash);
      confirmed = updated;
    }
  } else {
    const updated = await deps.reconcileDepositReceipt(current, txHash, "confirmed", l1);
    if (updated === null) return superseded(current, txHash);
    confirmed = updated;
    advancedFromReceipt = true;
  }

  const lighterTx = await deps.readLighterTx(confirmed, txHash);
  if (lighterTx === null || lighterTx.status !== 3 || lighterTx.executed_at <= 0) {
    return report(
      confirmed,
      advancedFromReceipt ? "deposit_confirmed" : "awaiting_lighter",
      "ethereum_receipt",
      txHash,
      l1.accountIndex,
      "The settlement chain confirms the deposit, but Lighter has not exposed the exact executed transaction yet. Wait; do not retry the deposit.",
      intent.executionState,
    );
  }

  const accounts = await deps.readOwnedAccounts(confirmed, intent.walletAddress);
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
    "The exact settlement deposit, executed Lighter transaction, and wallet-owned master account all match.",
    intent.executionState,
  );
}

function expectedDeposit(intent: LighterOnboardingIntentRow, txHash: string) {
  assertSupportedDepositIdentity(intent);
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

function assertSupportedDepositIdentity(intent: LighterOnboardingIntentRow) {
  const funding = getLighterFundingDeployment(intent.environment);
  if (
    intent.capability !== "deposit"
    || intent.chainId !== funding.settlementChainId
    || intent.depositContract === null
    || getAddress(intent.depositContract) !== funding.gatewayProxy
    || intent.depositTo === null
    || getAddress(intent.depositTo) !== getAddress(intent.walletAddress)
    || intent.assetIndex !== funding.settlementAssetIndex
    || intent.routeType !== funding.perpsRouteType
  ) {
    throw new Error("stored chain, gateway, beneficiary, asset, or route identity is invalid.");
  }
  return funding;
}

function l1EvidenceFromIntent(
  intent: LighterOnboardingIntentRow,
): LighterDepositL1Evidence | null {
  if (
    effectiveDepositTxHash(intent) === null
    || intent.depositL1BlockHash === null
    || intent.depositL1BlockNumber === null
    || intent.depositEventAccountIndex === null
    || intent.amountUnits === null
    || intent.assetIndex === null
    || intent.routeType === null
  ) return null;
  return {
    txHash: effectiveDepositTxHash(intent)!,
    blockHash: intent.depositL1BlockHash,
    blockNumber: intent.depositL1BlockNumber,
    accountIndex: intent.depositEventAccountIndex,
    walletAddress: intent.walletAddress,
    assetIndex: intent.assetIndex,
    routeType: intent.routeType,
    amountUnits: intent.amountUnits,
  };
}

function sameL1Evidence(
  left: LighterDepositL1Evidence,
  right: LighterDepositL1Evidence,
): boolean {
  return left.txHash.toLowerCase() === right.txHash.toLowerCase()
    && left.blockHash.toLowerCase() === right.blockHash.toLowerCase()
    && left.blockNumber === right.blockNumber
    && left.accountIndex === right.accountIndex
    && left.walletAddress.toLowerCase() === right.walletAddress.toLowerCase()
    && left.assetIndex === right.assetIndex
    && left.routeType === right.routeType
    && left.amountUnits === right.amountUnits;
}

async function markManualReview(
  intent: LighterOnboardingIntentRow,
  deps: LighterDepositRepairDeps,
  txHash: string,
  reason: string,
  evidence: LighterDepositRepairReport["evidence"] = "ethereum_receipt",
): Promise<LighterDepositRepairReport> {
  const updated = await deps.markAmbiguous(intent, reason);
  return report(
    updated ?? intent,
    "manual_review",
    evidence,
    txHash,
    intent.depositEventAccountIndex,
    updated === null
      ? `${reason} The durable ambiguous state could not be recorded.`
      : reason,
    intent.executionState,
  );
}

function evidenceErrorGuidance(err: unknown): string {
  const detail = errorText(err);
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

function isReceiptUnavailable(err: unknown): boolean {
  if (isReceiptNotFound(err)) return true;
  if (
    err instanceof Error
    && (
      err.name === "WaitForTransactionReceiptTimeoutError"
      || err.name === "TransactionNotFoundError"
    )
  ) return true;
  return /timed out while waiting for transaction|transaction .* not found/i.test(errorText(err));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isLighterTxNotFound(err: unknown): boolean {
  return err instanceof VexError
    && err.code === ErrorCodes.LIGHTER_INVALID_REQUEST
    && err.httpStatus === 400
    && /transaction not found/i.test(err.message);
}
