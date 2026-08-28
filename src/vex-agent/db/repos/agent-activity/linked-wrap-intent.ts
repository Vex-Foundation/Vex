/**
 * The `wallet_wrap_intents` ARM of the linked repair settlement.
 *
 * The wrap lane is a THIRD durable state machine beside
 * `wallet_transaction_intents` and the transfer-specific `wallet_intents`. Its
 * status vocabulary, its evidence CHECK and its terminal writes are the
 * transaction table's, so its arm reads the same way - but it is its own table
 * with its own row, and before this module the generic repair coordinator did
 * not know it existed. The consequence was the defect this file closes: a
 * repair lane could confirm the wrap ACTIVITY row from a receipt while the wrap
 * INTENT stayed `broadcast_unconfirmed` forever, blocking the compaction
 * money-state gate on a transaction the chain had already settled.
 *
 * ## Why an arm and not another branch in the coordinator
 *
 * `./linked-transaction-settlement.ts` already carries two arms and is the
 * coordinator: it owns the lock, the activity write, the mutual exclusion
 * between state machines and the execution row. A third arm inlined there would
 * have pushed one file past the growth gate while mixing three tables'
 * lifecycle rules into one body. This file owns exactly one question - "what
 * may this wrap intent become, and how" - and the coordinator calls it.
 *
 * ## No new semantics
 *
 * Every rule here is the coordinator's existing conservative rule, applied to
 * the wrap row: chain-proven outcomes only, a `consuming` row is first moved to
 * `broadcast_unconfirmed` with the hash the activity row carries, a CAS miss is
 * re-read and accepted ONLY when the durable row already states the same
 * outcome, and an unknown outcome is never written at all.
 */

import type { PoolClient } from "pg";

import * as wrapIntentsRepo from "../wallet-wrap-intents.js";
import type { WalletWrapIntent } from "../wallet-wrap-intents.js";
import { LinkedTransactionSettlementConflictError } from "./linked-settlement-conflict.js";
import type { AgentActivityEvent } from "./types.js";
import type {
  LinkedIntentRepairOutcome,
  LinkedSettlementHooks,
} from "./linked-transaction-settlement.js";

/**
 * The wrap intent linked to this activity row, or `null`.
 *
 * Client-bound: the coordinator holds the session control lock and uncommitted
 * sibling writes, and a pool-level read would answer from another snapshot.
 */
export function readLinkedWrapIntent(
  client: PoolClient,
  activityId: number,
): Promise<WalletWrapIntent | null> {
  return wrapIntentsRepo.getByActivityIdWith(client, activityId);
}

/**
 * The link is real and points both ways, and the activity row is actually a
 * wrap row. A wrap intent pointing at a swap or transfer row is a corrupted
 * link, not a settlement candidate.
 */
export function validateWrapLinkedRows(
  activity: AgentActivityEvent,
  intent: WalletWrapIntent,
  activityId: number,
  sessionId: string | null,
): void {
  if (sessionId === null || intent.sessionId !== sessionId) {
    throw new LinkedTransactionSettlementConflictError(
      "wwi",
      "the linked wrap intent belongs to a different session",
    );
  }
  if (intent.activityId !== String(activityId)) {
    throw new LinkedTransactionSettlementConflictError(
      "wwi",
      "the wrap intent no longer points at this activity row",
    );
  }
  if (activity.kind !== "wrap") {
    throw new LinkedTransactionSettlementConflictError(
      "aa",
      "a wrap intent points at a non-wrap activity row",
    );
  }
  if (activity.eventRole !== intent.direction) {
    throw new LinkedTransactionSettlementConflictError(
      "aa",
      "the wrap intent and activity row disagree on direction",
    );
  }
  if (activity.chainId !== intent.chainId) {
    throw new LinkedTransactionSettlementConflictError(
      "wwi",
      "the wrap intent and activity row disagree on chain",
    );
  }
}

/**
 * May this durable wrap row become `outcome`? Identical in shape to the
 * transaction arm's assertion, and for the same reason: a hash is required for
 * every chain verdict, forbidden for a crash-before-broadcast, and a row that
 * already states the outcome is an idempotent continue rather than a conflict.
 */
export function assertWrapIntentCanSettle(
  intent: WalletWrapIntent,
  activity: AgentActivityEvent,
  outcome: LinkedIntentRepairOutcome,
): void {
  if (outcome === "signed_not_submitted") {
    if (activity.txHash === null) {
      throw new LinkedTransactionSettlementConflictError(
        "aa",
        "signed-not-submitted wrap settlement has no staged signature",
      );
    }
    if (intent.status === "consuming" || wrapIntentMatchesOutcome(intent, activity, outcome)) {
      return;
    }
  } else if (outcome === "crashed_before_broadcast") {
    if (activity.txHash !== null) {
      throw new LinkedTransactionSettlementConflictError(
        "aa",
        "crashed-before-broadcast wrap settlement found a staged transaction hash",
      );
    }
    if (intent.status === "consuming" || wrapIntentMatchesOutcome(intent, activity, outcome)) {
      return;
    }
  } else {
    if (activity.txHash === null) {
      throw new LinkedTransactionSettlementConflictError(
        "aa",
        "a wrap chain verdict has no staged transaction hash",
      );
    }
    if (
      intent.status === "consuming"
      || intent.status === "broadcast_unconfirmed"
      || wrapIntentMatchesOutcome(intent, activity, outcome)
    ) {
      return;
    }
  }
  throw new LinkedTransactionSettlementConflictError(
    "wwi",
    `the wrap intent is ${intent.status}, which is incompatible with ${outcome}`,
  );
}

/**
 * Move the wrap intent to the terminal `outcome` states, inside the
 * coordinator's transaction.
 *
 * A `consuming` row is first advanced to `broadcast_unconfirmed` with the hash
 * the ACTIVITY row carries, because that is the only status the terminal CAS
 * predicates accept and because it is the truthful intermediate: bytes were on
 * the network before the verdict arrived.
 */
export async function settleWrapIntent(
  client: PoolClient,
  initial: WalletWrapIntent,
  activity: AgentActivityEvent,
  outcome: LinkedIntentRepairOutcome,
  hooks: LinkedSettlementHooks,
): Promise<void> {
  if (wrapIntentMatchesOutcome(initial, activity, outcome)) return;

  let current = initial;
  if (
    outcome !== "crashed_before_broadcast"
    && outcome !== "signed_not_submitted"
    && current.status === "consuming"
  ) {
    const txHash = activity.txHash;
    if (txHash === null) {
      throw new LinkedTransactionSettlementConflictError("aa", "the staged wrap hash vanished");
    }
    const moved = await wrapIntentsRepo.markBroadcastUnconfirmedWith(
      client,
      current.intentId,
      current.sessionId,
      txHash,
    );
    await hooks.afterWrite?.("intent_broadcast_unconfirmed");
    if (moved === null) {
      throw new LinkedTransactionSettlementConflictError(
        "wwi",
        "the consuming wrap intent could not move to broadcast_unconfirmed",
      );
    }
    current = moved;
  }

  const written = await writeWrapIntentOutcome(client, current, outcome);
  await hooks.afterWrite?.("intent_terminal");
  if (written !== null) return;

  const reread = await wrapIntentsRepo.getByIdWith(client, current.intentId, current.sessionId);
  if (reread !== null && wrapIntentMatchesOutcome(reread, activity, outcome)) return;
  throw new LinkedTransactionSettlementConflictError(
    "wwi",
    "the wrap intent terminal CAS lost to an incompatible durable state",
  );
}

function writeWrapIntentOutcome(
  client: PoolClient,
  intent: WalletWrapIntent,
  outcome: LinkedIntentRepairOutcome,
): Promise<WalletWrapIntent | null> {
  switch (outcome) {
    case "confirmed":
      return wrapIntentsRepo.settleUnconfirmedAsExecutedWith(
        client,
        intent.intentId,
        intent.sessionId,
      );
    case "reverted":
      return wrapIntentsRepo.settleUnconfirmedAsChainFailedWith(
        client,
        intent.intentId,
        intent.sessionId,
        "RepairLane:chain_reverted",
      );
    case "superseded_unproven":
      return wrapIntentsRepo.markSupersededUnprovenWith(
        client,
        intent.intentId,
        intent.sessionId,
        "RepairLane:superseded_unproven",
      );
    case "crashed_before_broadcast":
      return wrapIntentsRepo.markCrashedBeforeBroadcastWith(
        client,
        intent.intentId,
        intent.sessionId,
        "CrashRecovery:no_staged_hash",
      );
    case "signed_not_submitted":
      return wrapIntentsRepo.markPreBroadcastFailedWith(
        client,
        intent.intentId,
        intent.sessionId,
        "PreBroadcast:signed_not_submitted",
      );
  }
}

/** Does the durable wrap row ALREADY state this outcome, hash included? */
export function wrapIntentMatchesOutcome(
  intent: WalletWrapIntent,
  activity: AgentActivityEvent,
  outcome: LinkedIntentRepairOutcome,
): boolean {
  switch (outcome) {
    case "confirmed":
      return intent.status === "executed" && intent.txHash === activity.txHash;
    case "reverted":
      return intent.status === "failed"
        && intent.failureStage === "chain_reverted"
        && intent.txHash === activity.txHash;
    case "superseded_unproven":
      return intent.status === "superseded_unproven" && intent.txHash === activity.txHash;
    case "crashed_before_broadcast":
      return intent.status === "failed"
        && intent.failureStage === "crashed_before_broadcast"
        && intent.txHash === null;
    case "signed_not_submitted":
      return intent.status === "failed"
        && intent.failureStage === "pre_broadcast"
        && intent.txHash === null;
  }
}

/**
 * The wrap counterpart of the coordinator's `recoverLinkedBroadcastUnconfirmed`
 * intent half: a staged hash proves a broadcast MAY have happened, so a
 * `consuming` row becomes `broadcast_unconfirmed` and the activity row is left
 * exactly as it is - staged-with-hash is precisely what makes it a candidate of
 * the lane that owns chain observation.
 */
export async function recoverWrapIntentUnconfirmed(
  client: PoolClient,
  intent: WalletWrapIntent,
  txHash: string,
  hooks: LinkedSettlementHooks,
): Promise<void> {
  if (intent.status === "broadcast_unconfirmed" && intent.txHash === txHash) return;
  if (intent.status !== "consuming") {
    throw new LinkedTransactionSettlementConflictError(
      "wwi",
      `the wrap intent is ${intent.status}, not a compatible broadcast_unconfirmed row`,
    );
  }
  const moved = await wrapIntentsRepo.markBroadcastUnconfirmedWith(
    client,
    intent.intentId,
    intent.sessionId,
    txHash,
  );
  await hooks.afterWrite?.("intent_broadcast_unconfirmed");
  if (moved === null) {
    throw new LinkedTransactionSettlementConflictError(
      "wwi",
      "the consuming wrap intent could not move to broadcast_unconfirmed",
    );
  }
}
