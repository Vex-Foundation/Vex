/**
 * What Vex TELLS THE AGENT when the pre-sign `eth_estimateGas` refused a leg.
 *
 * WHY IT EXISTS — live 2026-07-25, Base, native ETH → USDC, 2 hops, default 50
 * bps. The estimate reverted with `Return amount is not enough`: the pool had
 * moved past the `minReturnAmount` embedded in the built calldata between
 * build and estimate. Nothing was signed, and the `agent_activity` row said so
 * honestly. The message handed to the AGENT did not — it said an internal
 * error had interrupted the swap "after it was already recorded" and to "check
 * the record before taking any further action". An autonomous agent's own
 * doctrine on an ambiguous record is do-not-retry, so it stopped permanently
 * on the single most routine recoverable failure an EVM swap has. The same
 * swap at 300 bps landed seconds later.
 *
 * The rule this module encodes (phase-3 plan rule 8, DO NOT BREAK AUTONOMY):
 * a refusal is only safe if it refuses what would actually lose money, says
 * what to change and whether a retry can succeed, and leaves a path the agent
 * can walk with no user present. A refusal an agent cannot act on does not
 * make the system safe; it strands the mission.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER. `DependentLegGasEstimateError`
 * (`dependent-leg-gas-estimate.ts`) is excluded from `classifyPreSignRevert` by
 * an explicit `instanceof` guard, not by call-site discipline. That error is
 * raised only after an approval THIS plan already confirmed, and the live
 * evidence behind it is a node that reported `ERC20: transfer amount exceeds
 * allowance` for a transaction that was in fact fine — an unchanged retry
 * succeeded. That string is not evidence of anything, so classifying it would
 * assert exactly the conclusion the retry loop exists because we cannot
 * support. It keeps its own branch and its own wording.
 *
 * THE ONE NARROWING (owner-accepted escalation, 2026-07-25). The doctrine above
 * is right about the string it was written for, and too broad for one other.
 * `classifyDependentLegPoolStateRevert` (below) admits a POOL-STATE reason —
 * and nothing else — once every retry has failed, because that case fails both
 * halves of the lag hypothesis:
 *   1. NO EARLY EXIT. `retryEstimateAfterConfirmedPriorLeg` returns only on a
 *      successful estimate; the error escapes solely after all
 *      `DEPENDENT_LEG_ESTIMATE_ATTEMPTS` attempts failed across its backoff,
 *      and the reason we classify is the LAST one — observed after
 *      `waitForHeadAtLeast` saw the prior leg's own block. Lag has been given
 *      the wait that exists to absorb it.
 *   2. LAG CANNOT MANUFACTURE IT. The observed lie was about ALLOWANCE — the
 *      state our confirming leg had just changed, and exactly what a lagging
 *      node has not applied. Pool reserves are not state an approval touches,
 *      and a node behind the head reads them at an EARLIER block, closer to
 *      quote time — which makes a spurious price-guard refusal LESS likely, not
 *      more. Lag can mask this reason; it cannot invent it.
 * Everything else — allowance, deadline, liquidity, unmapped — keeps the
 * unchanged retry-then-stop wording, because for those the doctrine holds.
 *
 * SCRUB OWNERSHIP. `classifyPreSignRevert` returns the chain's reason RAW,
 * because the redaction boundary belongs to the venue handler (C37: one scrub
 * entry point per venue, never a fork). `preSignRefusalGuidance` therefore
 * requires a reason its CALLER has already put through that boundary — see
 * both call sites in `kyberswap/handlers/swap.ts` and
 * `uniswap/handlers/swap.ts`.
 */

import { slippageRemediation } from "../../utils/error-summary.js";

import { DependentLegGasEstimateError } from "./dependent-leg-gas-estimate.js";
import {
  classifyRouterRevertReason,
  extractDecodedRevertReason,
  type EvmRouterRevertFailureCode,
} from "./router-revert-reason.js";

/** The tolerance this attempt actually applied, and the ceiling a retry may not exceed. Both are quoted to the agent — a remedy without numbers is not actionable. */
export interface PreSignSlippageBounds {
  readonly appliedBps: number;
  readonly maxBps: number;
  /**
   * The price impact of the quote THIS attempt was built from, as a FRACTION
   * (0.0015 = 0.15%) — KyberSwap's own convention (`kyberswap/helpers.ts`).
   * Optional: a venue that has no impact to report omits it and the refusal
   * simply says less, rather than printing a number nobody measured.
   */
  readonly observedPriceImpactFraction?: number | null;
}

export interface PreSignRevertClassification {
  readonly failureCode: EvmRouterRevertFailureCode;
  /** UNTRUSTED, chain-controlled text — scrub before use (see the file header). */
  readonly revertReason: string;
}

/**
 * Classify a thrown PRE-SIGN error as an on-chain revert, or `null` when it is
 * not one.
 *
 * `null` means "this is not a provable chain refusal" and the caller must fall
 * back to its own generic handling — never to the safe-to-re-run framing,
 * which is only honest for an error we can place. A `DependentLegGasEstimateError`
 * is also `null` (see the file header).
 *
 * A genuine decoded revert with no row in the shared table is
 * `simulation_reverted`: the chain definitively refused, we simply have no
 * specific bucket. That is a real, honest outcome, never a fabricated one.
 */
export function classifyPreSignRevert(err: unknown): PreSignRevertClassification | null {
  if (err instanceof DependentLegGasEstimateError) return null;
  const revertReason = extractDecodedRevertReason(err);
  if (revertReason === undefined) return null;
  return {
    failureCode: classifyRouterRevertReason(revertReason) ?? "simulation_reverted",
    revertReason,
  };
}

/**
 * Classify the revert a dependent leg's estimate STILL returned after every
 * lag-absorbing retry failed — and only when the reason is about POOL STATE.
 *
 * `null` for every other reason, including the allowance strings the retry loop
 * was built for: the caller must then keep its unchanged `DependentLegGasEstimateError`
 * wording. See "THE ONE NARROWING" in the file header for why this single class
 * is admissible where the rest are not.
 *
 * Deliberately a SEPARATE entry point from `classifyPreSignRevert`, which still
 * answers `null` for this error type. The two ask different questions with
 * different evidence bars ("is this a provable refusal of a leg with no state
 * of ours behind it" vs "did a pool-state reason survive the lag retries"), and
 * a venue opts into this one explicitly, inside its own dependent-leg branch.
 */
export function classifyDependentLegPoolStateRevert(
  err: DependentLegGasEstimateError,
): PreSignRevertClassification | null {
  const revertReason = extractDecodedRevertReason(err);
  if (revertReason === undefined) return null;
  const failureCode = classifyRouterRevertReason(revertReason);
  // Pool price only. `insufficient_liquidity`, `deadline_expired`,
  // `allowance_or_balance` and an unmapped reason all stay with the retry
  // branch — widening this set needs its own evidence, not a family resemblance.
  if (failureCode !== "slippage") return null;
  return { failureCode, revertReason };
}

/**
 * The remedy for a pre-sign refusal, in the agent's own vocabulary. Names the
 * parameter to change and says plainly whether a retry can succeed; where no
 * remedy is known it says THAT instead of inventing one.
 */
function remedyFor(failureCode: EvmRouterRevertFailureCode, slippage: PreSignSlippageBounds): string {
  switch (failureCode) {
    case "slippage":
      // The shared remedy is owned by `utils/error-summary/remediation.ts` so
      // this venue, Jupiter and any later one cannot drift apart on the ONE
      // money instruction they all give. The priceImpact exception is opted
      // into HERE (`staleReserveCaution`) because it holds for the EVM venues'
      // cost-positive impact and not for Jupiter's inverted sign.
      // It is not decoration: `engine/prompts/protocols.ts`
      // already teaches that on a chain whose indexed reserves are stale, this
      // exact revert together with a strongly negative priceImpact means the
      // QUOTE is wrong, and raising tolerance there buys a worse fill rather
      // than a fill. A remedy that contradicted shipped guidance would be worse
      // than none.
      return `That is the price guard doing its job: the pool moved past the minimum output written into this quote's calldata between the quote and the estimate. `
        + slippageRemediation({ ...slippage, staleReserveCaution: true });
    case "deadline_expired":
      return `The quote's deadline had already passed when the estimate ran. Get a fresh quote and execute it promptly; that alone can succeed.`;
    case "allowance_or_balance":
      return `The wallet's balance, or the router's allowance for the input token, was short at estimate time. Check both and reduce the amount if needed — repeating the same request unchanged will be refused the same way.`;
    case "insufficient_liquidity":
      return `The pool cannot fill this size at all. Retry with a smaller amountIn, or route through a different pair or venue — repeating the same request unchanged will be refused the same way.`;
    default:
      return `No specific remedy is known for that reason. Get a fresh quote and try once more, since the route may simply have gone stale; if a fresh quote is refused the same way, treat this route as unavailable and try another pair or venue rather than repeating it.`;
  }
}

/**
 * The full agent-facing refusal: what is provable, what the chain said, and
 * what to do next.
 *
 * `revertReason` MUST already have crossed the caller's own output scrub
 * boundary (C37) — this module never redacts, because forking a second scrub
 * is exactly what that contract forbids.
 */
export function preSignRefusalGuidance(input: {
  readonly revertReason: string;
  readonly failureCode: EvmRouterRevertFailureCode;
  readonly slippage: PreSignSlippageBounds;
}): string {
  return `Nothing was signed or broadcast for this step, so it moved no funds and re-running cannot duplicate it. `
    + `The pre-sign gas estimate was refused on-chain: ${input.revertReason}. `
    + remedyFor(input.failureCode, input.slippage);
}

/**
 * The same refusal, for a leg that follows a leg this plan already confirmed —
 * the ERC-20-input shape, where a genuine price-guard refusal can only reach
 * the agent after the retry loop has exhausted itself.
 *
 * It COMPOSES `preSignRefusalGuidance` rather than restating it: there is one
 * remedy text for a slippage refusal and a second copy would drift from the
 * shipped `priceImpact` caution it has to stay consistent with. The added
 * sentence is the evidence that separates this path from the native-input one —
 * the lag hypothesis was already tested and failed, so "retry unchanged once"
 * is NOT the advice here.
 *
 * `revertReason` MUST already have crossed the caller's own scrub boundary (C37).
 */
export function dependentLegPoolStateRefusalGuidance(input: {
  readonly error: DependentLegGasEstimateError;
  readonly revertReason: string;
  readonly failureCode: EvmRouterRevertFailureCode;
  readonly slippage: PreSignSlippageBounds;
}): string {
  return preSignRefusalGuidance({
    revertReason: input.revertReason,
    failureCode: input.failureCode,
    slippage: input.slippage,
  })
    + ` For the record: the estimate was retried ${input.error.attempts} times after the previous step confirmed on-chain at block ${input.error.priorLegBlockNumber} — the wait that exists to absorb an RPC still catching up to that step — and the refusal survived it. `
    + `A node behind the head would read the pool at an EARLIER block, closer to this quote, so lag cannot produce this reason: re-quoting is the move, not re-running the identical request.`;
}
