/**
 * The durable rows of a GENERIC SIGNED TRANSACTION, and the T2 claim
 * transaction that creates them (migration 087, lifecycle table T2-T3d).
 *
 * ## Three rows, one transaction, one lock
 *
 * T2 is ONE transaction under the session control lock, and it is the whole of
 * this module's reason to exist:
 *
 *   1. `claimIfPendingWith` - `pending -> consuming`, with the session, the
 *      expiry AND the approved proposal digest in the CAS predicate;
 *   2. `createExecutionIntent` - the `protocol_executions` row at `intent`;
 *   3. `createPendingActivityEvent` - the `agent_activity` row at `pending`,
 *      kind `transaction`;
 *   4. `stampActivityWith` - the intent's `activity_id`, so recovery can find
 *      the row from the intent and the intent from the row.
 *
 * Any failure ROLLS THE WHOLE THING BACK, which leaves the intent `pending`:
 * nothing was claimed, nothing was signed, and the operator can cancel or let
 * it expire. That is why `audit_failed` is NOT written here - it is the status
 * for a STAGING failure, which happens after this transaction has committed and
 * while the row is `consuming` (its CAS requires exactly that status).
 *
 * The transaction is DB-ONLY and COMMITS BEFORE anything is signed. Holding the
 * session control lock across a signing call would block the operator's Stop -
 * the exact inversion the lock exists to prevent.
 *
 * ## What the activity row states, and what it refuses to state
 *
 * It carries NO asset leg. A generic proposal is not a transfer Vex built: an
 * approve moves nothing, a contract call moves whatever the contract decides,
 * and an SPL instruction set may move several things at once. The transfer
 * writer's single-leg shape would put an amount on the row that nobody proved,
 * so the row states the DECODED EFFECT through its `event_role` and the chain
 * outcome through its status, and nothing else. Confirmation therefore never
 * writes an executed amount: there is no leg to fill.
 *
 * ## The two rows answer different questions
 *
 * `protocol_executions` records the TOOL ATTEMPT and is completed on EVERY
 * normal return, ambiguity included (T3d) - the compaction money-state gate
 * selects an `execution_status = 'intent'` row on its own, so leaving it open
 * would block compaction forever even after a repair lane settled the rest.
 * `agent_activity` records the CHAIN OUTCOME and is the only row allowed to
 * stay `pending` while a transaction's fate is unknown.
 */

import type { PoolClient } from "pg";

import {
  confirmActivityEvent,
  createPendingActivityEvent,
  failActivityEvent,
  markActivityBroadcast,
  markActivitySolanaBroadcast,
  markBroadcastAccepted,
  type AgentActivityEventRole,
  type AgentActivityFailureCode,
  type BridgeChainFamily,
} from "@vex-agent/db/repos/agent-activity.js";
import { completeExecutionIntentWith, createExecutionIntent } from "@vex-agent/db/repos/executions.js";
import * as intentsRepo from "@vex-agent/db/repos/wallet-transaction-intents.js";
import type { WalletTransactionIntent } from "@vex-agent/db/repos/wallet-transaction-intents.js";
import type { WalletTransactionRole } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import logger from "@utils/logger.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../../constants/solana-chain.js";

import { summarizeWalletError } from "../send-types.js";

/**
 * DURABLE tool identity for these rows, written into `agent_activity.tool_id`
 * and the matching `protocol_executions` row. One id for both families: the
 * family is already a column (`chain_family`) and splitting the id would fork
 * one product's history across two spellings for a fact the row already carries.
 */
const TOOL_ID = "wallet_transaction_confirm";
const NAMESPACE = "wallet";
/** `agent_activity.protocol` - a generic signed transaction belongs to no venue. */
const PROTOCOL = "wallet";

/**
 * The decoded effect, as the activity vocabulary spells it. Prefixed roles,
 * because that enum is global and a bare `approve` would read as `allowance` on
 * another arm.
 */
const ROLE_BY_EFFECT: Readonly<Record<WalletTransactionRole, AgentActivityEventRole>> = {
  approve: "tx_approve",
  contract_call: "tx_contract_call",
  native_transfer: "tx_native_transfer",
  spl_instruction_set: "tx_spl_instruction_set",
};

/** How the TOOL ATTEMPT ended. `confirmation_unknown` is a real member: see T3d. */
export type TransactionSettlement =
  | { readonly kind: "confirmed"; readonly txHash: string }
  | { readonly kind: "reverted"; readonly txHash: string }
  | { readonly kind: "confirmation_unknown"; readonly txHash: string }
  | { readonly kind: "failed_before_broadcast" };

export interface TransactionActivity {
  readonly executionId: number;
  readonly activityId: number;
  /** EVM staging. THROWS on a CAS miss - the caller must abort before submitting. */
  stageEvm(handles: {
    readonly txHash: string;
    readonly fromAddress: string;
    readonly nonce: number;
  }): Promise<void>;
  /** Solana staging with the blockhash evidence the 049 CHECK requires. THROWS on a CAS miss. */
  stageSolana(handles: {
    readonly signature: string;
    readonly fromAddress: string;
    readonly recentBlockhash: string;
    readonly lastValidBlockHeight: number;
  }): Promise<void>;
  /** Best-effort `broadcast_at` bookkeeping once the RPC accepted the submission. */
  noteAccepted(): Promise<void>;
  /**
   * CAS-finalize `confirmed` from a DEFINITIVE receipt. Best-effort.
   *
   * Takes NO amounts and accepts none: this kind has no asset leg, so there is
   * nothing a receipt could fill in that the row claims to hold.
   */
  confirm(): Promise<void>;
  /** CAS-finalize `definitively_failed`. Best-effort. NEVER called for an ambiguous outcome. */
  fail(input: {
    readonly failureCode: AgentActivityFailureCode;
    readonly failureReason: string;
  }): Promise<void>;
  /** Settle `protocol_executions` - called on EVERY normal return, T3d included. */
  completeExecution(settlement: TransactionSettlement): Promise<void>;
}

/** The claim either happened or it did not, and the two are different answers. */
export type TransactionClaim =
  | {
      readonly ok: true;
      readonly intent: WalletTransactionIntent;
      readonly activity: TransactionActivity;
    }
  | {
      readonly ok: false;
      /**
       * `race_lost` - the CAS predicate did not match: the row is no longer
       * `pending`, belongs to another session, has expired, or its proposal
       * digest is not the one being confirmed. Nothing moved.
       *
       * `write_failed` - the transaction threw and rolled back. The intent is
       * still `pending` for exactly that reason.
       */
      readonly reason: "race_lost" | "write_failed";
      readonly detail: string;
    };

function chainIdentityOf(intent: WalletTransactionIntent): {
  chainId: number;
  chainSlug: string;
  chainFamily: BridgeChainFamily;
} {
  if (intent.family === "solana") {
    return {
      // The repo-canonical synthetic id every Solana `agent_activity` row
      // carries; the 049 family binding is written against this value.
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      chainSlug: "solana",
      chainFamily: "solana",
    };
  }
  return {
    chainId: intent.chainId ?? 0,
    chainSlug: intent.chainAlias ?? String(intent.chainId ?? 0),
    chainFamily: "eip155",
  };
}

/**
 * The intent params echoed on the execution row. Structural identity only: the
 * intent id, what the proposal was decided to be, and the ceiling it was
 * authorized under. The calldata and the message bytes stay on the intent row,
 * which is where the approval card reads them from; repeating a hex blob into a
 * second table would put it in a place nothing needs it.
 */
function intentParamsOf(intent: WalletTransactionIntent): Record<string, unknown> {
  return {
    intentId: intent.intentId,
    family: intent.family,
    chain: intent.chainAlias,
    chainId: intent.chainId,
    walletAddress: intent.walletAddress,
    role: intent.decoded.role,
    effect: intent.preview.label,
    proposalDigest: intent.proposalDigest,
    proposalDigestVersion: intent.proposalDigestVersion,
    feeBounds: intent.feeBounds,
  };
}

/**
 * T2. Claim the intent AND create both durable rows in ONE transaction under
 * the session control lock.
 *
 * The digest is in the CAS predicate rather than compared afterwards: a compare
 * after a successful claim would have consumed a row whose proposal drifted,
 * leaving a `consuming` intent nobody may execute.
 */
export async function claimTransactionIntent(
  intent: WalletTransactionIntent,
  approvedProposalDigest: string,
): Promise<TransactionClaim> {
  const startedAtMs = Date.now();
  const chain = chainIdentityOf(intent);

  try {
    return await withSessionControlLock(intent.sessionId, async (client: PoolClient) => {
      const claimed = await intentsRepo.claimIfPendingWith(
        client,
        intent.intentId,
        intent.sessionId,
        approvedProposalDigest,
      );
      if (claimed === null) {
        return {
          ok: false as const,
          reason: "race_lost" as const,
          detail:
            "the intent was not pending, not owned by this session, already expired, or its "
            + "proposal digest is not the one that was approved",
        };
      }

      const executionId = await createExecutionIntent(
        TOOL_ID,
        NAMESPACE,
        claimed.sessionId,
        intentParamsOf(claimed),
        client,
      );
      if (executionId <= 0) {
        throw new Error("wallet_transaction: execution intent insert returned no id");
      }

      const event = await createPendingActivityEvent(
        {
          protocolExecutionId: executionId,
          eventIndex: 0,
          eventRole: ROLE_BY_EFFECT[claimed.decoded.role],
          kind: "transaction",
          protocol: PROTOCOL,
          chainId: chain.chainId,
          chainSlug: chain.chainSlug,
          chainFamily: chain.chainFamily,
          walletAddress: claimed.walletAddress,
          sessionId: claimed.sessionId,
          // NO LEGS, and no usd_* estimate. See the module header: this path
          // did not build the proposal and cannot prove what it moves.
        },
        client,
      );

      const stamped = await intentsRepo.stampActivityWith(
        client,
        claimed.intentId,
        claimed.sessionId,
        String(event.id),
      );
      if (stamped === null) {
        // Unreachable in a sound system - we just moved this row to `consuming`
        // inside this transaction and nothing else can see it yet - so it is a
        // hard abort rather than a warning. An unlinked claim is precisely the
        // state crash recovery cannot resolve.
        throw new Error("wallet_transaction: activity stamp missed inside the claim transaction");
      }

      return {
        ok: true as const,
        intent: stamped,
        activity: makeHandle(stamped.sessionId, executionId, event.id, startedAtMs),
      };
    });
  } catch (cause) {
    const sum = summarizeWalletError(cause);
    logger.warn("wallet.transaction.claim_transaction_failed", {
      intentId: intent.intentId,
      sessionId: intent.sessionId,
      ...sum,
    });
    return {
      ok: false,
      reason: "write_failed",
      detail: `${sum.errorKind}:${sum.errorHash}`,
    };
  }
}

function makeHandle(
  sessionId: string,
  executionId: number,
  activityId: number,
  startedAtMs: number,
): TransactionActivity {
  return {
    executionId,
    activityId,

    async stageEvm(handles) {
      const res = await markActivityBroadcast(activityId, {
        txHash: handles.txHash,
        fromAddress: handles.fromAddress,
        nonce: handles.nonce,
      });
      if (!res.applied) {
        throw new Error(
          `agent_activity: markActivityBroadcast CAS miss for event ${activityId} - refusing to broadcast untracked`,
        );
      }
    },

    async stageSolana(handles) {
      const res = await markActivitySolanaBroadcast(activityId, {
        txHash: handles.signature,
        fromAddress: handles.fromAddress,
        recentBlockhash: handles.recentBlockhash,
        lastValidBlockHeight: handles.lastValidBlockHeight,
      });
      if (!res.applied) {
        throw new Error(
          `agent_activity: markActivitySolanaBroadcast CAS miss for event ${activityId} - refusing to broadcast untracked`,
        );
      }
    },

    async noteAccepted() {
      try {
        const res = await markBroadcastAccepted(activityId);
        if (!res.applied) logger.warn("wallet.transaction.activity_accept_miss", { activityId });
      } catch (err) {
        logger.warn("wallet.transaction.activity_accept_failed", {
          activityId,
          ...summarizeWalletError(err),
        });
      }
    },

    async confirm() {
      try {
        // No executed amounts: this kind has no asset leg to fill, and
        // `confirmActivityEvent`'s strict both-legs guard covers only
        // swap/wrap/unwrap/token_launch.
        await confirmActivityEvent(activityId, {});
      } catch (err) {
        logger.warn("wallet.transaction.activity_confirm_failed", {
          activityId,
          ...summarizeWalletError(err),
        });
      }
    },

    async fail(input) {
      try {
        await failActivityEvent(activityId, input);
      } catch (err) {
        logger.warn("wallet.transaction.activity_fail_failed", {
          activityId,
          ...summarizeWalletError(err),
        });
      }
    },

    async completeExecution(settlement) {
      try {
        await withSessionControlLock(sessionId, (client) =>
          completeExecutionIntentWith(client, {
            executionId,
            // Structural only: no provider text, no calldata, no key material.
            result: {
              status: settlement.kind,
              ...("txHash" in settlement ? { txHash: settlement.txHash } : {}),
            },
            success: settlement.kind === "confirmed",
            tradeCapture: null,
            externalRefs: "txHash" in settlement ? { txHash: settlement.txHash } : {},
            durationMs: Date.now() - startedAtMs,
          }),
        );
      } catch (err) {
        logger.warn("wallet.transaction.execution_complete_failed", {
          executionId,
          activityId,
          ...summarizeWalletError(err),
        });
      }
    },
  };
}
