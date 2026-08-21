/**
 * The durable `agent_activity` writer for an agent wallet send (migration 084).
 *
 * WHY THIS EXISTS. Until 084 a transfer persisted only into `wallet_intents`,
 * which no feed reads, and both executors carried comments promising a capture
 * pipeline that never runs on the internal tool route. The transaction was real,
 * the funds moved, and the agent's own history showed nothing.
 *
 * WHAT IT OWNS, and what it deliberately does not. This module owns the DURABLE
 * state of a transfer: the `protocol_executions` intent row, the
 * `agent_activity` event row, their staging, their finalization, and the
 * execution completion. The executors keep owning the CHAIN mechanics - which
 * client, which calldata, which signature. Splitting them this way is what lets
 * the ordering below be stated once instead of twice.
 *
 * THE ORDERING IS THE POINT. Every step exists to close a specific window:
 *
 *   1. Resolve ONE exact plan - numeric chain id, token identity, and the ATOMIC
 *      amount as a `bigint` derived once by exact decimal arithmetic. The SAME
 *      bigint feeds the transaction and the row, so the two can never disagree.
 *   2. A plan that cannot be resolved gets ONE hashless terminal row
 *      (`recordWalletTransferPlanFailure`). That is the only arm using the
 *      pre-broadcast-failure API, because it is the only arm where no intent
 *      exists yet.
 *   3. `openWalletTransferActivity` creates the pending row BEFORE anything is
 *      signed.
 *   4. The executor signs LOCALLY and calls `stageEvm` / `stageSolana` with the
 *      hash (or signature plus blockhash evidence) BEFORE submitting. A CAS miss
 *      THROWS, which aborts the send: refusing to broadcast an untracked
 *      transfer is the whole reason the writer is shaped this way.
 *   5. Only then are the signed bytes submitted, once.
 *   6. `confirm` / `fail` finalize from DEFINITIVE chain evidence only. An
 *      ambiguous outcome calls NEITHER - the row stays `pending` for the repair
 *      sweep, and nothing is ever re-sent. Ambiguity never terminalizes
 *      (rules/90; plan section 11.1 / FIX-SPINE C1).
 *   7. `completeExecution` settles the `protocol_executions` row on EVERY path
 *      by which the tool returns, ambiguity included.
 *
 * THE TWO ROWS ANSWER DIFFERENT QUESTIONS, and conflating them strands money
 * state. `protocol_executions` records the TOOL
 * ATTEMPT: opened when the attempt starts, finished when the tool returns,
 * whatever it returns. `agent_activity` records the CHAIN OUTCOME, and only it
 * is allowed to stay `pending` while a transaction's fate is unknown.
 *
 * The compaction safe-moment gate reads BOTH independently
 * (`db/repos/approval-intents/money-state.ts`), and it selects an
 * `execution_status = 'intent'` row on its OWN - so an execution left at
 * `intent` for an ambiguous send would block compaction forever, even after the
 * repair sweep resolved the activity row. Completing the attempt with
 * `success: false` and a structural `confirmation_unknown` status does NOT claim
 * the chain state is settled: the still-`pending` activity row is what keeps the
 * gate honest about that, and it is the row the sweep owns.
 *
 * The internal wallet route never enters `protocols/runtime/capture.ts`, so
 * unlike a protocol handler NOTHING ELSE will complete these rows. That includes
 * the hashless plan-failure arm, which completes its own execution too.
 *
 * ONE ROW PER SEND, EVER. A failure after step 3 finalizes the EXISTING event
 * through `fail`; it never creates a second execution.
 *
 * Bookkeeping is best-effort by design: the transaction is the truth, and a
 * write failure here is logged structurally and never converted into a claim
 * that the transfer failed. The one exception is staging, which is a hard gate.
 */

import { formatUnits } from "viem";

import type { WalletIntent } from "@vex-agent/db/repos/wallet-intents.js";
import {
  createAgentActivityIntent,
  createAgentActivityPreBroadcastFailure,
  markActivityBroadcast,
  markActivitySolanaBroadcast,
  markBroadcastAccepted,
  confirmActivityEvent,
  failActivityEvent,
  noteSettledBlockTime,
  type AgentActivityFailureCode,
  type BridgeChainFamily,
} from "@vex-agent/db/repos/agent-activity.js";
import { completeExecutionIntentWith } from "@vex-agent/db/repos/executions.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import logger from "@utils/logger.js";

import { summarizeWalletError } from "../send-types.js";

/**
 * The tool whose durable execution a transfer belongs to.
 *
 * DELIBERATELY still the pre-rename spelling. The model-visible tool is now
 * `WalletSendConfirm`, but this string is written into `agent_activity.tool_id`
 * and the matching `executions` row, where it is DURABLE and is read back
 * alongside rows already on disk. Flipping it here would split one product's
 * history across two spellings with no migration, which is a durable-format
 * change needing its own decision and a backfill - not a side effect of a
 * model-visible rename. See `tool-surface-spec/identity-and-migration.md` §4.
 */
const TOOL_ID = "wallet_send_confirm";
const NAMESPACE = "wallet";
/** `agent_activity.protocol` - a send belongs to no venue. */
const PROTOCOL = "wallet";

/**
 * ONE resolved, exact, unsigned transfer. Everything the durable row needs, and
 * everything the transaction needs, resolved together so they cannot diverge.
 *
 * `amountRaw` is the atomic amount as a `bigint`, derived ONCE from the intent's
 * decimal text by exact string arithmetic (`viem`'s `parseUnits`). It is the
 * value that is signed AND the value that is recorded. Never a float: a token
 * amount through `Number` silently loses precision above 2^53 atomic units and
 * rounds below it, which on this path is a wrong amount of real money.
 */
export interface WalletTransferPlan {
  readonly chainId: number;
  readonly chainSlug: string;
  readonly chainFamily: BridgeChainFamily;
  /**
   * The token's IDENTITY. For an EVM native leg, the chain-agnostic native
   * sentinel; for SOL, the wrapped-SOL mint that every other Solana row in this
   * database uses for native value; for an ERC-20 / SPL token, its contract or
   * mint address; for an NFT, the CONTRACT address - never a synthesized
   * `nft:contract:id` pseudo-address, which is not an address and would poison
   * every join and every per-token view that reads this column.
   */
  readonly tokenAddress: string;
  /** The label. An NFT carries its token id here, which is where a non-fungible identity belongs. */
  readonly tokenSymbol: string;
  /** An NFT is indivisible: `0`, so `amountRaw` of `1n` reads as one item. */
  readonly tokenDecimals: number;
  readonly amountRaw: bigint;
  /** `formatUnits(amountRaw, tokenDecimals)` - derived from the raw amount, never re-parsed from user text. */
  readonly amountHuman: string;
}

/**
 * How the TOOL ATTEMPT ended, for the `protocol_executions` record.
 *
 * `confirmation_unknown` is a real member, not an omission: the attempt is over
 * the moment the tool returns, even though the CHAIN outcome is not. The
 * `agent_activity` row carries that unresolved chain state; this union carries
 * only "what did the tool end up telling the caller".
 */
export type WalletTransferSettlement =
  | { readonly kind: "confirmed"; readonly txHash: string; readonly blockTimeIso?: string }
  | { readonly kind: "reverted"; readonly txHash: string }
  | { readonly kind: "confirmation_unknown"; readonly txHash: string }
  | { readonly kind: "failed_before_broadcast" };

export interface WalletTransferActivity {
  readonly executionId: number;
  readonly rowId: number;
  /** EVM staging. THROWS on a CAS miss - the caller must abort before submitting. */
  stageEvm(handles: { txHash: string; fromAddress: string; nonce: number }): Promise<void>;
  /** Solana staging, carrying the blockhash evidence the 049 CHECK requires. THROWS on a CAS miss. */
  stageSolana(handles: {
    signature: string;
    fromAddress: string;
    recentBlockhash: string;
    lastValidBlockHeight: number;
  }): Promise<void>;
  /** Best-effort `broadcast_at` bookkeeping once the RPC accepted the submission. */
  noteAccepted(): Promise<void>;
  /**
   * CAS-finalize `confirmed` from a DEFINITIVE receipt. Best-effort.
   *
   * `provenAmountRaw` is the amount the receipt PROVED moved, or `null` when it
   * proved none. `null` confirms the row WITHOUT an executed amount rather than
   * recording the request as settled truth - see the doc on the implementation.
   */
  confirm(settlement: {
    readonly txHash: string;
    readonly blockTimeIso?: string;
    readonly provenAmountRaw: bigint | null;
  }): Promise<void>;
  /** CAS-finalize `definitively_failed`. Best-effort. NEVER called for an ambiguous outcome. */
  fail(input: { failureCode: AgentActivityFailureCode; failureReason: string }): Promise<void>;
  /**
   * Settle the `protocol_executions` row: the TOOL ATTEMPT completes on every
   * outcome the tool can name, `confirmation_unknown` included. Only the
   * `agent_activity` row may stay pending; the chain outcome is its concern.
   */
  completeExecution(settlement: WalletTransferSettlement): Promise<void>;
}

function intentParamsOf(intent: WalletIntent): Record<string, unknown> {
  return {
    intentId: intent.intentId,
    network: intent.network,
    chain: intent.chainAlias,
    to: intent.toAddress,
    amount: intent.amount,
    token: intent.token,
  };
}

/**
 * Create the pending `agent_activity` row and its `protocol_executions` intent,
 * atomically and under the session control lock, BEFORE anything is signed.
 *
 * Throws if the durable write fails. That is deliberate and it is the safe
 * direction: with no row, the caller must not sign.
 */
export async function openWalletTransferActivity(
  intent: WalletIntent,
  plan: WalletTransferPlan,
): Promise<WalletTransferActivity> {
  const started = Date.now();
  const created = await createAgentActivityIntent({
    toolId: TOOL_ID,
    namespace: NAMESPACE,
    intentParams: intentParamsOf(intent),
    events: [
      {
        eventIndex: 0,
        eventRole: "wallet_transfer",
        kind: "transfer",
        protocol: PROTOCOL,
        chainId: plan.chainId,
        chainSlug: plan.chainSlug,
        chainFamily: plan.chainFamily,
        walletAddress: intent.walletAddress,
        sessionId: intent.sessionId,
        // INPUT LEG ONLY. The asset left the wallet; nothing comes back, so an
        // output leg would invent a counterparty. The DESTINATION is
        // deliberately absent from the row (rules/90 privacy stance) - it lives
        // on the local `wallet_intents` row and in this execution's params.
        tokenIn: {
          tokenAddress: plan.tokenAddress,
          tokenSymbol: plan.tokenSymbol,
          tokenDecimals: plan.tokenDecimals,
          amountHuman: plan.amountHuman,
          amountRaw: plan.amountRaw.toString(),
        },
        // usd_* stay NULL. A send has no venue quote and no price this path
        // fetched; a number invented here would be a valuation nobody made.
      },
    ],
  });
  // Exactly one event was requested above, so exactly one comes back. Checked
  // rather than asserted: without a row id there is nothing to stage against,
  // and the caller must not sign.
  const event = created.events[0];
  if (event === undefined) {
    throw new Error("agent_activity: transfer intent returned no event row");
  }
  return makeHandle(intent.sessionId, created.executionId, event.id, plan, started);
}

function makeHandle(
  sessionId: string,
  executionId: number,
  rowId: number,
  plan: WalletTransferPlan,
  startedAtMs: number,
): WalletTransferActivity {
  return {
    executionId,
    rowId,

    async stageEvm(handles) {
      const res = await markActivityBroadcast(rowId, handles);
      if (!res.applied) {
        // Refusing to broadcast an untracked transfer. Nothing has been sent.
        throw new Error(
          `agent_activity: markActivityBroadcast CAS miss for event ${rowId} - refusing to broadcast untracked`,
        );
      }
    },

    async stageSolana(handles) {
      const res = await markActivitySolanaBroadcast(rowId, {
        txHash: handles.signature,
        fromAddress: handles.fromAddress,
        recentBlockhash: handles.recentBlockhash,
        lastValidBlockHeight: handles.lastValidBlockHeight,
      });
      if (!res.applied) {
        throw new Error(
          `agent_activity: markActivitySolanaBroadcast CAS miss for event ${rowId} - refusing to broadcast untracked`,
        );
      }
    },

    async noteAccepted() {
      try {
        const res = await markBroadcastAccepted(rowId);
        if (!res.applied) logger.warn("wallet.send.activity_accept_miss", { rowId });
      } catch (err) {
        logger.warn("wallet.send.activity_accept_failed", { rowId, ...summarizeWalletError(err) });
      }
    },

    async confirm(settlement) {
      try {
        // THE EXECUTED AMOUNT IS WRITTEN ONLY WHEN IT WAS PROVEN. The caller
        // supplies the proof: for a native send
        // the protocol itself moves `tx.value`, so a successful receipt proves
        // it; for an ERC-20 or an NFT the caller must have matched the receipt's
        // own `Transfer` log, because `transfer` returns `bool` and a
        // nonconforming token can answer `false`, or move less, without
        // reverting.
        //
        // `null` means the transaction confirmed but WHAT IT MOVED is unproven.
        // The row is then confirmed with NO executed amount at all
        // (`confirmActivityEvent` accepts this for `wallet_transfer`: its strict
        // both-legs guard covers only `swap`/`wrap`/`unwrap`/`token_launch`, and
        // migration 061 dropped the corresponding DB CHECKs precisely so that
        // `confirmed` + NULL `executed_*` is a legitimate, repairable state).
        // Writing the REQUEST there instead would make an unverified number
        // indistinguishable from a verified one.
        const proven = settlement.provenAmountRaw;
        await confirmActivityEvent(
          rowId,
          proven === null
            ? {}
            : {
                executedAmountInRaw: proven.toString(),
                executedAmountInHuman: formatUnits(proven, plan.tokenDecimals),
              },
        );
        if (proven === null) {
          logger.info("wallet.send.confirmed_amount_unproven", {
            rowId, txHash: settlement.txHash, chainFamily: plan.chainFamily,
          });
        }
      } catch (err) {
        logger.warn("wallet.send.activity_confirm_failed", {
          rowId, txHash: settlement.txHash, ...summarizeWalletError(err),
        });
        return;
      }
      if (settlement.blockTimeIso !== undefined) {
        try {
          await noteSettledBlockTime(rowId, settlement.blockTimeIso);
        } catch (err) {
          // Precision of a later report, never a money fact. See that module's doc.
          logger.warn("wallet.send.activity_block_time_failed", { rowId, ...summarizeWalletError(err) });
        }
      }
    },

    async fail(input) {
      try {
        await failActivityEvent(rowId, input);
      } catch (err) {
        logger.warn("wallet.send.activity_fail_failed", { rowId, ...summarizeWalletError(err) });
      }
    },

    async completeExecution(settlement) {
      try {
        await withSessionControlLock(sessionId, (client) =>
          completeExecutionIntentWith(client, {
            executionId,
            // Structural only. No raw provider text, no key material, no amounts
            // the row does not already carry under its own columns.
            result: { status: settlement.kind, ...("txHash" in settlement ? { txHash: settlement.txHash } : {}) },
            success: settlement.kind === "confirmed",
            tradeCapture: null,
            externalRefs: "txHash" in settlement ? { txHash: settlement.txHash } : {},
            durationMs: Date.now() - startedAtMs,
          }),
        );
      } catch (err) {
        logger.warn("wallet.send.execution_complete_failed", {
          executionId, rowId, ...summarizeWalletError(err),
        });
      }
    },
  };
}

/**
 * A plan-resolution failure: ONE hashless, already-terminal row. This is the
 * ONLY caller of the pre-broadcast-failure API on this path, because it is the
 * only point at which no intent exists yet. After
 * `openWalletTransferActivity` has run, a failure finalizes the EXISTING event
 * through `fail` instead - a second execution row for one send would double-count
 * the money state the compaction gate reads.
 *
 * IT COMPLETES ITS OWN EXECUTION ROW.
 * `createAgentActivityPreBroadcastFailure` opens a `protocol_executions` intent
 * alongside the activity row, and discarding that id left the execution at
 * `execution_status = 'intent'` forever - the compaction safe-moment gate
 * selects such a row independently of `agent_activity`, so a transfer that never
 * even resolved a plan would have blocked compaction permanently. The activity
 * row here is already `definitively_failed`, so completing the attempt states
 * nothing the row does not.
 *
 * Best-effort: a transfer that never reached the chain must not be reported to
 * the operator as something else because its audit row could not be written.
 */
export async function recordWalletTransferPlanFailure(
  intent: WalletIntent,
  failure: { failureCode: AgentActivityFailureCode; failureReason: string; chainId: number; chainFamily: BridgeChainFamily },
): Promise<void> {
  const started = Date.now();
  let executionId: number | null = null;
  try {
    const created = await createAgentActivityPreBroadcastFailure({
      toolId: TOOL_ID,
      namespace: NAMESPACE,
      intentParams: intentParamsOf(intent),
      event: {
        eventIndex: 0,
        eventRole: "wallet_transfer",
        kind: "transfer",
        protocol: PROTOCOL,
        chainId: failure.chainId,
        chainFamily: failure.chainFamily,
        walletAddress: intent.walletAddress,
        sessionId: intent.sessionId,
        // No leg: the plan is exactly what could not be resolved, so any token
        // identity or amount stated here would be a guess about the thing that
        // failed to resolve.
        failureCode: failure.failureCode,
        failureReason: failure.failureReason,
      },
    });
    executionId = created.executionId;
  } catch (err) {
    logger.warn("wallet.send.activity_prebroadcast_write_failed", {
      intentId: intent.intentId, ...summarizeWalletError(err),
    });
  }

  if (executionId === null) return;
  try {
    await withSessionControlLock(intent.sessionId, (client) =>
      completeExecutionIntentWith(client, {
        executionId,
        result: { status: "failed_before_broadcast", failureCode: failure.failureCode },
        success: false,
        tradeCapture: null,
        externalRefs: {},
        durationMs: Date.now() - started,
      }),
    );
  } catch (err) {
    logger.warn("wallet.send.prebroadcast_execution_complete_failed", {
      intentId: intent.intentId, executionId, ...summarizeWalletError(err),
    });
  }
}
