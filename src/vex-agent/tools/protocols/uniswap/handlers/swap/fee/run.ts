/**
 * Running the Vex fee leg - AFTER the swap confirmed, and never before.
 *
 * THE INVARIANT (copied from `src/tools/bridge-fee/index.ts`, which says it
 * about bridges and means it identically here):
 *
 *   "a bridge that fails at any point NEVER charges a fee for a bridge that did
 *    not happen. The worst case is that Vex misses revenue - never that the user
 *    pays for nothing. Do not reorder to fee-first."
 *
 * Concretely, and every one of these is pinned by a test:
 *
 *   - A REVERTED, REFUSED or AMBIGUOUS swap means this function is never called
 *     at all: the fee is not signed, and the caller finalizes the fee row as
 *     never-attempted through `abortPlannedEvents`.
 *   - A FAILED fee leaves the swap UNAFFECTED. Nothing here throws, nothing here
 *     aborts or fails the parent row, and no caller may mark a confirmed swap
 *     failed because its fee did not land. That is missed Vex revenue and
 *     nothing more.
 *   - POST-CONFIRMATION BOOKKEEPING IS BEST-EFFORT. Once the network has spoken,
 *     a repository failure may never rewrite what it said: a known outcome and a
 *     known hash survive a failed audit write, and the failure is logged rather
 *     than allowed to downgrade the report.
 *   - An AMBIGUOUS fee is NEVER retried. It is left pending with its staged hash
 *     for the receipt sweep, because a blind retry of an unconfirmed transfer
 *     could charge the user TWICE.
 *
 * This is the same contract the sibling launchpad fee runners implement
 * Express. The two are deliberately separate today because that module is
 * native-ETH-only (wei formatting, one chain) while this one moves an ERC-20 or
 * native input on any Uniswap deployment; extracting the shared core is a named
 * follow-up, not a silent divergence.
 *
 * The native-value gate runs here rather than at plan time: the fingerprint
 * binds the exact (chain, to, calldata, value) that reaches the signer, so it is
 * only meaningful immediately before signing.
 */

import { formatUnits, type Account, type Chain, type Transport, type WalletClient } from "viem";

import {
  signStageBroadcast,
  type DeferredEvmSigner,
  type StagedBroadcastOutcome,
} from "@tools/evm-chains/staged-broadcast.js";
import type { ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import {
  classifyNativeValue,
  checkNativeValueAuthorizedForCall,
} from "@tools/evm-chains/native-value-authorization/index.js";
import {
  markActivityBroadcast,
  reserveActivityEvmNonce,
  markBroadcastAccepted,
  confirmActivityEvent,
  failActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";

import { VexError, ErrorCodes } from "../../../../../../../errors.js";
import type { UniswapFeeLegPlan } from "./plan.js";

/**
 * How the fee attempt ended. Richer than a boolean deliberately: `not_charged`
 * (there was no fee to take) and `not_attempted` (there was, and it never
 * reached the network) are different truths, and the audit surface must be able
 * to tell them apart.
 */
export interface UniswapFeeCollection {
  readonly collection:
    | "confirmed"
    | "confirmed_unrecorded"
    | "reverted"
    | "unconfirmed"
    | "not_attempted"
    | "not_charged";
  /** Plain-language, agent-facing. Always states that the swap itself is unaffected. */
  readonly collectionNote: string;
  readonly txHash: string | null;
}

export interface RunUniswapFeeLegInput {
  readonly plan: UniswapFeeLegPlan;
  /** The pre-created `agent_activity` row for the fee leg. */
  readonly feeRowId: number;
  readonly chainId: number;
  readonly tokenDecimals: number;
  readonly publicClient: Parameters<typeof signStageBroadcast>[0];
  /**
   * The account-bound client this leg signs with. Taken as the EAGER shape the
   * caller already holds and wrapped into the deferred arm below - see
   * {@link runUniswapFeeLeg} for why the arm matters here.
   */
  readonly walletClient: WalletClient<Transport, Chain, Account>;
  /** Anchor on the block the swap confirmed in. */
  readonly priorLeg?: ConfirmedPriorLeg | undefined;
  /**
   * THE AUTHORITATIVE DEBIT READ for this leg, run inside its own pre-sign
   * window (contract C2.6). The fee leg was counted in the plan before anything
   * was signed; this is the second half of that promise - the wallet is re-read
   * once the swap has actually taken its money.
   *
   * A throw from it is caught by this function like every other refusal:
   * `not_attempted`, no fee, and the CONFIRMED swap untouched.
   */
  readonly debitGate?: UniswapFeeLegDebitGate | undefined;
}

/**
 * The pre-sign gate this leg is handed, over the request that is about to be
 * serialized.
 *
 * It carries the FEE PRICES as well as the gas, because gas units times an
 * unknown price is not money: the gate both prices this leg's real cost and
 * refuses a price above the ceiling the execution's debit total was computed
 * under. No separate `StagedFeeBounds` is passed for this leg - a units ceiling
 * frozen before the swap ran would refuse a transfer for a warm-storage
 * difference rather than for a money fact.
 */
export type UniswapFeeLegDebitGate = (request: {
  readonly gas: bigint;
  readonly nonce: number;
  readonly gasPrice?: bigint | undefined;
  readonly maxFeePerGas?: bigint | undefined;
  readonly maxPriorityFeePerGas?: bigint | undefined;
}) => Promise<void>;

/**
 * Never throws. Every path returns a report.
 *
 * THE DEFERRED ARM, and why this leg may not use the eager one. The eager arm
 * signs through viem's `signTransaction` WALLET ACTION, which awaits an
 * `eth_chainId` of its own before it reaches the local account's signer
 * (measured in viem 2.54.3; `staged-broadcast.ts` documents the same fact for
 * every venue that reaches the shared primitive). That single round trip sits
 * BETWEEN the authoritative debit hook and the bytes it authorized, which is the
 * window contract C2.6 exists to close - and this leg carries a money gate
 * (`debitGate`), so it is exactly the leg that must not have one. The other
 * Uniswap legs already sign offline through `signUniswapTransaction`; this makes
 * the fee leg the same.
 *
 * The wrapper's own `onBeforeSign` is deliberately a no-op: the caller's gate
 * belongs in `hooks.onBeforeSign`, which is the LAST call before the signature
 * on both arms, whereas the signer's runs one step earlier (before the key is
 * resolved). Putting it in the later slot is what keeps "nothing between the
 * gate and the signature" literally true.
 */
export async function runUniswapFeeLeg(input: RunUniswapFeeLegInput): Promise<UniswapFeeCollection> {
  const { plan, feeRowId } = input;
  try {
    assertFeeValueAuthorized(input.chainId, plan);

    const walletClient = input.walletClient;
    const deferredSigner: DeferredEvmSigner = {
      kind: "deferred",
      address: walletClient.account.address,
      chain: walletClient.chain,
      onBeforeSign: async () => {},
      createSigner: async () => walletClient,
    };

    const outcome: StagedBroadcastOutcome = await signStageBroadcast(
      input.publicClient,
      deferredSigner,
      plan.txParams,
      {
        ...(input.debitGate === undefined
          ? {}
          : {
              onBeforeSign: async (request) => {
                await input.debitGate?.(request);
              },
            }),
        onNonceReserved: (request) => reserveActivityEvmNonce(feeRowId, request),
        onHashStaged: async (handles) => {
          const res = await markActivityBroadcast(feeRowId, handles);
          if (!res.applied) {
            throw new Error(`agent_activity: markActivityBroadcast CAS miss for fee event ${feeRowId} - refusing to broadcast untracked`);
          }
        },
        onAccepted: async () => {
          const res = await markBroadcastAccepted(feeRowId);
          if (!res.applied) logger.warn("uniswap.fee.broadcast_accept_miss", { id: feeRowId });
        },
      },
      input.priorLeg,
    );

    if (outcome.kind === "reverted") {
      // BEST-EFFORT, deliberately: the revert is a RECEIPT FACT with a known
      // hash. Letting a repository failure fall through to the catch below
      // would downgrade a proven on-chain revert to "not attempted" and erase
      // the hash - bookkeeping rewriting chain truth. Log it, keep the truth.
      await recordFeeRevert(feeRowId, outcome.txHash);
      return {
        collection: "reverted",
        collectionNote: "The Vex fee transfer reverted, so no fee was collected - your swap is unaffected.",
        txHash: outcome.txHash,
      };
    }

    if (outcome.kind === "ambiguous") {
      // Left PENDING with its staged hash for the receipt sweep. NEVER retried
      // here: a blind retry of an unconfirmed transfer could charge twice.
      logger.info("uniswap.fee.ambiguous", { id: feeRowId, stage: outcome.stage });
      // Migration 067: the fee row has its OWN pending reason. It is not the
      // swap's - a fee that did not confirm says nothing about whether the swap
      // did - and before this the row was pending with nothing stated at all.
      await noteHandlerPendingReason("uniswap.fee", feeRowId, "fee_broadcast_ambiguous");
      return {
        collection: "unconfirmed",
        collectionNote: "The Vex fee transfer was broadcast but not confirmed this turn; it is tracked automatically and is never re-sent. Your swap is unaffected.",
        txHash: outcome.txHash,
      };
    }

    return {
      collection: await confirmFeeRow(feeRowId, outcome.txHash, plan.feeRaw, input.tokenDecimals),
      collectionNote: "The Vex fee was transferred to the treasury.",
      txHash: outcome.txHash,
    };
  } catch (err) {
    // Includes a native-value refusal, a gas-estimate refusal, and a staging CAS
    // miss. None of them may touch the parent row.
    logger.warn("uniswap.fee.leg_failed", { id: feeRowId, error: err instanceof Error ? err.name : "unknown" });
    return {
      collection: "not_attempted",
      collectionNote: "The Vex fee transfer was refused before signing, so no fee was collected - your swap is unaffected.",
      txHash: null,
    };
  }
}

/**
 * Record a receipt-proven fee revert. Never throws: the outcome and its hash are
 * already established by the receipt, and no repository failure may unsay them.
 */
async function recordFeeRevert(feeRowId: number, txHash: string): Promise<void> {
  try {
    await failActivityEvent(feeRowId, {
      failureCode: "mined_revert",
      failureReason: `Vex fee transfer ${txHash} reverted on-chain; the swap itself was unaffected.`,
    });
  } catch (err) {
    logger.warn("uniswap.fee.revert_record_failed", {
      id: feeRowId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

/**
 * A NATIVE fee transfer's ENTIRE value is the Vex platform fee - Vex built it
 * from its own arithmetic on the user's own input amount, and there is no other
 * party's number in it. Without this classification
 * `checkNativeValueAuthorizedForCall` refuses the transfer as unattributed
 * native value. An ERC-20 fee leg carries `value: 0n` and passes trivially.
 */
function assertFeeValueAuthorized(chainId: number, plan: UniswapFeeLegPlan): void {
  const call = { chainId, to: plan.txParams.to, data: plan.txParams.data, valueWei: plan.txParams.value };
  const authorization = classifyNativeValue({
    call,
    vexPlatformFee: {
      amountWei: plan.txParams.value,
      recipient: plan.txParams.to,
      refund: "spent_not_recoverable",
      evidence: {
        source: "vex_constructed",
        detail: "the whole value is the Vex integrator fee of a Vex-built native transfer leg",
      },
    },
  });
  const verdict = checkNativeValueAuthorizedForCall(authorization, call);
  if (!verdict.ok) {
    throw new VexError(
      ErrorCodes.NATIVE_VALUE_UNAUTHORIZED,
      "Refused before signing: the Vex fee transfer's value could not be fully attributed to the fee.",
    );
  }
}

/**
 * A non-applied CAS confirm (the reconciler already finalized this row) must not
 * read as a clean confirm - mirrors the swap path's own confirm.
 */
async function confirmFeeRow(
  feeRowId: number,
  txHash: string,
  feeRaw: bigint,
  tokenDecimals: number,
): Promise<"confirmed" | "confirmed_unrecorded"> {
  try {
    const result = await confirmActivityEvent(feeRowId, {
      executedAmountInRaw: feeRaw.toString(),
      executedAmountInHuman: formatUnits(feeRaw, tokenDecimals),
    });
    if (result.applied) return "confirmed";
    if (result.row.status === "confirmed" && result.row.txHash === txHash) return "confirmed";
    logger.warn("uniswap.fee.confirm_cas_miss", { id: feeRowId, rowStatus: result.row.status });
    return "confirmed_unrecorded";
  } catch (err) {
    logger.warn("uniswap.fee.confirm_failed", { id: feeRowId, error: err instanceof Error ? err.name : "unknown" });
    return "confirmed_unrecorded";
  }
}

/** The fee row exists but the swap never reached the point where it is taken. */
export function uniswapFeeNotAttempted(reason: string): UniswapFeeCollection {
  return {
    collection: "not_attempted",
    collectionNote: `No Vex fee was taken: ${reason}.`,
    txHash: null,
  };
}

/** There was no fee to take at all - dust, or a token Vex declines to skim. */
export function uniswapFeeNotCharged(reason: string): UniswapFeeCollection {
  return {
    collection: "not_charged",
    collectionNote: `No Vex fee applies to this swap: ${reason}.`,
    txHash: null,
  };
}
