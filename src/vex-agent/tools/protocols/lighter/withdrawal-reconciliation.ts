import { getAddress, parseAbiItem, type Hex, type PublicClient } from "viem";

import type {
  LighterClient,
  LighterPrivilegedAccountAuth,
} from "@tools/lighter/client.js";
import {
  proveLighterCoreWithdrawalL2Transaction,
  publicWithdrawalHistoryEvidence,
  selectLighterCoreWithdrawalHistory,
} from "@tools/lighter/withdrawal/l2-proof.js";
import {
  LighterSettlementConfirmingError,
  proveLighterCoreWithdrawalSettlement,
} from "@tools/lighter/withdrawal/settlement-proof.js";
import { LIGHTER_CORE_WITHDRAW_GATEWAY_ABI } from "@tools/lighter/withdrawal/core-preflight.js";
import { getLighterSecureWithdrawalProfile } from "@tools/lighter/withdrawal/profiles.js";
import type { LighterWithdrawHistoryItem } from "@tools/lighter/types.js";
import * as intentsRepo from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import * as claimsRepo from "@vex-agent/db/repos/lighter-withdrawal-claims.js";
import type { LighterWithdrawalIntentRow } from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import { ErrorCodes, VexError } from "../../../../errors.js";
import {
  insertSettlementProvenActivityRowWith,
  type SettlementProvenRefusal,
} from "@vex-agent/db/repos/agent-activity/settlement-proven.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import logger from "@utils/logger.js";
import { buildLighterWithdrawalActivityRow } from "./agentscan-activity.js";

/**
 * THE CONFIRMED ARM COMMITS ONCE.
 *
 * `destination_confirmed`, the manual claim attempt's own outcome, and the
 * `agent_activity` row that reports the settlement are ONE durable step, on
 * ONE transaction, under the session control lock - the same shape the deposit
 * credit uses in `sync/lighter-deposit-repair.ts`.
 *
 * IT USED TO BE TWO. The reconciliation committed, and the activity row went
 * out afterwards in a transaction of its own whose failures were caught and
 * logged. Because the repair sweep's candidate query excludes
 * `destination_confirmed`, nothing ever revisited the intent: a crash between
 * the two commits, or one failed insert, lost the row permanently. There is no
 * "later" for a state no sweep selects.
 *
 * WHAT A FAILURE MEANS NOW. An insert that throws rolls the whole step back,
 * so the intent is NOT confirmed and stays a reconciliation candidate; the
 * next sweep re-derives the same proof from the same receipt and commits both.
 * That is the unknown-outcome behaviour rule 90 asks for - the confirmation
 * was never durable, so nothing durable was undone - and it is why a reporting
 * failure can no longer unmake a confirmation: there is no window in which one
 * exists without the other.
 *
 * A REFUSAL IS NOT A FAILURE. An auto-claim the gateway released carries no
 * sender and no nonce that Vex signed, so no honest row exists for it (see
 * `db/repos/agent-activity/settlement-proven.ts`). That is a fact about the
 * withdrawal, recorded with it in the same transaction as
 * `destinationEvidence.activityReport`, and never retried.
 */
export type LighterWithdrawalActivityRefusal =
  | SettlementProvenRefusal
  | "no_claim_attempt"
  | "gateway_auto_claim_not_signed_by_vex"
  | "claim_hash_does_not_match_settlement";

/** What the confirmed arm recorded about its own reporting, on the intent. */
export type LighterWithdrawalActivityReport =
  | { readonly status: "recorded" | "already_recorded"; readonly activityId: number }
  | { readonly status: "not_reported"; readonly reason: LighterWithdrawalActivityRefusal };

/** The activity-row outcome as this lane consumes it, narrowed from the writer's. */
export type LighterWithdrawalActivityOutcome =
  | { readonly outcome: "recorded" | "already_recorded"; readonly activityId: number }
  | { readonly outcome: "refused"; readonly reason: SettlementProvenRefusal };

export interface LighterSettlementProvenActivityInput {
  readonly sessionId: string;
  readonly protocolExecutionId: number | null;
  /** The withdrawal intent this row reports; names the execution when the intent carries none. */
  readonly withdrawalIntentId: string;
  readonly environment: LighterWithdrawalIntentRow["environment"];
  readonly accountIndex: number;
  readonly kind: "exchange";
  readonly eventRole: "exchange_deposit" | "exchange_withdrawal";
  readonly chainFamily: "eip155";
  readonly chainId: number;
  readonly txHash: string;
  readonly fromAddress: string;
  readonly nonce: number;
  readonly submitAttemptedAt: string;
  readonly walletAddress: string;
  readonly tokenOutAddress: string;
  readonly tokenOutSymbol: string;
  readonly tokenOutDecimals: number;
  readonly amountOutRaw: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Every write the confirmed arm makes, bound to ONE transaction.
 *
 * The arm keeps the decisions (which claim backs the settlement, whether a row
 * can honestly be written, what the intent records about it); the writer owns
 * only the statements. That split is what lets a test drive the real arm over
 * a transactional double and prove the atomicity, rather than assert that a
 * production helper was called.
 */
export interface LighterWithdrawalConfirmationWriter {
  readonly findClaim: (withdrawalIntentId: string) => Promise<claimsRepo.LighterWithdrawalClaimAttemptRow | null>;
  readonly recordReconciliation: (
    input: intentsRepo.RecordReconciliationInput,
  ) => Promise<LighterWithdrawalIntentRow | null>;
  readonly markReconciledOutcome: (input: claimsRepo.MarkReconciledOutcomeInput) => Promise<boolean>;
  readonly insertActivityRow: (
    input: LighterSettlementProvenActivityInput,
  ) => Promise<LighterWithdrawalActivityOutcome>;
}

/**
 * How the confirmed arm gets its transaction. `commit` MUST take the session
 * control lock first and roll back on any throw - that rollback IS the
 * atomicity guarantee, not a convenience.
 */
export interface LighterWithdrawalConfirmationDeps {
  readonly commit: <T>(
    sessionId: string,
    write: (writer: LighterWithdrawalConfirmationWriter) => Promise<T>,
  ) => Promise<T>;
}

/** Production wiring: one short transaction under the session control lock. */
export function defaultLighterWithdrawalConfirmationDeps(): LighterWithdrawalConfirmationDeps {
  return {
    commit: (sessionId, write) => withSessionControlLock(sessionId, (client) => write({
      findClaim: (withdrawalIntentId) =>
        claimsRepo.findLatestForWithdrawalIntentWith(client, withdrawalIntentId),
      recordReconciliation: (input) => intentsRepo.recordReconciliationWith(client, input),
      markReconciledOutcome: (input) => claimsRepo.markReconciledOutcomeWith(client, input),
      insertActivityRow: async (input) => {
        const outcome = await insertSettlementProvenActivityRowWith(client, {
          eventRole: input.eventRole,
          protocol: "lighter",
          sessionId: input.sessionId,
          walletAddress: input.walletAddress,
          execution: input.protocolExecutionId === null
            ? {
                toolId: "lighter.withdraw",
                namespace: "lighter",
                intentParams: {
                  intentId: input.withdrawalIntentId,
                  environment: input.environment,
                  accountIndex: input.accountIndex,
                  amountUnits: input.amountOutRaw,
                  assetSymbol: input.tokenOutSymbol,
                },
              }
            : { existingId: input.protocolExecutionId },
          chainId: input.chainId,
          txHash: input.txHash,
          fromAddress: input.fromAddress,
          nonce: input.nonce,
          submitAttemptedAt: input.submitAttemptedAt,
          asset: {
            address: input.tokenOutAddress,
            symbol: input.tokenOutSymbol,
            decimals: input.tokenOutDecimals,
          },
          amountRaw: input.amountOutRaw,
          venueEvidence: input.metadata,
        });
        if (outcome.outcome === "refused") {
          return { outcome: "refused", reason: outcome.reason };
        }
        return { outcome: outcome.outcome, activityId: outcome.activityId };
      },
    })),
  };
}

const MAX_HISTORY_PAGES = 50;
const MAX_SETTLEMENT_SCAN_PAGES = 100;
const SETTLEMENT_SCAN_PAGE_BLOCKS = 10_000n;
const WITHDRAW_PENDING_EVENT = parseAbiItem(
  "event WithdrawPending(address indexed owner, uint16 assetIndex, uint128 baseAmount)",
);
type ReconciliationInput = Parameters<typeof intentsRepo.recordReconciliation>[0];
type ReconciliationCommon = Omit<ReconciliationInput, "state">;

export async function reconcileLighterCoreWithdrawal(input: {
  readonly intent: LighterWithdrawalIntentRow;
  readonly client: Pick<LighterClient, "getTx" | "getWithdrawHistory">;
  readonly privilegedAuth: LighterPrivilegedAccountAuth;
  readonly publicClient: PublicClient;
  readonly historicalPublicClient?: PublicClient;
  readonly intents?: Pick<typeof intentsRepo, "recordReconciliation">;
  readonly claims?: Pick<typeof claimsRepo, "markReconciledOutcome">;
  /** How the confirmed arm commits. Defaults to the production transaction. */
  readonly confirmation?: LighterWithdrawalConfirmationDeps;
}): Promise<LighterWithdrawalIntentRow> {
  if (input.intent.environment !== "core") {
    throw invalid("The withdrawal intent is not a Core withdrawal.");
  }
  return reconcileLighterWithdrawal(input);
}

export async function reconcileLighterWithdrawal(input: {
  readonly intent: LighterWithdrawalIntentRow;
  readonly client: Pick<LighterClient, "getTx" | "getWithdrawHistory">;
  readonly privilegedAuth: LighterPrivilegedAccountAuth;
  readonly publicClient: PublicClient;
  readonly historicalPublicClient?: PublicClient;
  readonly intents?: Pick<typeof intentsRepo, "recordReconciliation">;
  readonly claims?: Pick<typeof claimsRepo, "markReconciledOutcome">;
  /** How the confirmed arm commits. Defaults to the production transaction. */
  readonly confirmation?: LighterWithdrawalConfirmationDeps;
}): Promise<LighterWithdrawalIntentRow> {
  const repo = input.intents ?? intentsRepo;
  const intent = input.intent;
  const profile = getLighterSecureWithdrawalProfile(intent.environment);
  if (
    intent.signingChainId !== profile.signingChainId
    || intent.settlementChainId !== profile.settlementChainId
    || intent.assetSymbol !== profile.assetSymbol
    || intent.signerTxHash === null
    || intent.nonceValue === null
    || intent.submissionStagedAt === null
  ) throw invalid(`${profile.sourceName} withdrawal has no valid staged signed transaction identity to reconcile.`);
  if (input.privilegedAuth.accountIndex !== intent.accountIndex) {
    throw invalid(`Read-only ${profile.sourceName} authorization does not match the withdrawal account.`);
  }
  const historicalPublicClient = input.historicalPublicClient ?? input.publicClient;

  const [tx, history, pendingBalance, settlement] = await Promise.all([
    input.client.getTx(intent.environment, { by: "hash", value: intent.signerTxHash }),
    readAllHistory(input.client, intent.environment, intent.accountIndex, input.privilegedAuth),
    input.publicClient.readContract({
      address: intent.gatewayAddress as `0x${string}`,
      abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
      functionName: "getPendingBalance",
      args: [intent.destinationAddress as `0x${string}`, profile.assetIndex],
    }),
    scanSettlement(historicalPublicClient, intent),
  ]);
  const l2 = proveLighterCoreWithdrawalL2Transaction({
    tx,
    expectedHash: intent.signerTxHash,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    nonce: intent.nonceValue,
    amountUnits: intent.amountUnits,
  });
  const historyRow = selectLighterCoreWithdrawalHistory({
    rows: history,
    existingHistoryId: intent.withdrawalHistoryId,
    amountUnits: intent.amountUnits,
    notBefore: new Date(intent.submissionStagedAt),
  });
  const common = {
    intentId: intent.intentId,
    sessionId: intent.sessionId,
    providerTxStatus: l2.status,
    providerTxEvidence: Object.fromEntries(Object.entries(l2)),
    historyId: historyRow?.id ?? null,
    historyStatus: historyRow?.status ?? null,
    historyTimestamp: historyRow?.timestamp ?? null,
    historyEvidence: historyRow === null ? null : publicWithdrawalHistoryEvidence(historyRow),
    pendingBalanceUnits: pendingBalance.toString(10),
    settlementScanFromBlock: settlement.nextFromBlock.toString(10),
  } as const satisfies ReconciliationCommon;

  if (!l2.executed) {
    if (hasProvenL2Execution(intent.executionState)) {
      return persist(repo, {
        ...common,
        state: "ambiguous",
        ambiguousReason: "provider_tx_regressed_after_execution",
      });
    }
    return persist(repo, { ...common, state: "l2_pending" });
  }
  if (historyRow === null) {
    const state = preserveProvenProgress(intent.executionState, "l2_executed");
    return persist(repo, { ...common, state });
  }
  if (settlement.transactionHashes.length > 1) {
    return persist(repo, {
      ...common,
      state: "ambiguous",
      ambiguousReason: "multiple_exact_destination_events",
    });
  }
  const settlementHash = settlement.transactionHashes[0];
  if (settlementHash !== undefined) {
    if (
      intent.claimTxHash !== null
      && settlementHash.toLowerCase() !== (intent.claimReplacementTxHash ?? intent.claimTxHash).toLowerCase()
    ) {
      return persist(repo, {
        ...common,
        state: "ambiguous",
        ambiguousReason: "destination_event_does_not_match_staged_manual_claim",
      });
    }
    return reconcileDestinationTransaction({
      intent,
      publicClient: historicalPublicClient,
      repo,
      pendingBalance,
      common,
      hash: settlementHash,
      claimMode: intent.claimTxHash === null ? "auto" : "manual",
      claims: input.claims ?? claimsRepo,
      confirmation: input.confirmation ?? defaultLighterWithdrawalConfirmationDeps(),
    });
  }
  if (historyRow.status === "failed" || historyRow.status === "refunded") {
    if (hasProvenClaimProgress(intent.executionState)) {
      return persist(repo, {
        ...common,
        state: "ambiguous",
        ambiguousReason: `history_${historyRow.status}_after_claim_progress`,
      });
    }
    return persist(repo, { ...common, state: historyRow.status });
  }
  if (historyRow.status === "pending") {
    if (hasProvenClaimProgress(intent.executionState)) {
      return persist(repo, {
        ...common,
        state: "ambiguous",
        ambiguousReason: "history_pending_after_claim_progress",
      });
    }
    return persist(repo, { ...common, state: "secure_waiting" });
  }
  if (historyRow.status === "claimable") {
    if (hasProvenSettlementProgress(intent.executionState)) {
      return persist(repo, {
        ...common,
        state: "ambiguous",
        ambiguousReason: "history_claimable_after_settlement_progress",
      });
    }
    if (pendingBalance.toString(10) !== intent.amountUnits) {
      return persist(repo, {
        ...common,
        state: "ambiguous",
        ambiguousReason: "claimable_history_pending_balance_mismatch",
      });
    }
    if (intent.executionState === "manual_claim_prepared" || intent.executionState === "manual_claim_approved") {
      return persist(repo, { ...common, state: intent.executionState });
    }
    return persist(repo, { ...common, state: "claimable" });
  }
  const historyHash = historyRow.l1_tx_hash;
  if (!/^0x[0-9a-fA-F]{64}$/.test(historyHash)) {
    return persist(repo, {
      ...common,
      state: "ambiguous",
      ambiguousReason: "completed_history_missing_exact_destination_event",
    });
  }
  return reconcileDestinationTransaction({
    intent,
    publicClient: historicalPublicClient,
    repo,
    pendingBalance,
    common,
    hash: historyHash as Hex,
    claimMode: intent.claimTxHash === null ? "auto" : "manual",
    claims: input.claims ?? claimsRepo,
    confirmation: input.confirmation ?? defaultLighterWithdrawalConfirmationDeps(),
  });
}

function hasProvenL2Execution(state: LighterWithdrawalIntentRow["executionState"]): boolean {
  return [
    "l2_executed", "secure_waiting", "claimable", "auto_claim_observed",
    "manual_claim_prepared", "manual_claim_approved", "manual_claim_staged",
    "manual_claim_submitted", "destination_confirmed",
  ].includes(state);
}

function hasProvenClaimProgress(state: LighterWithdrawalIntentRow["executionState"]): boolean {
  return [
    "claimable", "auto_claim_observed", "manual_claim_prepared", "manual_claim_approved",
    "manual_claim_staged", "manual_claim_submitted", "destination_confirmed",
  ].includes(state);
}

function hasProvenSettlementProgress(state: LighterWithdrawalIntentRow["executionState"]): boolean {
  return [
    "auto_claim_observed", "manual_claim_staged", "manual_claim_submitted", "destination_confirmed",
  ].includes(state);
}

async function reconcileDestinationTransaction(input: {
  readonly intent: LighterWithdrawalIntentRow;
  readonly publicClient: PublicClient;
  readonly repo: Pick<typeof intentsRepo, "recordReconciliation">;
  readonly pendingBalance: bigint;
  readonly common: ReconciliationCommon;
  readonly hash: Hex;
  readonly claimMode: "auto" | "manual";
  readonly claims: Pick<typeof claimsRepo, "markReconciledOutcome">;
  readonly confirmation: LighterWithdrawalConfirmationDeps;
}): Promise<LighterWithdrawalIntentRow> {
  let receipt;
  try {
    receipt = await input.publicClient.getTransactionReceipt({ hash: input.hash });
  } catch {
    return persist(input.repo, {
      ...input.common,
      state: input.claimMode === "auto" ? "auto_claim_observed" : "manual_claim_submitted",
      claimMode: input.claimMode,
      destinationTxHash: input.hash,
    });
  }
  const [block, latestBlockNumber] = await Promise.all([
    input.publicClient.getBlock({ blockNumber: receipt.blockNumber, includeTransactions: false }),
    input.publicClient.getBlockNumber(),
  ]);
  if (receipt.transactionHash.toLowerCase() !== input.hash.toLowerCase()) {
    return persist(input.repo, {
      ...input.common,
      state: "ambiguous",
      ambiguousReason: "ethereum_receipt_hash_identity_mismatch",
    });
  }
  if (receipt.status === "reverted" && input.claimMode === "manual") {
    const canonical = block.hash === receipt.blockHash;
    const confirmationsBig = latestBlockNumber >= receipt.blockNumber
      ? latestBlockNumber - receipt.blockNumber + 1n
      : 0n;
    const confirmations = confirmationsBig > BigInt(Number.MAX_SAFE_INTEGER)
      ? 0 : Number(confirmationsBig);
    if (!canonical || confirmations === 0) {
      return persist(input.repo, {
        ...input.common,
        state: "ambiguous",
        ambiguousReason: "manual_claim_revert_not_canonical",
      });
    }
    if (confirmations < 12) {
      return persist(input.repo, {
        ...input.common,
        state: "manual_claim_submitted",
        claimMode: "manual",
        destinationTxHash: receipt.transactionHash,
        destinationBlockNumber: receipt.blockNumber.toString(10),
        destinationBlockHash: receipt.blockHash,
        destinationConfirmations: confirmations,
      });
    }
    if (input.pendingBalance !== BigInt(input.intent.amountUnits)) {
      return persist(input.repo, {
        ...input.common,
        state: "ambiguous",
        ambiguousReason: "finalized_manual_claim_revert_pending_balance_mismatch",
      });
    }
    const evidence = {
      kind: "finalized_manual_claim_revert",
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber.toString(10),
      blockHash: receipt.blockHash,
      confirmations,
      pendingBalanceUnits: input.pendingBalance.toString(10),
    } as const;
    const row = await persist(input.repo, {
      ...input.common,
      state: "claimable",
      claimMode: "manual",
      destinationTxHash: receipt.transactionHash,
      destinationBlockNumber: receipt.blockNumber.toString(10),
      destinationBlockHash: receipt.blockHash,
      destinationConfirmations: confirmations,
      destinationEvidence: evidence,
    });
    const recorded = await input.claims.markReconciledOutcome({
      sessionId: input.intent.sessionId,
      withdrawalIntentId: input.intent.intentId,
      transactionHash: receipt.transactionHash,
      outcome: "reverted",
      receipt: evidence,
    });
    if (!recorded) throw invalid("Finalized manual claim revert could not update its durable attempt.");
    return row;
  }
  // ONLY THE PROOF IS GUARDED. The catch below turns a failure into
  // `ambiguous`, which is the right answer for a settlement that cannot be
  // proven and the WRONG answer for a database failure - so the commit that
  // follows is deliberately outside it: a write that fails must propagate,
  // roll its transaction back and leave the intent a reconciliation candidate,
  // never be recorded as an unprovable settlement.
  let proof;
  try {
    proof = proveLighterCoreWithdrawalSettlement({
      receipt,
      canonicalBlockHash: block.hash,
      latestBlockNumber,
      owner: input.intent.destinationAddress,
      gatewayAddress: input.intent.gatewayAddress,
      tokenAddress: input.intent.settlementTokenAddress,
      amountUnits: BigInt(input.intent.amountUnits),
    });
  } catch (error) {
    if (error instanceof LighterSettlementConfirmingError) {
      return persist(input.repo, {
        ...input.common,
        state: input.claimMode === "auto" ? "auto_claim_observed" : "manual_claim_submitted",
        claimMode: input.claimMode,
        destinationTxHash: receipt.transactionHash,
        destinationBlockNumber: receipt.blockNumber.toString(10),
        destinationBlockHash: receipt.blockHash,
        destinationConfirmations: error.confirmations,
      });
    }
    return persist(input.repo, {
      ...input.common,
      state: "ambiguous",
      ambiguousReason: "completed_history_failed_exact_settlement_proof",
      destinationTxHash: receipt.transactionHash,
      destinationBlockNumber: receipt.blockNumber.toString(10),
      destinationBlockHash: receipt.blockHash,
    });
  }
  const publicProof = Object.fromEntries(Object.entries(proof));
  if (input.pendingBalance !== 0n) {
    return persist(input.repo, {
      ...input.common,
      state: "ambiguous",
      ambiguousReason: "destination_proven_but_gateway_balance_nonzero",
    });
  }
  return commitConfirmedWithdrawal(input, proof.transactionHash, publicProof, {
    destinationBlockNumber: proof.blockNumber,
    destinationBlockHash: proof.blockHash,
    destinationConfirmations: proof.confirmations,
  });
}

/**
 * The whole confirmed step, in ONE transaction: the exchange activity row, the
 * `destination_confirmed` reconciliation that carries what the reporting did,
 * and (for a manual claim) the attempt's own outcome.
 *
 * ORDER IS DELIBERATE. The row is written first because the reconciliation
 * RECORDS its result: `destinationEvidence.activityReport` is how a refusal
 * becomes a durable fact about this withdrawal rather than a log line nobody
 * will ever revisit - the repair sweep does not select `destination_confirmed`
 * intents, so this transaction is the only chance to say it.
 *
 * NOTHING IS CAUGHT HERE. A statement that fails aborts the transaction; the
 * intent is left exactly as it was, still selected by the sweep, and the next
 * pass re-derives the same proof from the same receipt.
 */
async function commitConfirmedWithdrawal(
  input: {
    readonly intent: LighterWithdrawalIntentRow;
    readonly common: ReconciliationCommon;
    readonly claimMode: "auto" | "manual";
    readonly confirmation: LighterWithdrawalConfirmationDeps;
  },
  settlementTxHash: string,
  publicProof: Record<string, unknown>,
  destination: {
    readonly destinationBlockNumber: string;
    readonly destinationBlockHash: string;
    readonly destinationConfirmations: number;
  },
): Promise<LighterWithdrawalIntentRow> {
  return input.confirmation.commit(input.intent.sessionId, async (writer) => {
    const claim = await writer.findClaim(input.intent.intentId);
    const activityInput = buildWithdrawalActivityInput(input.intent, claim, settlementTxHash);
    const report = "reason" in activityInput
      ? activityInput
      : foldActivityOutcome(await writer.insertActivityRow(activityInput));
    if (report.status === "not_reported") {
      logger.info("lighter.withdrawal.activity_not_reported", {
        environment: input.intent.environment,
        intentId: input.intent.intentId,
        reason: report.reason,
      });
    }
    const row = await writer.recordReconciliation({
      ...input.common,
      state: "destination_confirmed",
      claimMode: input.claimMode,
      destinationTxHash: settlementTxHash,
      ...destination,
      destinationEvidence: { ...publicProof, activityReport: report },
    });
    if (row === null) throw invalid("Lighter withdrawal reconciliation could not persist its monotonic state.");
    if (input.claimMode === "manual") {
      const recorded = await writer.markReconciledOutcome({
        sessionId: input.intent.sessionId,
        withdrawalIntentId: input.intent.intentId,
        transactionHash: settlementTxHash,
        outcome: "confirmed",
        receipt: publicProof,
      });
      if (!recorded) throw invalid("Finalized manual claim delivery could not update its durable attempt.");
    }
    return row;
  });
}

function foldActivityOutcome(
  outcome: LighterWithdrawalActivityOutcome,
): LighterWithdrawalActivityReport {
  return outcome.outcome === "refused"
    ? { status: "not_reported", reason: outcome.reason }
    : { status: outcome.outcome, activityId: outcome.activityId };
}

/**
 * The activity row a CLAIMED withdrawal earns, or the reason it earns none.
 *
 * PURE, and deliberately so: whether a settlement can be reported honestly is
 * a decision about the claim's identity, not a database operation, and keeping
 * it out of the writer is what lets the reason be recorded on the intent
 * instead of being discovered inside a transaction that has nothing to say.
 *
 * Only a claim VEX ITSELF SIGNED can be reported. Migration 045 requires the
 * settlement transaction's own sender and nonce on an eip155 row that carries
 * a hash, and an auto-claim released by the gateway has neither. That is not a
 * gap to paper over - a row invented with someone else's sender would be a
 * false statement about who moved the money - so the refusal is the answer.
 */
function buildWithdrawalActivityInput(
  intent: LighterWithdrawalIntentRow,
  claim: claimsRepo.LighterWithdrawalClaimAttemptRow | null,
  settlementTxHash: string,
): LighterSettlementProvenActivityInput | { readonly status: "not_reported"; readonly reason: LighterWithdrawalActivityRefusal } {
  if (claim === null) return { status: "not_reported", reason: "no_claim_attempt" };
  const fromAddress = claim.fromAddress;
  const nonce = claim.nonce;
  if (fromAddress === null || nonce === null) {
    return { status: "not_reported", reason: "gateway_auto_claim_not_signed_by_vex" };
  }
  const claimHash = claim.replacementTxHash ?? claim.txHash;
  if (claimHash === null || claimHash.toLowerCase() !== settlementTxHash.toLowerCase()) {
    return { status: "not_reported", reason: "claim_hash_does_not_match_settlement" };
  }
  const funding = buildLighterWithdrawalActivityRow({
    settlementChainId: intent.settlementChainId,
    txHash: settlementTxHash,
    asset: {
      address: intent.settlementTokenAddress,
      symbol: intent.assetSymbol,
      decimals: intent.assetDecimals,
    },
    amountRaw: intent.amountUnits,
    environment: intent.environment,
    accountIndex: intent.accountIndex,
  });
  return {
    sessionId: intent.sessionId,
    protocolExecutionId: intent.protocolExecutionId,
    withdrawalIntentId: intent.intentId,
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    kind: funding.kind,
    eventRole: funding.eventRole,
    chainFamily: funding.chainFamily,
    chainId: funding.chainId,
    txHash: funding.txHash,
    fromAddress,
    nonce,
    submitAttemptedAt: claim.submittedAt ?? claim.stagedAt ?? new Date().toISOString(),
    walletAddress: intent.walletAddress,
    tokenOutAddress: funding.asset.address,
    tokenOutSymbol: funding.asset.symbol,
    tokenOutDecimals: funding.asset.decimals,
    amountOutRaw: funding.amountRaw,
    metadata: {
      protocol: funding.protocol,
      environment: funding.environment,
      accountIndex: funding.accountIndex,
      withdrawalIntentId: intent.intentId,
    },
  };
}

async function scanSettlement(
  publicClient: PublicClient,
  intent: LighterWithdrawalIntentRow,
): Promise<{ readonly transactionHashes: readonly Hex[]; readonly nextFromBlock: bigint }> {
  const storedInitial = intent.settlementScanFromBlock ?? intent.preflightJson.settlementBlockNumber;
  if (typeof storedInitial !== "string" || !/^\d+$/.test(storedInitial)) {
    throw invalid(`Stored ${intent.settlementNetworkName} settlement scan cursor is invalid.`);
  }
  const initial = BigInt(storedInitial);
  const latest = await publicClient.getBlockNumber();
  if (initial > latest + 1n) throw invalid(`Stored ${intent.settlementNetworkName} settlement scan cursor is ahead of the chain head.`);
  const matches = new Set<Hex>();
  if (intent.destinationTxHash !== null) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(intent.destinationTxHash)) {
      throw invalid(`Stored ${intent.settlementNetworkName} destination transaction hash is invalid.`);
    }
    matches.add(intent.destinationTxHash as Hex);
  }
  let fromBlock = initial;
  let pages = 0;
  while (fromBlock <= latest) {
    if (pages >= MAX_SETTLEMENT_SCAN_PAGES) {
      throw invalid(`${intent.settlementNetworkName} settlement scan exceeded its bounded block range.`);
    }
    const toBlock = minBigInt(latest, fromBlock + SETTLEMENT_SCAN_PAGE_BLOCKS - 1n);
    const logs = await publicClient.getLogs({
      address: getAddress(intent.gatewayAddress),
      event: WITHDRAW_PENDING_EVENT,
      args: { owner: getAddress(intent.destinationAddress) },
      fromBlock,
      toBlock,
      strict: true,
    });
    for (const log of logs) {
      if (
        log.args.assetIndex === intent.assetIndex
        && log.args.baseAmount === BigInt(intent.amountUnits)
        && log.transactionHash !== null
      ) matches.add(log.transactionHash);
    }
    fromBlock = toBlock + 1n;
    pages += 1;
  }
  const finalityReplayFrom = latest >= 11n ? latest - 11n : 0n;
  return {
    transactionHashes: [...matches],
    nextFromBlock: initial > finalityReplayFrom ? initial : finalityReplayFrom,
  };
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

async function readAllHistory(
  client: Pick<LighterClient, "getWithdrawHistory">,
  environment: "core" | "rhc",
  accountIndex: number,
  auth: LighterPrivilegedAccountAuth,
): Promise<readonly LighterWithdrawHistoryItem[]> {
  const rows: LighterWithdrawHistoryItem[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const response = await client.getWithdrawHistory(environment, { accountIndex, cursor, filter: "all" }, auth);
    if (response.code !== 200) throw invalid(`Authenticated ${environment.toUpperCase()} withdrawal history is unavailable.`);
    rows.push(...response.withdraws);
    const next = response.cursor.trim();
    if (next.length === 0) return rows;
    if (seen.has(next)) {
      if (response.withdraws.length === 0) return rows;
      throw invalid(`${environment.toUpperCase()} withdrawal history repeated a pagination cursor.`);
    }
    seen.add(next);
    cursor = next;
  }
  throw invalid(`${environment.toUpperCase()} withdrawal history exceeded the bounded pagination limit.`);
}

function preserveProvenProgress(
  current: LighterWithdrawalIntentRow["executionState"],
  fallback: "l2_executed",
): ReconciliationInput["state"] {
  if (
    current === "secure_waiting"
    || current === "claimable"
    || current === "auto_claim_observed"
  ) return current;
  return fallback;
}

async function persist(
  repo: Pick<typeof intentsRepo, "recordReconciliation">,
  input: ReconciliationInput,
): Promise<LighterWithdrawalIntentRow> {
  const row = await repo.recordReconciliation(input);
  if (row === null) throw invalid("Lighter withdrawal reconciliation could not persist its monotonic state.");
  return row;
}

function invalid(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Keep the withdrawal unresolved and do not retry submission without exact reconciliation.",
  );
}
