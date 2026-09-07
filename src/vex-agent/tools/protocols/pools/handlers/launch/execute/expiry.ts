/**
 * WHEN THE AUTHORIZED BYTES DIE, and which clock kills them.
 *
 * One reason to change: the on-chain lifetime of a prepared pools.fun launch.
 * Two consumers, deliberately: the desktop confirmation screen renders this as a
 * countdown, and the broadcaster asks it again at the last gate before the key.
 * They must not be able to disagree - a countdown that says forty seconds while
 * the signer would refuse at ten is a screen that lies.
 *
 * ## Why the check has to happen twice
 *
 * Every earlier gate judges a moment that has already passed by the time a
 * signature exists. The verifier reads the quote against the ANCHORED BLOCK; the
 * desktop lane re-reads the clock when Deploy is clicked. After both of those
 * come authorization, the durable activity write, gas estimation, fee filling
 * and the durable nonce reservation - each a round trip that can stall. A launch
 * could therefore pass with eleven seconds of quote left, spend twelve preparing
 * and then sign calldata the factory was already guaranteed to reject: the
 * deployment fee spent on a certain revert.
 *
 * THE SHAPE IS METAMASK'S `beforePublish`
 * (`agents-colab/metamask-core/packages/transaction-controller/src/TransactionController.ts:3148`):
 * one hook, consulted after every preparation step and immediately before the
 * commit, whose "no" is a first-class outcome rather than an exception in the
 * middle of a half-built transaction. ADOPTED: the position (after preparation,
 * before commit) and the single-hook rule - one gate both entry points pass
 * through, never a copy per caller. REJECTED: their hook runs AFTER
 * `#signTransaction`, so a skipped publish has still touched the key; on a
 * self-custodial path the refusal must land before the signature, which is why
 * this is wired into `signStageBroadcast`'s `onBeforeSign` (the last awaited
 * call before the key) rather than after it.
 *
 * A GATE IS ONLY AS GOOD AS ITS SILENCE AFTERWARDS. The launch therefore signs
 * on the DEFERRED arm, whose signature is produced offline: viem's
 * `signTransaction` wallet action awaits one `eth_chainId` before it reaches the
 * local account (measured in viem 2.54.3), and a node that answers that slowly
 * would let this hook pass with seconds of quote left and the bytes be signed
 * long after the clock it just read had run out. Nothing reaches the network
 * between this check and the signature - see `execute/broadcast.ts` and
 * `staged-broadcast.ts`'s `DeferredEvmSigner`.
 *
 * Rabby carries an approval-time deadline on the approved transaction
 * (`agents-colab/rabby/src/background/controller/provider/controller.ts:699`,
 * `lowGasDeadline`) and signs strictly the approved object - the "sign what was
 * approved, deadline included" half is adopted; it has no last-moment expiry
 * gate of its own, so it is not the model for this hook.
 *
 * ## The clocks
 *
 * Both are absolute unix seconds carried INSIDE the authorized calldata, so they
 * describe the exact bytes and cannot drift from them:
 *
 *   `gateway_deadline`  `LaunchParams.deadline` - the gateway reverts past it.
 *   `quote_window`      `priceAttestation.expiresAt` on a SIGNED_STOCK pair.
 *                       ALL-ZERO IS A REAL VALUE: a pair that needs no signed
 *                       quote carries six zeroes, and reading that as a deadline
 *                       in 1970 would refuse every WETH launch ever prepared.
 *
 * Both get the SAME margin - the verifier's own
 * `POOLS_SIGNED_QUOTE_SAFETY_MARGIN_SECONDS`, not a second number - because the
 * transaction must be INCLUDED before the deadline, not merely signed before it.
 * Signing with two seconds left is a fee spent on a guaranteed revert either
 * way.
 *
 * The reference clock is the HOST's, matching the desktop countdown the user
 * acted on. The verifier judged the same bounds against the anchored block's
 * timestamp; that is the right clock for a check made at a block, and this is
 * the right one for a check made between two blocks, where no block timestamp
 * exists yet.
 */

import { VexError, ErrorCodes } from "../../../../../../../errors.js";
import { POOLS_SIGNED_QUOTE_SAFETY_MARGIN_SECONDS } from "@tools/pools-fun/launch/verify-calldata.js";
import type { PoolsLaunchTuple } from "@tools/pools-fun/launch/verifier-types.js";

/** The two clocks that live inside the calldata itself. */
export type PoolsLaunchOnChainClock = "gateway_deadline" | "quote_window";

export interface PoolsLaunchOnChainExpiry {
  /** Host-clock milliseconds at which these bytes stop being signable. */
  readonly atMs: number;
  readonly clock: PoolsLaunchOnChainClock;
}

/**
 * How much life a launch must still have when the key is asked for a signature.
 *
 * Derived from the verifier's constant rather than restated, so the anchored
 * check and this one can never disagree about how much headroom is enough.
 */
export const POOLS_LAUNCH_SIGNING_MARGIN_MS =
  Number(POOLS_SIGNED_QUOTE_SAFETY_MARGIN_SECONDS) * 1000;

/**
 * The tightest on-chain clock on these bytes, margin already applied, or `null`
 * when the calldata carries neither (a deadline of zero is "no deadline", the
 * shape the gateway accepts).
 */
export function poolsLaunchOnChainExpiry(tuple: PoolsLaunchTuple): PoolsLaunchOnChainExpiry | null {
  const candidates: PoolsLaunchOnChainExpiry[] = [];
  if (tuple.deadline > 0n) {
    candidates.push({
      atMs: Number(tuple.deadline) * 1000 - POOLS_LAUNCH_SIGNING_MARGIN_MS,
      clock: "gateway_deadline",
    });
  }
  const quoteExpiresAt = tuple.priceAttestation.expiresAt;
  if (quoteExpiresAt > 0n) {
    candidates.push({
      atMs: Number(quoteExpiresAt) * 1000 - POOLS_LAUNCH_SIGNING_MARGIN_MS,
      clock: "quote_window",
    });
  }
  let tightest: PoolsLaunchOnChainExpiry | null = null;
  for (const candidate of candidates) {
    if (tightest === null || candidate.atMs < tightest.atMs) tightest = candidate;
  }
  return tightest;
}

/** What a user is told when that clock ran out, in the words of the clock itself. */
function poolsLaunchExpiredSentence(clock: PoolsLaunchOnChainClock): string {
  switch (clock) {
    case "quote_window":
      return (
        "this launch's signed stock price quote expired while the transaction was being prepared. The "
        + "factory prices a stock-paired launch from a backend-signed quote with a short life, and these "
        + "exact bytes would now revert"
      );
    case "gateway_deadline":
      return (
        "this launch's own on-chain deadline passed while the transaction was being prepared, so these "
        + "exact bytes would now revert"
      );
  }
}

/**
 * THE LAST GATE BEFORE THE KEY. Throws - and a throw from `onBeforeSign` means
 * nothing was signed and nothing was sent, which is what makes the refusal
 * honest.
 *
 * The remedy is deliberately "prepare again", never "retry": the calldata pins a
 * salt, a fee and a quote, and a second attempt over the same bytes would meet
 * the same dead clock.
 */
export function assertPoolsLaunchNotExpired(tuple: PoolsLaunchTuple, nowMs: number): void {
  const expiry = poolsLaunchOnChainExpiry(tuple);
  if (expiry === null || nowMs < expiry.atMs) return;
  const sentence =
    `${poolsLaunchExpiredSentence(expiry.clock)}. Nothing was signed, nothing was broadcast and no funds `
    + "moved. Prepare the launch again to get a fresh quote.";
  throw new VexError(ErrorCodes.INTENT_EXPIRED, sentence, sentence);
}
