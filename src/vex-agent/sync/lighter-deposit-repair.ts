/**
 * Evidence-only repair for unresolved, environment-bound Lighter deposit intents.
 *
 * This module has no signer, wallet client, send, or retry-broadcast path.
 * It reads already-staged settlement-chain transaction identities, accepts only exact
 * fee-only repricings, then advances local state
 * through hash-bound CAS updates under the
 * owning session's control lock. A missing receipt remains pending; an RPC
 * failure is surfaced as an error and is never converted into a verdict.
 *
 * THE CREDIT AND ITS ACTIVITY ROW COMMIT TOGETHER. When a deposit is proven
 * credited, the durable `agent_activity` row for the settlement transaction is
 * written inside the SAME transaction as `markDepositCreditedWith`, under the
 * same session control lock. That is the only ordering with no window in it:
 *
 *   - written first and committed separately, the row could exist for a credit
 *     that never lands;
 *   - written after and committed separately, a crash between the two leaves a
 *     credited deposit with no record, and no sweep would ever come back for
 *     it, because the intent is terminal.
 *
 * So a failing INSERT rolls the credit back with it. The deposit stays
 * `deposit_confirmed`, which is exactly what the unresolved-deposit queue
 * selects, and the next sweep re-examines it from the same evidence and
 * credits it again with its row. An unknown outcome stays reconcilable rather
 * than being converted into a verdict, which is the same rule this module
 * applies to the chain.
 *
 * A deposit Vex did not sign (no recorded sender or nonce) has no valid shape
 * in `agent_activity` at all - see `settlement-proven.ts` - so the credit
 * commits alone and the sweep report names the skipped row and its reason
 * rather than silently recording nothing.
 */

import type { PoolClient } from "pg";
import { getAddress } from "viem";
import { ErrorCodes, VexError } from "../../errors.js";

import * as intentsRepo from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import {
  effectiveApproveTxHash,
  effectiveDepositTxHash,
  type LighterDepositRepairAttemptResult,
  type LighterOnboardingIntentRow,
  type LighterReplacementTransaction,
  type LighterUnresolvedDepositQueuePage,
} from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import {
  insertSettlementProvenActivityRowWith,
  type SettlementProvenRefusal,
} from "@vex-agent/db/repos/agent-activity/settlement-proven.js";
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
import logger from "@utils/logger.js";

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

/**
 * What the credit transaction did about the durable `agent_activity` row for
 * the settlement transaction. `skipped` is a first-class outcome, not a
 * failure: a deposit Vex did not sign has no valid row shape, and the reason is
 * carried so the operator sees WHY the ledger has no entry for it.
 */
export type LighterDepositActivityRecording =
  | { readonly status: "recorded"; readonly activityId: number }
  | { readonly status: "already_recorded"; readonly activityId: number }
  | { readonly status: "skipped"; readonly reason: SettlementProvenRefusal };

/** What one credit transaction settled: the intent row AND its activity row. */
export interface LighterDepositCreditOutcome {
  readonly intent: LighterOnboardingIntentRow;
  readonly activityRow: LighterDepositActivityRecording;
}

export interface LighterDepositRepairReport {
  readonly intentId: string;
  readonly stateBefore: string;
  readonly stateAfter: string;
  readonly resolution: LighterDepositRepairResolution;
  readonly evidence: "none" | "ethereum_receipt" | "lighter_transaction" | "lighter_account";
  readonly txHash: string | null;
  readonly accountIndex: number | null;
  /** Present only on the arm that credits a deposit; `null` everywhere else. */
  readonly activityRow: LighterDepositActivityRecording | null;
  readonly guidance: string;
}

export interface LighterDepositRepairSweepReport {
  readonly examined: number;
  readonly advanced: number;
  readonly awaiting: number;
  readonly failed: number;
  readonly errors: number;
  /** Unresolved rows exist beyond the ones this sweep examined. */
  readonly hasMore: boolean;
  /** The sweep stopped on its own deadline rather than on an empty page. */
  readonly stoppedAtDeadline: boolean;
  /** Rows the queue page held, of which `examined` were examined. */
  readonly candidates: number;
  /** One report per examined row; bounded by the page limit above. */
  readonly reports: readonly LighterDepositRepairReport[];
}

/**
 * Rows one unattended deposit sweep examines. Each row can perform several
 * settlement-chain and Lighter reads, so the sweep is bounded by rows, not by
 * "everything unresolved". Fair progress comes from the repository order: the
 * queue is least-recently-ATTEMPTED first, and every row this sweep examines
 * has its attempt marker written before the provider read, so it moves to the
 * tail of the queue whatever the read then does to it.
 */
export const LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT = 25;

/**
 * Wall-clock budget for one sweep. The owner is the sweep itself: it stops
 * admitting new rows once the budget is spent, reports that it stopped early,
 * and never interrupts a row that is already being reconciled.
 */
export const LIGHTER_DEPOSIT_REPAIR_SWEEP_DEADLINE_MS = 60_000;

export interface LighterDepositRepairDeps {
  readonly listUnresolvedDepositsByAttempt: (
    page: { readonly limit: number },
  ) => Promise<LighterUnresolvedDepositQueuePage>;
  /**
   * Move one row's attempt marker. Called before the provider read and again
   * with the settled result; it never throws out of the sweep.
   */
  readonly recordRepairAttempt: (
    intent: LighterOnboardingIntentRow,
    result: LighterDepositRepairAttemptResult,
  ) => Promise<void>;
  readonly now?: () => number;
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
  /**
   * Credit the intent AND write its settlement activity row in ONE
   * transaction. Both writes or neither: see this module's header for why the
   * rollback is the correct unknown-outcome behaviour.
   */
  readonly markCredited: (
    intent: LighterOnboardingIntentRow,
    evidence: LighterDepositCreditEvidence,
  ) => Promise<LighterDepositCreditOutcome | null>;
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
    listUnresolvedDepositsByAttempt(page) {
      // One globally ordered query over both environments, least recently
      // attempted first. Two separately limited pages merged and sliced would
      // drop rows that no later page could reach, which is how a backlog in
      // one environment used to hide every unresolved deposit of the other;
      // ordering by the attempt is what stops the rows at the front of that
      // one order from occupying every sweep.
      return intentsRepo.listUnresolvedDepositsByAttempt({ limit: page.limit });
    },
    async recordRepairAttempt(intent, result) {
      // A marker write that fails must not turn one row into the whole sweep's
      // failure - that is the same starvation the marker exists to prevent,
      // arriving through the back door. A row whose marker did not move is
      // simply attempted again by the next sweep.
      try {
        await intentsRepo.recordDepositRepairAttempt(intent.intentId, result);
      } catch (err) {
        logger.warn("sync.lighter_deposit_repair.attempt_marker_failed", {
          environment: intent.environment,
          result,
          reason: errorText(err),
        });
      }
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
      return withIntentSessionLock(intent, async (client) => {
        const credited = await intentsRepo.markDepositCreditedWith(
          client,
          intent.intentId,
          evidence,
        );
        // The CAS lost: another writer moved the intent first. Nothing is
        // credited, so nothing is recorded either - a row written here would
        // claim a credit this transaction did not make.
        if (credited === null) return null;
        const activityRow = await recordCreditedDepositActivity(client, credited, evidence);
        return { intent: credited, activityRow };
      });
    },
  };
}

/**
 * The credited deposit's `agent_activity` row, written on the credit's own
 * transaction.
 *
 * Every identity the row carries comes from evidence this sweep already
 * proved: the settlement chain and asset from the PINNED funding deployment
 * (never from the intent's own nullable settlement columns, which a legacy row
 * may not carry and which are not the authority for what the gateway accepts),
 * the amount from the decoded gateway event, and the sender and nonce from the
 * transaction Vex signed. The Lighter side is client-reported evidence and
 * rides in the row's provenance, per the AgentScan contract R2.7: a receipt
 * proves the settlement transaction, never the L2 credit.
 *
 * It THROWS on a database failure, on purpose: the credit must roll back with
 * it, and the deposit stays reconcilable for the next sweep.
 */
async function recordCreditedDepositActivity(
  client: PoolClient,
  intent: LighterOnboardingIntentRow,
  evidence: LighterDepositCreditEvidence,
): Promise<LighterDepositActivityRecording> {
  const funding = getLighterFundingDeployment(intent.environment);
  const outcome = await insertSettlementProvenActivityRowWith(client, {
    eventRole: "exchange_deposit",
    protocol: "lighter",
    sessionId: intent.sessionId,
    walletAddress: intent.walletAddress,
    execution: intent.protocolExecutionId === null
      ? {
          toolId: "lighter.deposit",
          namespace: "lighter",
          intentParams: {
            intentId: intent.intentId,
            environment: intent.environment,
            capability: intent.capability,
            amountUnits: evidence.amountUnits,
            assetIndex: evidence.assetIndex,
            routeType: evidence.routeType,
          },
        }
      : { existingId: intent.protocolExecutionId },
    chainId: funding.settlementChainId,
    txHash: evidence.txHash,
    fromAddress: intent.depositTxFrom,
    nonce: parseSignedNonce(intent.depositTxNonce),
    asset: {
      address: funding.settlementTokenProxy,
      symbol: funding.settlementSymbol,
      decimals: funding.settlementDecimals,
    },
    amountRaw: evidence.amountUnits,
    venueEvidence: {
      source: "lighter_client_reported",
      environment: intent.environment,
      accountIndex: evidence.accountIndex,
      lighterTxHash: evidence.lighterTxHash,
      lighterBlockHeight: evidence.lighterBlockHeight,
      lighterExecutedAt: evidence.lighterExecutedAt,
      settlementBlockHash: evidence.blockHash,
      settlementBlockNumber: evidence.blockNumber,
    },
  });
  if (outcome.outcome === "refused") {
    logger.info("sync.lighter_deposit_repair.activity_row_skipped", {
      environment: intent.environment,
      reason: outcome.reason,
    });
    return { status: "skipped", reason: outcome.reason };
  }
  return { status: outcome.outcome, activityId: outcome.activityId };
}

/**
 * The staged deposit nonce as the activity row needs it. `null` for anything
 * that is not a plain non-negative integer, which the writer then refuses as an
 * unsigned leg rather than inventing a nonce for a transaction it cannot prove
 * Vex sent.
 */
function parseSignedNonce(nonce: string | null): number | null {
  if (nonce === null || !/^(0|[1-9][0-9]*)$/.test(nonce)) return null;
  const parsed = Number(nonce);
  return Number.isSafeInteger(parsed) ? parsed : null;
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

/**
 * One unattended sweep over the unresolved deposit set of BOTH environments.
 *
 * PROGRESS IS DURABLE, AND IT LIVES IN THE ROW, NOT IN THE CALLER. Every row
 * this sweep examines has its attempt marker written BEFORE the provider read
 * and its settled result written after, so the row has already moved to the
 * tail of the least-recently-attempted queue by the time anything can go wrong
 * with it. Three consequences, and each one is a way an earlier sweep starved
 * a row:
 *
 *   - A backlog larger than one page is walked completely. Reading the front
 *     of a fixed order every time examines the same rows forever; here each
 *     page is retired as it is examined, so N pages of rows are covered by N
 *     consecutive sweeps.
 *   - A row that consumes the whole deadline does not hold the front. It was
 *     marked before the read, so the next sweep starts with the rows behind it.
 *   - No caller state is needed to resume. A sweep interrupted by its deadline,
 *     by a crash, or by a process kill resumes at the least recently attempted
 *     row on the next call, which is why the three production call sites can go
 *     on invoking this with no arguments.
 *
 * A row nothing can move is examined, reported, marked, and left behind. It is
 * never converted into a verdict and never blocks the rows behind it.
 */
export async function repairUnresolvedLighterDeposits(
  deps: LighterDepositRepairDeps = buildProductionLighterDepositRepairDeps(),
  input: { readonly limit?: number } = {},
): Promise<LighterDepositRepairSweepReport> {
  const now = deps.now ?? Date.now;
  const limit = Math.max(1, Math.min(input.limit ?? LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT, 100));
  const startedAt = now();
  const page = await deps.listUnresolvedDepositsByAttempt({ limit });
  const reports: LighterDepositRepairReport[] = [];
  let errors = 0;
  let examined = 0;
  let stoppedAtDeadline = false;

  for (const intent of page.rows) {
    if (now() - startedAt > LIGHTER_DEPOSIT_REPAIR_SWEEP_DEADLINE_MS) {
      stoppedAtDeadline = true;
      break;
    }
    // THE ATTEMPT MARKER GOES DOWN FIRST, exactly as the position snapshot
    // sweep does it: a row that dies mid-repair has already left the front of
    // the queue, so it cannot occupy the front of every later sweep.
    await deps.recordRepairAttempt(intent, "attempted");
    examined += 1;
    let settled: LighterDepositRepairAttemptResult = "error";
    try {
      const report = await repairLighterDepositIntent(intent, deps);
      reports.push(report);
      settled = attemptResultOf(report.resolution);
    } catch {
      errors += 1;
    }
    await deps.recordRepairAttempt(intent, settled);
  }

  return {
    examined,
    advanced: reports.filter((item) => ADVANCED_RESOLUTIONS.has(item.resolution)).length,
    awaiting: reports.filter((item) => AWAITING_RESOLUTIONS.has(item.resolution)).length,
    failed: reports.filter((item) => item.resolution === "failed").length,
    errors,
    hasMore: page.hasMore || stoppedAtDeadline || examined < page.rows.length,
    stoppedAtDeadline,
    candidates: page.rows.length,
    reports,
  };
}

/** Resolutions that moved local state forward on real evidence. */
const ADVANCED_RESOLUTIONS: ReadonlySet<LighterDepositRepairResolution> = new Set([
  "approve_confirmed",
  "deposit_confirmed",
  "credited",
  "failed",
]);

/** Resolutions that leave the row unresolved and waiting for evidence. */
const AWAITING_RESOLUTIONS: ReadonlySet<LighterDepositRepairResolution> = new Set([
  "awaiting_approval",
  "awaiting_chain",
  "awaiting_lighter",
  "manual_review",
]);

/**
 * The attempt marker one settled repair leaves behind. Coarser than the
 * resolution on purpose: the marker answers "what happened the last time a
 * sweep looked at this row", and the row's own lifecycle columns carry the
 * verdict itself.
 */
function attemptResultOf(
  resolution: LighterDepositRepairResolution,
): LighterDepositRepairAttemptResult {
  if (ADVANCED_RESOLUTIONS.has(resolution)) return "advanced";
  if (AWAITING_RESOLUTIONS.has(resolution)) return "awaiting";
  return "terminal";
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
    credited.intent,
    "credited",
    "lighter_account",
    txHash,
    creditEvidence.accountIndex,
    credited.activityRow.status === "skipped"
      ? "The exact settlement deposit, executed Lighter transaction, and wallet-owned master account all match. "
        + `No activity row was recorded (${credited.activityRow.reason}): the settlement transaction is not one Vex can prove it signed.`
      : "The exact settlement deposit, executed Lighter transaction, and wallet-owned master account all match.",
    intent.executionState,
    credited.activityRow,
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
  activityRow: LighterDepositActivityRecording | null = null,
): LighterDepositRepairReport {
  return {
    intentId: intent.intentId,
    stateBefore,
    stateAfter: intent.executionState,
    resolution,
    evidence,
    txHash,
    accountIndex,
    activityRow,
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
