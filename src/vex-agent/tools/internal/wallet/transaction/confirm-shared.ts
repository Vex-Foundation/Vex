/**
 * What the two generic-signing confirm handlers share: the gate order, the
 * approval binding, and the durable settlement of every outcome (T3a-T3d).
 *
 * The family handlers own the CHAIN half - which client, which signature, which
 * simulation. This module owns the ORDER, and the order is the contract:
 *
 *   1. read the intent, SESSION-SCOPED; a cross-session id misses;
 *   2. refuse a cross-FAMILY intent by name - the transfer confirm cannot
 *      consume a transaction intent and neither confirm may consume the other
 *      family's;
 *   3. rebuild the approval binding from the durable row;
 *   4. resolve the APPROVAL-BOUND digest, fail-closed on an approved resume;
 *   5. revalidate the row: status, expiry, digest recompute, bound digest;
 *   6. THE APPROVAL GATE - a restricted session stops here, having decrypted
 *      nothing and claimed nothing, and the intent stays `pending`;
 *   7. resolve AND decrypt the signer, then prove it is the approved wallet;
 *   8. the family's own commit-time checks (chain identity, fresh decode, fresh
 *      simulation, block height, fee bounds);
 *   9. T2 - claim the intent and create both durable rows in ONE transaction
 *      that COMMITS before anything is signed;
 *  10. execute, then settle all three rows per the lifecycle table.
 *
 * Steps 1 to 8 all refuse with NOTHING SIGNED, NOTHING CLAIMED and the intent
 * still `pending`, which is the shape from which preparing again is safe.
 */

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import * as intentsRepo from "@vex-agent/db/repos/wallet-transaction-intents.js";
import type { WalletTransactionIntent } from "@vex-agent/db/repos/wallet-transaction-intents.js";
import type { WalletTransactionFamily } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import { readApprovalProposalBinding } from "@vex-agent/engine/core/approval-runtime/tool-call-envelope.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../types.js";
import type { InternalToolContext } from "../../types.js";
import { resolveSigningWallet, walletScopeErrorToResult } from "../resolve.js";
import { summarizeWalletError } from "../send-types.js";
import { failWith, ok } from "../send/results.js";

import { bindingFromDurableIntent, type PreparedApprovalBinding } from "./approval-binding.js";
import type { TransactionActivity, TransactionClaim } from "./activity-writer.js";
import { claimTransactionIntent } from "./activity-writer.js";
import { WALLET_TRANSACTION_INTENTS_RESOURCE } from "./proposal-digest.js";
import { accept, refuse, type TransactionOutcome } from "./refusal.js";
import { revalidateIntentRow, revalidateSigner } from "./revalidate.js";
import { refusalToResult, requireString } from "./tool-io.js";

/** What the family handler produced. The vocabulary of the T3 rows. */
export type TransactionExecution =
  | { readonly kind: "confirmed"; readonly txHash: string; readonly data: Record<string, unknown> }
  | {
      readonly kind: "chain_failed";
      readonly txHash: string;
      readonly chain: string;
      readonly errorKind: string;
      readonly errorHash: string;
    }
  | {
      readonly kind: "confirmation_unknown";
      readonly txHash: string;
      readonly chain: string;
      readonly errorKind: string;
      readonly errorHash: string;
    }
  | {
      readonly kind: "pre_broadcast_failed";
      readonly errorKind: string;
      readonly errorHash: string;
      /** The sentence the caller reads. Never raw provider text. */
      readonly message: string;
      /**
       * TRUE when the failure was the STAGED-EVIDENCE write, which happens
       * after the claim committed and before anything reached the network. It
       * is its own durable status (`audit_failed`) so investigation tooling can
       * find "our audit write broke" without trawling every failure.
       */
      readonly auditFailed?: true;
    };

// ── Step 4: the approval-bound digest ──────────────────────────────────

/**
 * The digest the APPROVAL was granted for, or `null` when this dispatch is not
 * an approved resume.
 *
 * FAIL CLOSED, and this is the whole reason the function exists. When the
 * dispatch IS an approved resume, the approval row must exist, must belong to
 * this session, must carry a binding, and that binding must name THIS intent in
 * THIS table. Any of those missing means the approval cannot be shown to be
 * about this proposal, and a money-path action that cannot prove its authority
 * does not proceed.
 *
 * `null` is returned only for a call that never went through an approval at all
 * - a full-permission session signing directly. That call has no second digest
 * to compare against; the row's own integrity check still runs.
 */
export async function resolveApprovalBoundDigest(
  context: InternalToolContext,
  intent: WalletTransactionIntent,
): Promise<TransactionOutcome<string | null>> {
  if (!context.approved) return accept<string | null>(null);

  const approvalId = context.approvalId;
  if (approvalId === undefined || approvalId === null || approvalId === "") {
    return refuse(
      "invalid_input",
      "Refusing to sign: this call is marked approved but names no approval, so Vex cannot check "
      + "that the approval was granted for this exact transaction. Nothing was signed and no funds "
      + "moved. Prepare the transaction again and approve it.",
      { intentId: intent.intentId },
    );
  }

  const approval = await approvalsRepo.getByIdForSession(approvalId, context.sessionId);
  if (approval === null) {
    return refuse(
      "invalid_input",
      "Refusing to sign: the approval this call names does not exist for this session. Nothing was "
      + "signed and no funds moved.",
      { intentId: intent.intentId },
    );
  }

  const bound = readApprovalProposalBinding(approval.toolCall);
  if (bound === null) {
    return refuse(
      "invalid_input",
      "Refusing to sign: the approval this call names carries no record of WHICH transaction was "
      + "approved, so it cannot authorize this one. Nothing was signed and no funds moved. Prepare "
      + "the transaction again and request a fresh approval.",
      { intentId: intent.intentId },
    );
  }

  if (
    bound.resource.table !== WALLET_TRANSACTION_INTENTS_RESOURCE
    || bound.resource.intentId !== intent.intentId
  ) {
    return refuse(
      "invalid_input",
      "Refusing to sign: the approval this call names was granted for a different prepared action, "
      + "so it does not authorize this intent. Nothing was signed and no funds moved.",
      { intentId: intent.intentId },
    );
  }

  return accept<string | null>(bound.proposalDigest);
}

// ── Steps 1 to 7: everything before the family's own chain work ────────

export type GateOutcome =
  /** A `ToolResult` the handler must return as-is: a refusal, or the approval stop. */
  | { readonly kind: "return"; readonly result: ToolResult }
  | {
      readonly kind: "proceed";
      readonly intent: WalletTransactionIntent;
      readonly signer: ChainWallet;
      readonly binding: PreparedApprovalBinding;
    };

/**
 * Run steps 1 to 7 for `family`. Returns either the `ToolResult` to hand back
 * or the validated intent plus the decrypted signer.
 */
export async function gateConfirm(
  params: Record<string, unknown>,
  context: InternalToolContext,
  family: WalletTransactionFamily,
): Promise<GateOutcome> {
  const intentIdParam = requireString(params, "intentId");
  if (!intentIdParam.ok) {
    return { kind: "return", result: refusalToResult(intentIdParam.refusal) };
  }
  const intentId = intentIdParam.value;

  const intent = await intentsRepo.getById(intentId, context.sessionId);
  if (intent === null) {
    return {
      kind: "return",
      result: refusalToResult({
        code: "invalid_input",
        message:
          `Refusing to sign: no prepared transaction intent ${intentId} exists for this session. An `
          + "intent id is scoped to the session that prepared it. Nothing was signed.",
        details: { intentId },
      }),
    };
  }

  if (intent.family !== family) {
    // CROSS-KIND / CROSS-FAMILY, refused BY NAME. The two confirms and the
    // transfer confirm each own one shape, and a confirm that consumed
    // another's row would broadcast a plan built from a payload it never read.
    return {
      kind: "return",
      result: refusalToResult({
        code: "invalid_input",
        message:
          `Refusing to sign: intent ${intentId} was prepared for ${intent.family}, and this tool `
          + `confirms ${family} transactions. Nothing was signed. Use the confirm tool for `
          + `${intent.family}.`,
        details: { intentId, intentFamily: intent.family, toolFamily: family },
      }),
    };
  }

  const binding = bindingFromDurableIntent(intent);
  if (!binding.ok) return { kind: "return", result: refusalToResult(binding.refusal) };

  const boundDigest = await resolveApprovalBoundDigest(context, intent);
  if (!boundDigest.ok) return { kind: "return", result: refusalToResult(boundDigest.refusal) };

  const row = revalidateIntentRow(intent, boundDigest.value);
  if (!row.ok) return { kind: "return", result: refusalToResult(row.refusal) };

  if (!context.approved && context.sessionPermission === "restricted") {
    // NOTHING has been decrypted, claimed or written. The intent stays
    // `pending` for the approve-then-resume cycle, and the binding is what the
    // approval will be bound to: the decoded effect the user reads, this
    // intent's own expiry, and the proposal digest.
    return {
      kind: "return",
      result: {
        success: false,
        output:
          "This transaction needs approval before it can be signed. Nothing was signed and no funds "
          + `moved: intent ${intentId} is still pending and will be consumed only after the user `
          + "confirms the exact proposal shown.",
        pendingApproval: true,
        // STAMPED HERE rather than left to the dispatcher's registry fallback.
        // The risk class is what the approval card shows and what the policy
        // layer classifies the action by, and an approval that reached the
        // queue without one is refused by the Studio seam as a registration
        // bug - so the handler that knows it states it.
        actionKind: "user_wallet_broadcast",
        preparedApprovalBinding: binding.value,
      },
    };
  }

  // The key is decrypted HERE - after the approval gate, and only to prove and
  // then use the authority the approval was granted for.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, intent.family);
  } catch (err) {
    return { kind: "return", result: walletScopeErrorToResult(err) };
  }
  const signerCheck = revalidateSigner(intent, signer);
  if (!signerCheck.ok) return { kind: "return", result: refusalToResult(signerCheck.refusal) };

  return { kind: "proceed", intent, signer, binding: binding.value };
}

// ── Step 9: T2 ─────────────────────────────────────────────────────────

/** Claim, or the `ToolResult` explaining why nothing was claimed. */
export async function claimOrRefuse(
  intent: WalletTransactionIntent,
): Promise<{ kind: "claimed"; claim: Extract<TransactionClaim, { ok: true }> } | { kind: "return"; result: ToolResult }> {
  const claim = await claimTransactionIntent(intent, intent.proposalDigest);
  if (claim.ok) return { kind: "claimed", claim };
  return {
    kind: "return",
    result: refusalToResult({
      code: "invalid_input",
      message:
        `Refusing to sign: intent ${intent.intentId} could not be claimed - ${claim.detail}. Nothing `
        + "was signed and no funds moved; the intent was not consumed.",
      details: { intentId: intent.intentId, reason: claim.reason },
    }),
  };
}

// ── Step 10: settle all three rows ─────────────────────────────────────

/** Metadata-only explorer ref, model-invisible. Same channel the transfer path uses. */
function explorerRefsData(chain: string, txHash: string): Record<string, unknown> {
  return { _explorerRefs: [{ chain, txRef: txHash }] };
}

/**
 * Settle the intent, the activity row and the execution row for one execution
 * outcome, then produce the `ToolResult`.
 *
 * THE EXECUTION ROW IS COMPLETED ON EVERY ARM, ambiguity included (T3d): the
 * tool attempt is over the moment this returns, and the compaction money-state
 * gate selects an `execution_status = 'intent'` row on its own, so leaving it
 * open would block compaction forever - even after a repair lane settled the
 * activity row and the intent.
 *
 * An intent CAS miss here is audit drift, not a different outcome: the
 * transaction is already real on chain and the `ToolResult` must say so. It is
 * logged structurally and never converted into a claim that the transaction
 * failed.
 */
export async function settleExecution(
  intent: WalletTransactionIntent,
  activity: TransactionActivity,
  execution: TransactionExecution,
  echo: Record<string, unknown>,
): Promise<ToolResult> {
  const { intentId, sessionId } = intent;

  switch (execution.kind) {
    case "confirmed": {
      await intentCas(
        intentId,
        sessionId,
        "executed",
        (client) => intentsRepo.markExecutedWith(client, intentId, sessionId, execution.txHash),
      );
      await activity.confirm();
      await activity.completeExecution({ kind: "confirmed", txHash: execution.txHash });
      return ok({
        intentId,
        status: "executed",
        outcome: "confirmed",
        txHash: execution.txHash,
        ...echo,
        ...execution.data,
      });
    }

    case "chain_failed": {
      await intentCas(
        intentId,
        sessionId,
        "failed",
        (client) =>
          intentsRepo.markChainFailedWith(
            client,
            intentId,
            sessionId,
            execution.txHash,
            `${execution.errorKind}:${execution.errorHash}`,
          ),
      );
      await activity.fail({
        failureCode: "mined_revert",
        failureReason: "the transaction reverted on-chain",
      });
      await activity.completeExecution({ kind: "reverted", txHash: execution.txHash });
      return failWith(
        `The transaction was broadcast and FAILED on-chain. It is real and the network fee was paid. `
        + `Tx hash: ${execution.txHash}. Error hash: ${execution.errorHash}. Intent ${intentId} is `
        + "terminal; preparing the same transaction again would send a second one.",
        {
          ...explorerRefsData(execution.chain, execution.txHash),
          outcome: "chain_failed",
          intentId,
          txHash: execution.txHash,
          ...echo,
        },
      );
    }

    case "confirmation_unknown": {
      // T3d. A NORMAL return, and never `failed`-with-a-hash: that shape cannot
      // be told apart from a revert, and a caller who reads "failed" retries.
      // The activity row stays staged-with-hash for the repair lane.
      await intentCas(
        intentId,
        sessionId,
        "broadcast_unconfirmed",
        (client) =>
          intentsRepo.markBroadcastUnconfirmedWith(client, intentId, sessionId, execution.txHash),
      );
      await activity.completeExecution({
        kind: "confirmation_unknown",
        txHash: execution.txHash,
      });
      return failWith(
        "The transaction was BROADCAST and its outcome is not yet known. It may be settling right "
        + `now. Tx hash: ${execution.txHash}. DO NOT send it again: Vex is tracking it and a repair `
        + "lane will settle it from chain evidence. Check the explorer for the current state.",
        {
          ...explorerRefsData(execution.chain, execution.txHash),
          outcome: "confirmation_unknown",
          intentId,
          txHash: execution.txHash,
          ...echo,
        },
      );
    }

    case "pre_broadcast_failed": {
      const reason = `${execution.errorKind}:${execution.errorHash}`;
      if (execution.auditFailed === true) {
        await intentCas(
          intentId,
          sessionId,
          "audit_failed",
          (client) => intentsRepo.markAuditFailedWith(client, intentId, sessionId, reason),
        );
      } else {
        await intentCas(
          intentId,
          sessionId,
          "failed",
          (client) => intentsRepo.markPreBroadcastFailedWith(client, intentId, sessionId, reason),
        );
      }
      await activity.fail({
        failureCode: "broadcast_error",
        failureReason: execution.auditFailed === true
          ? `AuditWriteFailed:${reason}`
          : `PreBroadcast:${reason}`,
      });
      await activity.completeExecution({ kind: "failed_before_broadcast" });
      return failWith(execution.message, {
        outcome: "pre_broadcast_failed",
        intentId,
        errorHash: execution.errorHash,
        ...echo,
      });
    }
  }
}

/**
 * Run one intent CAS under the session control lock and log a miss structurally.
 *
 * A miss means the row was not `consuming` at write time - operator action, or
 * a process-restart recovery that got there first. The transaction is already
 * whatever the chain made of it, so this never changes the answer the caller
 * receives; it changes only what an auditor can see.
 */
async function intentCas(
  intentId: string,
  sessionId: string,
  target: string,
  write: (client: Parameters<Parameters<typeof withSessionControlLock>[1]>[0]) => Promise<
    WalletTransactionIntent | null
  >,
): Promise<void> {
  try {
    const row = await withSessionControlLock(sessionId, write);
    if (row === null) {
      logger.warn("wallet.transaction.intent_status_mismatch", { intentId, sessionId, target });
    }
  } catch (err) {
    logger.warn("wallet.transaction.intent_write_failed", {
      intentId,
      sessionId,
      target,
      ...summarizeWalletError(err),
    });
  }
}
