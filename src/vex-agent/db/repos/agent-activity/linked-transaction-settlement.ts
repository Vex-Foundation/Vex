/**
 * Atomic repair settlement for one signed transaction's linked intent,
 * agent_activity (AA), and protocol_executions (PE) rows. The intent is either
 * wallet_transaction_intents (WTI) or the transfer-specific wallet_intents.
 *
 * The pool-level activity terminalizers call this coordinator. It takes the
 * session control lock once, runs their ordinary client-bound AA CAS, advances
 * the linked WTI from consuming or broadcast_unconfirmed, and releases an
 * intent PE row before committing. Any throw rolls back every applied write.
 *
 * Client-bound activity terminalizers do not call this coordinator. They are
 * primitives for callers such as the handler settlement that already own a
 * wider transaction and the same session lock.
 */

import type { PoolClient } from "pg";

import { completeExecutionIntentWith, readExecutionCompletionWith } from "../executions.js";
import * as intentsRepo from "../wallet-transaction-intents.js";
import type { WalletTransactionIntent } from "../wallet-transaction-intents.js";
import * as transferIntentsRepo from "../wallet-intents.js";
import type { WalletIntent } from "../wallet-intents.js";
import { withActivitySessionLock } from "./session-lock.js";
import type { AgentActivityEvent, AgentActivityFailureCode, CasResult } from "./types.js";
import { getActivityEventByIdWith } from "./swap-lifecycle/reads.js";

export type LinkedIntentRepairOutcome =
  | "confirmed"
  | "reverted"
  | "superseded_unproven"
  | "crashed_before_broadcast"
  | "signed_not_submitted";

export type LinkedActivityTarget =
  | { readonly status: "confirmed" }
  | {
      readonly status: "definitively_failed";
      readonly failureCode: AgentActivityFailureCode;
    }
  | { readonly status: "superseded_unproven" };

export type LinkedSettlementWritePoint =
  | "activity_terminal"
  | "intent_broadcast_unconfirmed"
  | "intent_terminal"
  | "execution_terminal";

/** Used by real-Postgres tests to interrupt the production transaction. */
export interface LinkedSettlementHooks {
  readonly afterWrite?: (point: LinkedSettlementWritePoint) => Promise<void> | void;
}

export type LinkedActivityWriteResult = CasResult & {
  readonly reason?: "claim_lost" | "not_pending" | "window_not_elapsed";
};

export interface LinkedActivitySettlementInput<T extends LinkedActivityWriteResult> {
  readonly activityId: number;
  readonly sessionId: string | null;
  readonly intentOutcome: LinkedIntentRepairOutcome;
  readonly activityTarget: LinkedActivityTarget;
  readonly activityWrite: (client: PoolClient) => Promise<T>;
}

export class LinkedTransactionSettlementConflictError extends Error {
  readonly row: "wti" | "wi" | "aa" | "pe";

  constructor(row: "wti" | "wi" | "aa" | "pe", detail: string) {
    super(`linked transaction repair settlement conflict on ${row}: ${detail}`);
    this.name = "LinkedTransactionSettlementConflictError";
    this.row = row;
  }
}

/**
 * Terminalize AA, WTI, and PE in one transaction. A missing linked WTI keeps
 * the old AA-only behavior, which is correct for ordinary protocol activities.
 */
export async function settleLinkedActivityRows<T extends LinkedActivityWriteResult>(
  input: LinkedActivitySettlementInput<T>,
  hooks: LinkedSettlementHooks = {},
): Promise<T> {
  return withActivitySessionLock(input.sessionId, (client) =>
    settleLinkedActivityRowsWith(client, input, hooks));
}

/**
 * Client-bound form for a caller that already owns the session control lock.
 * This is used by multi-row terminalizers so their AA writes and every linked
 * intent/PE settlement still commit or roll back as one transaction.
 */
export async function settleLinkedActivityRowsWith<T extends LinkedActivityWriteResult>(
  client: PoolClient,
  input: LinkedActivitySettlementInput<T>,
  hooks: LinkedSettlementHooks = {},
): Promise<T> {
  const activity = await requireActivity(client, input.activityId, input.sessionId);
  const transactionIntent = await intentsRepo.getByActivityIdWith(client, input.activityId);
  const transferIntent = await transferIntentsRepo.getByActivityIdWith(client, input.activityId);
  if (transactionIntent !== null && transferIntent !== null) {
    throw new LinkedTransactionSettlementConflictError(
      "aa",
      "the activity row is linked by two wallet intent state machines",
    );
  }
  if (transactionIntent !== null) {
    await validateLinkedRows(
      client,
      activity,
      transactionIntent,
      input.activityId,
      input.sessionId,
    );
    assertIntentCanSettle(transactionIntent, activity, input.intentOutcome);
  }
  if (transferIntent !== null) {
    validateTransferLinkedRows(activity, transferIntent, input.activityId, input.sessionId);
    assertTransferIntentCanSettle(transferIntent, activity, input.intentOutcome);
  }

  const result = await input.activityWrite(client);
  await hooks.afterWrite?.("activity_terminal");

  if (
    input.intentOutcome === "signed_not_submitted"
    && !persistedActivityProvesOutcome(result.row, input.intentOutcome)
  ) {
    throw new LinkedTransactionSettlementConflictError(
      "aa",
      "signed-not-submitted settlement did not produce hash-bearing broadcast-error evidence",
    );
  }

  if (
    !result.applied
    && !activityMatchesTarget(result.row, input.activityTarget)
    && !persistedActivityProvesOutcome(result.row, input.intentOutcome)
  ) {
    return result;
  }
  if (transactionIntent === null && transferIntent === null) return result;

  if (transactionIntent !== null) {
    await settleIntent(client, transactionIntent, activity, input.intentOutcome, hooks);
    await settleExecution(client, activity.protocolExecutionId, input.intentOutcome, hooks);
  }
  if (transferIntent !== null) {
    await settleTransferIntent(client, transferIntent, activity, input.intentOutcome, hooks);
    await settleExecution(client, activity.protocolExecutionId, input.intentOutcome, hooks);
  }
  return result;
}

/**
 * A hashless definitive failure is durable proof that staging never happened.
 * Its exact failure code is not chain evidence and must not strand a linked
 * intent merely because an older writer used `unknown` instead of the current
 * `broadcast_error` vocabulary. This exception is deliberately one-way: it
 * cannot adopt a hash-bearing row, a confirmed row, or any non-crash outcome.
 */
function persistedActivityProvesOutcome(
  activity: AgentActivityEvent,
  outcome: LinkedIntentRepairOutcome,
): boolean {
  if (activity.status !== "definitively_failed") return false;
  if (outcome === "crashed_before_broadcast") return activity.txHash === null;
  return outcome === "signed_not_submitted"
    && activity.txHash !== null
    && activity.failureCode === "broadcast_error";
}

/**
 * T4b: a staged hash proves a broadcast may have happened, so this function
 * does not change AA while WTI becomes broadcast_unconfirmed and PE stops
 * being intent. Both writes commit together. Leaving AA unchanged also lets
 * this converge a terminal legacy row whose failure code carries no chain
 * verdict the transaction intent may adopt.
 */
export async function recoverLinkedBroadcastUnconfirmed(
  activityId: number,
  sessionId: string,
  hooks: LinkedSettlementHooks = {},
): Promise<boolean> {
  return withActivitySessionLock(sessionId, async (client) => {
    const activity = await requireActivity(client, activityId, sessionId);
    if (activity.txHash === null) return false;

    const intent = await intentsRepo.getByActivityIdWith(client, activityId);
    if (intent === null) {
      throw new LinkedTransactionSettlementConflictError("wti", "the linked intent is missing");
    }
    await validateLinkedRows(client, activity, intent, activityId, sessionId);

    if (intent.status === "consuming") {
      const moved = await intentsRepo.markBroadcastUnconfirmedWith(
        client,
        intent.intentId,
        sessionId,
        activity.txHash,
      );
      await hooks.afterWrite?.("intent_broadcast_unconfirmed");
      if (moved === null) {
        throw new LinkedTransactionSettlementConflictError(
          "wti",
          "the consuming intent could not move to broadcast_unconfirmed",
        );
      }
    } else if (!isCompatibleUnconfirmed(intent, activity.txHash)) {
      throw new LinkedTransactionSettlementConflictError(
        "wti",
        `the intent is ${intent.status}, not a compatible broadcast_unconfirmed row`,
      );
    }

    await settleExecutionAs(
      client,
      activity.protocolExecutionId,
      "broadcast_unconfirmed",
      false,
      hooks,
    );
    return true;
  });
}

/**
 * Legacy convergence for a transaction whose AA row was already terminal
 * before this build. WTI and PE still move atomically, and the persisted AA
 * verdict is validated before either write.
 */
export async function settleFromPersistedTerminalActivity(
  activityId: number,
  sessionId: string,
  outcome: Exclude<
    LinkedIntentRepairOutcome,
    "crashed_before_broadcast" | "signed_not_submitted"
  >,
  hooks: LinkedSettlementHooks = {},
): Promise<boolean> {
  return withActivitySessionLock(sessionId, async (client) => {
    const activity = await requireActivity(client, activityId, sessionId);
    if (!activityMatchesOutcome(activity, outcome)) return false;

    const intent = await intentsRepo.getByActivityIdWith(client, activityId);
    if (intent === null) return false;
    await validateLinkedRows(client, activity, intent, activityId, sessionId);
    assertIntentCanSettle(intent, activity, outcome);
    await settleIntent(client, intent, activity, outcome, hooks);
    await settleExecution(client, activity.protocolExecutionId, outcome, hooks);
    return true;
  });
}

async function requireActivity(
  client: PoolClient,
  activityId: number,
  expectedSessionId: string | null,
): Promise<AgentActivityEvent> {
  const activity = await getActivityEventByIdWith(client, activityId);
  if (activity === null) {
    throw new LinkedTransactionSettlementConflictError("aa", "the activity row is missing");
  }
  if (activity.sessionId !== expectedSessionId) {
    throw new LinkedTransactionSettlementConflictError(
      "aa",
      "the activity row belongs to a different session",
    );
  }
  return activity;
}

async function validateLinkedRows(
  client: PoolClient,
  activity: AgentActivityEvent,
  intent: WalletTransactionIntent,
  activityId: number,
  sessionId: string | null,
): Promise<void> {
  if (sessionId === null || intent.sessionId !== sessionId) {
    throw new LinkedTransactionSettlementConflictError(
      "wti",
      "the linked intent belongs to a different session",
    );
  }
  if (intent.activityId !== String(activityId)) {
    throw new LinkedTransactionSettlementConflictError(
      "wti",
      "the intent no longer points at this activity row",
    );
  }
  const execution = await readExecutionCompletionWith(client, activity.protocolExecutionId);
  if (execution === null) {
    throw new LinkedTransactionSettlementConflictError("pe", "the execution row is missing");
  }
}

function validateTransferLinkedRows(
  activity: AgentActivityEvent,
  intent: WalletIntent,
  activityId: number,
  sessionId: string | null,
): void {
  if (sessionId === null || intent.sessionId !== sessionId) {
    throw new LinkedTransactionSettlementConflictError(
      "wi",
      "the linked transfer intent belongs to a different session",
    );
  }
  if (intent.activityId !== String(activityId)) {
    throw new LinkedTransactionSettlementConflictError(
      "wi",
      "the transfer intent no longer points at this activity row",
    );
  }
  if (activity.eventRole !== "wallet_transfer" || activity.kind !== "transfer") {
    throw new LinkedTransactionSettlementConflictError(
      "aa",
      "a transfer intent points at a non-transfer activity row",
    );
  }
  if (intent.network !== activity.chainFamily) {
    throw new LinkedTransactionSettlementConflictError(
      "wi",
      "the transfer intent and activity row disagree on chain family",
    );
  }
}

function assertTransferIntentCanSettle(
  intent: WalletIntent,
  activity: AgentActivityEvent,
  outcome: LinkedIntentRepairOutcome,
): void {
  if (outcome === "signed_not_submitted") {
    if (activity.txHash === null) {
      throw new LinkedTransactionSettlementConflictError(
        "aa",
        "signed-not-submitted transfer settlement has no staged signature",
      );
    }
    if (intent.status === "consuming" || transferIntentMatchesOutcome(intent, activity, outcome)) {
      return;
    }
    throw new LinkedTransactionSettlementConflictError(
      "wi",
      `the transfer intent is ${intent.status}, which is incompatible with ${outcome}`,
    );
  }
  if (outcome === "crashed_before_broadcast") {
    if (activity.txHash !== null) {
      throw new LinkedTransactionSettlementConflictError(
        "aa",
        "crashed-before-broadcast transfer settlement found a staged hash",
      );
    }
    if (intent.status === "consuming" || transferIntentMatchesOutcome(intent, activity, outcome)) {
      return;
    }
  } else {
    if (activity.txHash === null) {
      throw new LinkedTransactionSettlementConflictError(
        "aa",
        "a transfer chain verdict has no staged hash",
      );
    }
    if (
      intent.status === "consuming"
      || intent.status === "broadcast_unconfirmed"
      || transferIntentMatchesOutcome(intent, activity, outcome)
    ) {
      return;
    }
  }
  throw new LinkedTransactionSettlementConflictError(
    "wi",
    `the transfer intent is ${intent.status}, which is incompatible with ${outcome}`,
  );
}

async function settleTransferIntent(
  client: PoolClient,
  intent: WalletIntent,
  activity: AgentActivityEvent,
  outcome: LinkedIntentRepairOutcome,
  hooks: LinkedSettlementHooks,
): Promise<void> {
  if (transferIntentMatchesOutcome(intent, activity, outcome)) return;
  const activityId = Number(intent.activityId);
  if (!Number.isSafeInteger(activityId)) {
    throw new LinkedTransactionSettlementConflictError("wi", "the activity link is not an integer");
  }

  let written: WalletIntent | null;
  switch (outcome) {
    case "confirmed": {
      const txHash = requireTransferHash(activity);
      written = await transferIntentsRepo.settleLinkedAsExecutedWith(
        client,
        intent.intentId,
        intent.sessionId,
        activityId,
        txHash,
      );
      break;
    }
    case "reverted": {
      const txHash = requireTransferHash(activity);
      written = await transferIntentsRepo.settleLinkedAsFailedWith(
        client,
        intent.intentId,
        intent.sessionId,
        activityId,
        txHash,
      );
      break;
    }
    case "superseded_unproven": {
      const txHash = requireTransferHash(activity);
      written = await transferIntentsRepo.settleLinkedAsSupersededWith(
        client,
        intent.intentId,
        intent.sessionId,
        activityId,
        txHash,
      );
      break;
    }
    case "crashed_before_broadcast":
      written = await transferIntentsRepo.settleLinkedAsCrashedBeforeBroadcastWith(
        client,
        intent.intentId,
        intent.sessionId,
        activityId,
      );
      break;
    case "signed_not_submitted":
      written = await transferIntentsRepo.settleLinkedAsSignedNotSubmittedWith(
        client,
        intent.intentId,
        intent.sessionId,
        activityId,
      );
      break;
  }
  await hooks.afterWrite?.("intent_terminal");
  if (written !== null) return;

  const reread = await transferIntentsRepo.getByActivityIdWith(client, activityId);
  if (reread !== null && transferIntentMatchesOutcome(reread, activity, outcome)) return;
  throw new LinkedTransactionSettlementConflictError(
    "wi",
    "the transfer intent terminal CAS lost to an incompatible durable state",
  );
}

function requireTransferHash(activity: AgentActivityEvent): string {
  if (activity.txHash === null) {
    throw new LinkedTransactionSettlementConflictError("aa", "the staged transfer hash vanished");
  }
  return activity.txHash;
}

function transferIntentMatchesOutcome(
  intent: WalletIntent,
  activity: AgentActivityEvent,
  outcome: LinkedIntentRepairOutcome,
): boolean {
  switch (outcome) {
    case "confirmed":
      return intent.status === "executed" && intent.txHash === activity.txHash;
    case "reverted":
      return intent.status === "failed" && intent.txHash === activity.txHash;
    case "superseded_unproven":
      return intent.status === "superseded_unproven" && intent.txHash === activity.txHash;
    case "crashed_before_broadcast":
      return intent.status === "failed"
        && intent.txHash === null
        && intent.failureReason === "CrashRecovery:no_staged_hash";
    case "signed_not_submitted":
      return intent.status === "failed"
        && intent.txHash === null
        && intent.failureReason === "PreBroadcast:signed_not_submitted";
  }
}

function assertIntentCanSettle(
  intent: WalletTransactionIntent,
  activity: AgentActivityEvent,
  outcome: LinkedIntentRepairOutcome,
): void {
  if (outcome === "signed_not_submitted") {
    if (activity.txHash === null) {
      throw new LinkedTransactionSettlementConflictError(
        "aa",
        "signed-not-submitted transaction settlement has no staged signature",
      );
    }
    if (intent.status === "consuming" || intentMatchesOutcome(intent, activity, outcome)) return;
    throw new LinkedTransactionSettlementConflictError(
      "wti",
      `the intent is ${intent.status}, which is incompatible with ${outcome}`,
    );
  }
  if (outcome === "crashed_before_broadcast") {
    if (activity.txHash !== null) {
      throw new LinkedTransactionSettlementConflictError(
        "aa",
        "crashed-before-broadcast settlement found a staged transaction hash",
      );
    }
    if (intent.status === "consuming" || intentMatchesOutcome(intent, activity, outcome)) return;
  } else {
    if (activity.txHash === null) {
      throw new LinkedTransactionSettlementConflictError(
        "aa",
        "a chain verdict has no staged transaction hash",
      );
    }
    if (
      intent.status === "consuming"
      || intent.status === "broadcast_unconfirmed"
      || intentMatchesOutcome(intent, activity, outcome)
    ) {
      return;
    }
  }
  throw new LinkedTransactionSettlementConflictError(
    "wti",
    `the intent is ${intent.status}, which is incompatible with ${outcome}`,
  );
}

async function settleIntent(
  client: PoolClient,
  initial: WalletTransactionIntent,
  activity: AgentActivityEvent,
  outcome: LinkedIntentRepairOutcome,
  hooks: LinkedSettlementHooks,
): Promise<void> {
  if (intentMatchesOutcome(initial, activity, outcome)) return;

  let current = initial;
  if (
    outcome !== "crashed_before_broadcast"
    && outcome !== "signed_not_submitted"
    && current.status === "consuming"
  ) {
    const txHash = activity.txHash;
    if (txHash === null) {
      throw new LinkedTransactionSettlementConflictError("aa", "the staged hash vanished");
    }
    const moved = await intentsRepo.markBroadcastUnconfirmedWith(
      client,
      current.intentId,
      current.sessionId,
      txHash,
    );
    await hooks.afterWrite?.("intent_broadcast_unconfirmed");
    if (moved === null) {
      throw new LinkedTransactionSettlementConflictError(
        "wti",
        "the consuming intent could not move to broadcast_unconfirmed",
      );
    }
    current = moved;
  }

  const written = await writeIntentOutcome(client, current, outcome);
  await hooks.afterWrite?.("intent_terminal");
  if (written !== null) return;

  const reread = await intentsRepo.getByIdWith(client, current.intentId, current.sessionId);
  if (reread !== null && intentMatchesOutcome(reread, activity, outcome)) return;
  throw new LinkedTransactionSettlementConflictError(
    "wti",
    "the intent terminal CAS lost to an incompatible durable state",
  );
}

function writeIntentOutcome(
  client: PoolClient,
  intent: WalletTransactionIntent,
  outcome: LinkedIntentRepairOutcome,
): Promise<WalletTransactionIntent | null> {
  switch (outcome) {
    case "confirmed":
      return intentsRepo.settleUnconfirmedAsExecutedWith(client, intent.intentId, intent.sessionId);
    case "reverted":
      return intentsRepo.settleUnconfirmedAsChainFailedWith(
        client,
        intent.intentId,
        intent.sessionId,
        "RepairLane:chain_reverted",
      );
    case "superseded_unproven":
      return intentsRepo.markSupersededUnprovenWith(
        client,
        intent.intentId,
        intent.sessionId,
        "RepairLane:superseded_unproven",
      );
    case "crashed_before_broadcast":
      return intentsRepo.markCrashedBeforeBroadcastWith(
        client,
        intent.intentId,
        intent.sessionId,
        "CrashRecovery:no_staged_hash",
      );
    case "signed_not_submitted":
      return intentsRepo.markPreBroadcastFailedWith(
        client,
        intent.intentId,
        intent.sessionId,
        "PreBroadcast:signed_not_submitted",
      );
  }
}

function intentMatchesOutcome(
  intent: WalletTransactionIntent,
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

function isCompatibleUnconfirmed(intent: WalletTransactionIntent, txHash: string): boolean {
  return intent.status === "broadcast_unconfirmed" && intent.txHash === txHash;
}

function activityMatchesTarget(
  activity: AgentActivityEvent,
  target: LinkedActivityTarget,
): boolean {
  if (activity.status !== target.status) return false;
  return target.status !== "definitively_failed" || activity.failureCode === target.failureCode;
}

function activityMatchesOutcome(
  activity: AgentActivityEvent,
  outcome: Exclude<
    LinkedIntentRepairOutcome,
    "crashed_before_broadcast" | "signed_not_submitted"
  >,
): boolean {
  if (outcome === "confirmed") return activity.status === "confirmed";
  if (outcome === "reverted") {
    return activity.status === "definitively_failed" && activity.failureCode === "mined_revert";
  }
  return activity.status === "superseded_unproven"
    || (activity.status === "definitively_failed"
      && activity.failureCode === "solana_signature_expired");
}

async function settleExecution(
  client: PoolClient,
  executionId: number,
  outcome: LinkedIntentRepairOutcome,
  hooks: LinkedSettlementHooks,
): Promise<void> {
  switch (outcome) {
    case "confirmed":
      await settleExecutionAs(client, executionId, "confirmed", true, hooks);
      return;
    case "reverted":
      await settleExecutionAs(client, executionId, "reverted", false, hooks);
      return;
    case "superseded_unproven":
      await settleExecutionAs(client, executionId, "superseded_unproven", false, hooks);
      return;
    case "crashed_before_broadcast":
      await settleExecutionAs(client, executionId, "crashed_before_broadcast", false, hooks);
      return;
    case "signed_not_submitted":
      await settleExecutionAs(client, executionId, "signed_not_submitted", false, hooks);
      return;
  }
}

async function settleExecutionAs(
  client: PoolClient,
  executionId: number,
  status: string,
  success: boolean,
  hooks: LinkedSettlementHooks,
): Promise<void> {
  await completeExecutionIntentWith(client, {
    executionId,
    result: { status, settledBy: "repair" },
    success,
    tradeCapture: null,
    externalRefs: {},
    durationMs: 0,
  });
  await hooks.afterWrite?.("execution_terminal");
}
