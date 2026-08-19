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
  readonly intents?: Pick<typeof intentsRepo, "recordReconciliation">;
  readonly claims?: Pick<typeof claimsRepo, "markReconciledOutcome">;
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
  readonly intents?: Pick<typeof intentsRepo, "recordReconciliation">;
  readonly claims?: Pick<typeof claimsRepo, "markReconciledOutcome">;
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

  const [tx, history, pendingBalance, settlement] = await Promise.all([
    input.client.getTx(intent.environment, { by: "hash", value: intent.signerTxHash }),
    readAllHistory(input.client, intent.environment, intent.accountIndex, input.privilegedAuth),
    input.publicClient.readContract({
      address: intent.gatewayAddress as `0x${string}`,
      abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
      functionName: "getPendingBalance",
      args: [intent.destinationAddress as `0x${string}`, profile.assetIndex],
    }),
    scanSettlement(input.publicClient, intent),
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
    providerTxEvidence: l2 as unknown as Record<string, unknown>,
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
      publicClient: input.publicClient,
      repo,
      pendingBalance,
      common,
      hash: settlementHash,
      claimMode: intent.claimTxHash === null ? "auto" : "manual",
      claims: input.claims ?? claimsRepo,
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
    publicClient: input.publicClient,
    repo,
    pendingBalance,
    common,
    hash: historyHash as Hex,
    claimMode: intent.claimTxHash === null ? "auto" : "manual",
    claims: input.claims ?? claimsRepo,
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
  try {
    const proof = proveLighterCoreWithdrawalSettlement({
      receipt,
      canonicalBlockHash: block.hash,
      latestBlockNumber,
      owner: input.intent.destinationAddress,
      gatewayAddress: input.intent.gatewayAddress,
      tokenAddress: input.intent.settlementTokenAddress,
      amountUnits: BigInt(input.intent.amountUnits),
    });
    if (input.pendingBalance !== 0n) {
      return persist(input.repo, {
        ...input.common,
        state: "ambiguous",
        ambiguousReason: "destination_proven_but_gateway_balance_nonzero",
      });
    }
    const row = await persist(input.repo, {
      ...input.common,
      state: "destination_confirmed",
      claimMode: input.claimMode,
      destinationTxHash: proof.transactionHash,
      destinationBlockNumber: proof.blockNumber,
      destinationBlockHash: proof.blockHash,
      destinationConfirmations: proof.confirmations,
      destinationEvidence: proof as unknown as Record<string, unknown>,
    });
    if (input.claimMode === "manual") {
      const recorded = await input.claims.markReconciledOutcome({
        sessionId: input.intent.sessionId,
        withdrawalIntentId: input.intent.intentId,
        transactionHash: proof.transactionHash,
        outcome: "confirmed",
        receipt: proof as unknown as Record<string, unknown>,
      });
      if (!recorded) throw invalid("Finalized manual claim delivery could not update its durable attempt.");
    }
    return row;
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
    if (seen.has(next)) throw invalid(`${environment.toUpperCase()} withdrawal history repeated a pagination cursor.`);
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
