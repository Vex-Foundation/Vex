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
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../types.js";
import type { InternalToolContext } from "../../types.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "../resolve.js";
import { summarizeWalletError } from "../send-types.js";
import { failWith, ok } from "../send/results.js";

import { bindingFromDurableIntent, type PreparedApprovalBinding } from "./approval-binding.js";
import type { TransactionActivity, TransactionClaim } from "./activity-writer.js";
import { claimTransactionIntent } from "./activity-writer.js";
import { WALLET_TRANSACTION_INTENTS_RESOURCE } from "./proposal-digest.js";
import { accept, refuse, type TransactionOutcome } from "./refusal.js";
import { revalidateIntentRow, revalidateSigner, revalidateSignerAddress } from "./revalidate.js";
import { captureAuthorityAnchor, recheckAuthorityWith, type AuthorityAnchor } from "./authority-fence.js";
import {
  settleTerminalRows,
  TerminalSettlementConflictError,
} from "./terminal-settlement.js";
import { refusalToResult, requireString } from "./tool-io.js";

export type { TransactionExecution } from "./execution-outcome.js";
import type { TransactionExecution } from "./execution-outcome.js";

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

/** The DECRYPTED signer, or the `ToolResult` explaining why nothing was decrypted. */
export type SignerLoad =
  | { readonly kind: "signer"; readonly signer: ChainWallet }
  | { readonly kind: "return"; readonly result: ToolResult };

export type GateOutcome =
  /** A `ToolResult` the handler must return as-is: a refusal, or the approval stop. */
  | { readonly kind: "return"; readonly result: ToolResult }
  | {
      readonly kind: "proceed";
      readonly intent: WalletTransactionIntent;
      /**
       * The selected wallet ADDRESS, proven to be the approved one. Resolved
       * WITHOUT decrypting anything, so every check between here and the
       * signature runs with no key material in the process.
       */
      readonly signerAddress: string;
      /**
       * DECRYPT THE KEY. Called as LATE as the design allows - after the claim,
       * after every remote preparation call, and immediately after the pre-sign
       * authority fence has passed. It re-proves the wallet is the approved one,
       * because the address check above happened at gate time.
       */
      readonly loadSigner: () => SignerLoad;
      /** The authority this dispatch was authorized under. See `./authority-fence.ts`. */
      readonly anchor: AuthorityAnchor;
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

  // ADDRESS ONLY, and deliberately: this proves the session's selection is the
  // approved wallet WITHOUT decrypting anything. The key is loaded later, by
  // `loadSigner`, once the authority fence has been re-asked immediately before
  // the signature - so a scope edit or a lock arriving in between finds no
  // materialized key to have to revoke.
  let signerAddress: string;
  try {
    signerAddress = resolveSelectedAddress(
      context.walletResolution,
      context.walletPolicy,
      intent.family,
    );
  } catch (err) {
    return { kind: "return", result: walletScopeErrorToResult(err) };
  }
  const addressCheck = revalidateSignerAddress(intent, signerAddress);
  if (!addressCheck.ok) return { kind: "return", result: refusalToResult(addressCheck.refusal) };

  // The ANCHOR: the authority as it stands now, captured before any key
  // material exists and compared at the claim, before signing, and before
  // submission.
  const anchor = await captureAuthorityAnchor({
    sessionId: intent.sessionId,
    family: intent.family,
    walletAddress: signerAddress,
    intentId: intent.intentId,
  });

  const loadSigner = (): SignerLoad => {
    let signer: ChainWallet;
    try {
      signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, intent.family);
    } catch (err) {
      return { kind: "return", result: walletScopeErrorToResult(err) };
    }
    const signerCheck = revalidateSigner(intent, signer);
    if (!signerCheck.ok) {
      return { kind: "return", result: refusalToResult(signerCheck.refusal) };
    }
    return { kind: "signer", signer };
  };

  return { kind: "proceed", intent, signerAddress, loadSigner, anchor, binding: binding.value };
}

// ── Step 9: T2 ─────────────────────────────────────────────────────────

/**
 * Claim, or the `ToolResult` explaining why nothing was claimed.
 *
 * FENCE POINT (a). The authority recheck runs as the first statement of the
 * claim transaction, so the fence and the claim commit or roll back together: a
 * lock or a scope edit that won before this transaction took the session
 * control lock leaves the intent `pending`, with nothing claimed and nothing
 * decrypted. A fence refusal is reported as ITSELF, never as a lost race, so
 * the caller can say which of the two happened.
 */
export async function claimOrRefuse(
  intent: WalletTransactionIntent,
  anchor: AuthorityAnchor,
): Promise<{ kind: "claimed"; claim: Extract<TransactionClaim, { ok: true }> } | { kind: "return"; result: ToolResult }> {
  const claim = await claimTransactionIntent(intent, intent.proposalDigest, (client) =>
    recheckAuthorityWith(client, anchor, "claim"));
  if (claim.ok) return { kind: "claimed", claim };
  if (claim.reason === "fence_refused") {
    return { kind: "return", result: refusalToResult(claim.refusal) };
  }
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
 * ALL THREE ROWS MOVE IN ONE TRANSACTION under the session control lock
 * (`./terminal-settlement.js`), so the partial states that had no repair owner -
 * a terminal activity row beside a stranded intent, a completed intent beside an
 * open execution row - cannot exist. THE EXECUTION ROW IS COMPLETED ON EVERY
 * ARM, ambiguity included (T3d): the tool attempt is over the moment this
 * returns, and the compaction money-state gate selects an
 * `execution_status = 'intent'` row on its own, so leaving it open would block
 * compaction forever even after a repair lane settled the rest.
 *
 * A SETTLEMENT FAILURE NEVER CHANGES THE ANSWER. The transaction is already
 * whatever the chain made of it; a conflicting durable winner or an unavailable
 * database is audit drift, logged structurally, and the caller still receives
 * the honest chain outcome. It is never converted into a claim that the
 * transaction failed.
 */
export async function settleExecution(
  intent: WalletTransactionIntent,
  activity: TransactionActivity,
  execution: TransactionExecution,
  echo: Record<string, unknown>,
): Promise<ToolResult> {
  const { intentId } = intent;
  await terminalize(intent, activity, execution);

  switch (execution.kind) {
    case "confirmed": {
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
 * Run the ONE terminalizing transaction and report a failure structurally.
 *
 * A conflict means a durable winner - operator action, or a recovery lane that
 * got there first under the same lock - already wrote an INCOMPATIBLE outcome,
 * so this attempt rolled back rather than stamp a second account of the same
 * transaction over part of it. Either way the chain fact is unchanged, so this
 * never alters the answer the caller receives; it changes only what an auditor
 * can see, and the scheduled recovery still owns any row left behind.
 */
async function terminalize(
  intent: WalletTransactionIntent,
  activity: TransactionActivity,
  execution: TransactionExecution,
): Promise<void> {
  try {
    await settleTerminalRows(
      {
        intentId: intent.intentId,
        sessionId: intent.sessionId,
        activityId: activity.activityId,
        executionId: activity.executionId,
        startedAtMs: activity.startedAtMs,
      },
      execution,
    );
  } catch (err) {
    if (err instanceof TerminalSettlementConflictError) {
      logger.warn("wallet.transaction.terminal_settlement_conflict", {
        intentId: intent.intentId,
        sessionId: intent.sessionId,
        row: err.row,
        detail: err.detail,
        outcome: execution.kind,
      });
      return;
    }
    logger.warn("wallet.transaction.terminal_settlement_failed", {
      intentId: intent.intentId,
      sessionId: intent.sessionId,
      outcome: execution.kind,
      ...summarizeWalletError(err),
    });
  }
}
