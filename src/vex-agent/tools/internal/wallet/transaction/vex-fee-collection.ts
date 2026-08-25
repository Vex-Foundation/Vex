/**
 * EXECUTING the Vex fee leg of a generic EVM transaction - the ONE owner of
 * that execution, and the only place it happens.
 *
 * It performs NO PLANNING. The frozen plan (`./vex-fee.ts`) was computed once,
 * before the claim, and its `event` was written as the fee row inside that same
 * claim transaction. This module takes that exact object and that exact row id
 * and signs what they describe. A second planning step here would be a second
 * computation of the same money, and the row that was recorded could then
 * disagree with the transfer that was signed.
 *
 * ## The ordering guarantee
 *
 * It is called on the CONFIRMED arm and nowhere else. A reverted, ambiguous,
 * refused or audit-failed transaction never reaches it, and on all of those arms
 * the caller finalizes the pre-created fee row as never-attempted instead. A
 * transaction that did not happen is never charged.
 *
 * ## Both fences, because the fee leg is a second signature
 *
 * The action's own signature was fenced at the claim, before signing and before
 * submission. The fee leg is a SEPARATE transaction signed afterwards, so it
 * carries its own authority checks rather than inheriting the action's:
 *
 *   PRE-SIGN     `onBeforeSign` re-asks `recheckAuthority(anchor, "pre_sign")`.
 *                A refusal means nothing was decrypted, signed or staged.
 *   PRE-SUBMIT   the runner's `afterStageBeforeSubmit` re-asks
 *                `recheckAuthority(anchor, "pre_submit")` after the staging
 *                write and before `sendRawTransaction`. A refusal terminalizes
 *                the staged row as signed-but-not-submitted and sends nothing.
 *
 * ## Nothing here can change the transaction's outcome
 *
 * The runner never throws and this module never rethrows. Every arm returns a
 * report. A fee that was refused, reverted, or left unconfirmed is missed Vex
 * revenue and nothing more; the user's transaction is already confirmed and
 * stays that way.
 */

import type { DeferredEvmSigner } from "@tools/evm-chains/staged-broadcast.js";
import type { ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import type { EvmWallet } from "@tools/wallet/multi-auth.js";
import { abortPlannedEvents } from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

import { summarizeWalletError } from "../send-types.js";

import { recheckAuthority, type AuthorityAnchor } from "./authority-fence.js";
import type { SignerLoad } from "./confirm-shared.js";
import { runNativeFeeLeg } from "../../../protocols/shared/native-fee-leg/run.js";
import {
  walletTxVexFeeSkipSentence,
  type ChargedWalletTransactionVexFeePlan,
  type WalletTransactionVexFeePlan,
} from "./vex-fee.js";

/**
 * What the confirm result says about the fee. A TRUE discriminated union on
 * `collection`, so a reverted or unconfirmed fee never exposes one ambiguous
 * "amount" field a reader could take for money that changed hands.
 *
 * `plannedFeeWei` is what the transfer was built to send. `collectedFeeWei`
 * appears ONLY where the chain proved it was sent.
 */
export type WalletTransactionVexFeeReport =
  | {
      readonly collection: "not_charged";
      readonly collectionNote: string;
      readonly reason: string;
      /** The candidate fee the rate produced, and the cost that made it not worth taking. */
      readonly candidateFeeWei: string;
      readonly maxNetworkFeeWei: string;
    }
  | {
      readonly collection: "confirmed" | "confirmed_unrecorded";
      readonly collectionNote: string;
      readonly txHash: string;
      readonly plannedFeeWei: string;
      readonly collectedFeeWei: string;
      readonly receiver: string;
    }
  | {
      readonly collection: "reverted" | "unconfirmed";
      readonly collectionNote: string;
      readonly txHash: string;
      readonly plannedFeeWei: string;
      readonly receiver: string;
    }
  | {
      readonly collection: "not_attempted";
      readonly collectionNote: string;
      readonly plannedFeeWei: string;
      readonly receiver: string;
    };

/**
 * The execution request. The charged plan and its NON-NULL row id are ONE type
 * on purpose: a charged plan with no row, or a row with no plan, is a state this
 * module must never be handed, and making it a compile error is cheaper than
 * checking for it at signing time.
 */
export interface CollectWalletTransactionVexFeeInput {
  readonly plan: ChargedWalletTransactionVexFeePlan;
  readonly feeRowId: number;
  /** The parent execution, so a refused leg can be finalized never-attempted. */
  readonly executionId: number;
  readonly chainId: number;
  readonly publicClient: RunFeeLegInput["publicClient"];
  /** The fee leg's own signer, carrying its own PRE-SIGN fence. */
  readonly deferredSigner: DeferredEvmSigner;
  /** The authority this dispatch was authorized under. Re-asked at the PRE-SUBMIT fence. */
  readonly anchor: AuthorityAnchor;
  /** Anchor the fee's gas estimate on the block the transaction confirmed in. */
  readonly priorLeg: ConfirmedPriorLeg;
}

type RunFeeLegInput = Parameters<typeof runNativeFeeLeg>[1];

/** Thrown out of a signer hook so the staged primitive aborts with nothing signed. */
class FeeFenceRefused extends Error {}

/**
 * The skipped arm's report. Pure, and stated even though nothing ran: a fee that
 * was NOT charged is a decision the record has to carry, not an absence.
 */
export function walletTransactionVexFeeNotCharged(
  plan: Extract<WalletTransactionVexFeePlan, { charged: false }>,
): WalletTransactionVexFeeReport {
  const sentence = walletTxVexFeeSkipSentence(plan.quote);
  return {
    collection: "not_charged",
    collectionNote: `No Vex fee was taken: ${sentence}.`,
    reason: plan.quote.reason,
    candidateFeeWei: plan.quote.feeWei.toString(),
    maxNetworkFeeWei: plan.quote.maxNetworkFeeWei.toString(),
  };
}

/**
 * Finalize a pre-created fee row that will never be signed, best effort.
 *
 * `abortPlannedEvents` from `event_index` 1 is the repository's own
 * never-attempted writer and is exactly right here: its CAS requires
 * `status = 'pending' AND tx_hash IS NULL`, so it finalizes a row that was
 * never staged and CANNOT touch one that was - a staged row belongs to the
 * receipt sweep, and terminalizing it would drop a hash that may be in flight.
 *
 * Best effort by design: it runs after the transaction has already settled, so
 * a database failure here must not become a second, different answer. The
 * hashless-recovery sweep owns the row if this write never lands, which is why
 * `tx_vex_fee` is in `LOCALLY_SIGNABLE_ACTIVITY_ROLES`.
 */
export async function finalizeWalletTransactionFeeRowNeverAttempted(
  executionId: number,
  reason: string,
): Promise<void> {
  try {
    await abortPlannedEvents(executionId, 1, reason);
  } catch (err) {
    logger.warn("wallet.transaction.fee_abort_failed", {
      executionId,
      ...summarizeWalletError(err),
    });
  }
}

/**
 * Sign and settle the fee leg. NEVER THROWS: every path returns a report, and
 * the confirmed transaction that preceded it is untouched on all of them.
 */
export async function collectWalletTransactionVexFee(
  input: CollectWalletTransactionVexFeeInput,
): Promise<WalletTransactionVexFeeReport> {
  const { plan, feeRowId } = input;
  const plannedFeeWei = plan.quote.feeWei.toString();
  const receiver = plan.venue.receiver;

  const collection = await runNativeFeeLeg(plan.venue, {
    plan: plan.leg,
    feeRowId,
    chainId: input.chainId,
    publicClient: input.publicClient,
    signer: input.deferredSigner,
    priorLeg: input.priorLeg,
    // The fee leg's OWN approved ceiling (D8): the signed 42000-gas limit at
    // the per-gas caps the user authorized for this chain.
    bounds: plan.bounds,
    afterStageBeforeSubmit: async () => {
      const fenced = await recheckAuthority(input.anchor, "pre_submit");
      return fenced.ok ? "proceed" : "refuse";
    },
  });

  if (collection.collection === "not_attempted") {
    // The pre-submit arm already terminalized its staged row; this write is a
    // no-op there (the CAS requires a hashless pending row) and the finalizer
    // for every other refusal, which never staged anything.
    await finalizeWalletTransactionFeeRowNeverAttempted(
      input.executionId,
      "the Vex fee transfer was refused before it reached the network",
    );
    return {
      collection: "not_attempted",
      collectionNote: collection.collectionNote,
      plannedFeeWei,
      receiver,
    };
  }

  if (collection.collection === "reverted" || collection.collection === "unconfirmed") {
    return {
      collection: collection.collection,
      collectionNote: collection.collectionNote,
      // The runner only produces these two arms with a hash; the fallback keeps
      // the type honest without asserting.
      txHash: collection.txHash ?? "",
      plannedFeeWei,
      receiver,
    };
  }

  if (collection.collection === "confirmed" || collection.collection === "confirmed_unrecorded") {
    return {
      collection: collection.collection,
      collectionNote: collection.collectionNote,
      txHash: collection.txHash ?? "",
      plannedFeeWei,
      // The transfer's value IS the planned amount on this lane: the base is a
      // digest-bound field, so there is no settled-versus-quoted gap to report.
      collectedFeeWei: plannedFeeWei,
      receiver,
    };
  }

  // `not_charged` is not a value `runNativeFeeLeg` produces - it is the helper
  // for a fee that was never planned, and this function is reached only with a
  // CHARGED plan. Stated as a typed unreachable rather than asserted away, and
  // reported as the conservative truth: nothing was collected.
  return {
    collection: "not_attempted",
    collectionNote: collection.collectionNote,
    plannedFeeWei,
    receiver,
  };
}

/**
 * The DEFERRED signer for the fee leg, with its pre-sign fence.
 *
 * Built here rather than reused from the action's, because the action's signer
 * has already been consumed and its fence answered for a different transaction.
 * The key is decrypted inside `createSigner` and nowhere earlier.
 */
export function buildFeeLegDeferredSigner(args: {
  readonly walletAddress: string;
  readonly chain: DeferredEvmSigner["chain"];
  readonly anchor: AuthorityAnchor;
  readonly loadSigner: () => SignerLoad;
  readonly createWalletClient: (
    wallet: EvmWallet,
  ) => Awaited<ReturnType<DeferredEvmSigner["createSigner"]>>;
}): DeferredEvmSigner {
  return {
    kind: "deferred",
    address: args.walletAddress as `0x${string}`,
    chain: args.chain,
    onBeforeSign: async () => {
      const fenced = await recheckAuthority(args.anchor, "pre_sign");
      if (!fenced.ok) throw new FeeFenceRefused("authority fence refused before signing the fee leg");
    },
    createSigner: async () => {
      const loaded = args.loadSigner();
      if (loaded.kind === "return") {
        throw new FeeFenceRefused("the wallet could not be resolved for signing the fee leg");
      }
      if (loaded.signer.family !== "eip155") {
        throw new FeeFenceRefused("the resolved wallet is not an EVM wallet");
      }
      return args.createWalletClient(loaded.signer);
    },
  };
}
