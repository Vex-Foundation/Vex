import type { Chain, PublicClient, Transport } from "viem";
import { boundGasPriceWei, checkFeeCap, type LegFeeCap } from "@tools/evm-chains/swap-native-debit.js";

/**
 * Quote-bound per-gas ceilings. Preparation starts within them; the live fee
 * estimate then replaces only fee fields, still within the same ceilings.
 * The final request is passed unchanged to the authority fence and offline
 * signer. No ceiling is enlarged at execute time.
 *
 * Gas units remain freshly estimated because the recorded Base estimate moved
 * 2.07x across twelve blocks. The final balance/debit gate prices this leg at
 * its actual fee and every remaining leg at its approved ceiling.
 */
export interface UniswapLegFeeBounds {
  readonly cap: LegFeeCap;
}

/**
 * Why the live fee market could not be shown to still fit the approved ceiling.
 *
 * Three OUTCOMES, not one, because the remedies differ and an agent that cannot
 * tell them apart retries the one case a retry can never clear:
 *
 *   - `approved_gas_price_exceeded` - the requirement was read, compared, and
 *     is higher than the ceiling. Re-quote.
 *   - `live_fee_market_unreadable` - the requirement could not be read at all.
 *     Retry.
 *   - `pricing_mode_changed` - it was read but cannot be compared with this
 *     cap. Re-quote.
 */
export type UniswapLiveFeeMarketRefusalKind =
  | "approved_gas_price_exceeded"
  | "live_fee_market_unreadable"
  | "pricing_mode_changed";

/**
 * The approved per-gas ceiling could NOT be shown to still cover the chain's
 * current requirement, in the pre-sign window.
 *
 * The family exists because all three members are the SAME control failing, and
 * one `instanceof` at each consumer is what keeps them out of
 * `classifyUniswapRevertError`, which would flatten every one of them to
 * `unknown` and replace the only sentence that says what was wrong.
 *
 * A READ THAT FAILS IS A REFUSAL, not a pass. metamask-core's pay controller
 * takes the same position where it re-reads a live balance before committing
 * (`packages/transaction-pay-controller/src/utils/validation.ts:205-215`): an
 * unreachable read throws its own typed reason (`balance-unavailable`,
 * `types.ts:506`) beside `insufficient-source-balance` rather than falling
 * through to acceptance. A control that could not run did not run, and saying
 * otherwise is the claim this class exists to stop.
 */
export class UniswapLiveFeeMarketRefusal extends Error {
  constructor(
    /** Which of the three outcomes above this is, for consumers that branch. */
    readonly kind: UniswapLiveFeeMarketRefusalKind,
    /**
     * Whether repeating the SAME execution can plausibly succeed. Only an
     * unreadable market is retryable: a risen price and a changed pricing mode
     * both invalidate the quote's arithmetic, and only a fresh quote clears
     * them.
     */
    readonly retryable: boolean,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "UniswapLiveFeeMarketRefusal";
  }
}

/**
 * The chain now REQUIRES more per gas than the approved quote's ceiling.
 *
 * A distinct failure from {@link UniswapFeeCapExceededError}, and it exists
 * because the two describe opposite directions of the same window. That one
 * catches a prepared request priced ABOVE the ceiling. This one catches the
 * case the ceiling itself creates: because the cap is forced into preparation,
 * the request can never exceed it, so a base-fee rise produces a signed
 * transaction priced BELOW what the node currently wants - underpriced, stuck
 * pending, and ambiguous rather than refused. MetaMask has the same shape in
 * its own submit path (`strategy/server/server-submit.ts:518-565` re-reads the
 * live requirement before committing rather than trusting the quote's copy).
 *
 * Recoverable and named, in the same family as the leg-set refusal: nothing was
 * signed, and a fresh quote prices the swap at the market that exists now.
 */
export class UniswapApprovedGasPriceExceededError extends UniswapLiveFeeMarketRefusal {
  constructor(field: string, liveRaw: string, approvedRaw: string) {
    super(
      "approved_gas_price_exceeded",
      false,
      `Refused before signing: the gas price moved past what you approved - the current fee estimate is `
      + `${liveRaw} wei/gas for ${field}, above the approved ceiling of ${approvedRaw} wei/gas. `
      + "Nothing was signed and nothing was broadcast. Request a fresh "
      + "uniswap__swap_quote and execute against that.",
    );
    this.name = "UniswapApprovedGasPriceExceededError";
  }
}

/**
 * The chain's CURRENT per-gas requirement could not be read at all.
 *
 * Fail-closed, and this is the whole correction: the previous build caught the
 * failed read and returned, which signed under a ceiling nobody had compared to
 * anything. The other-direction assertion does not cover it - it proves the
 * bytes are not priced ABOVE the cap, which is guaranteed by construction once
 * the cap is forced into preparation, and says nothing about whether the cap is
 * still ENOUGH. With the requirement unknown, signing means broadcasting a
 * transaction that may be underpriced, stuck pending, and ambiguous.
 *
 * RETRYABLE, alone in this family: nothing about the quote is invalid: only the
 * node failed to answer, and the same execution can succeed on the next attempt.
 * The provider's own text is NOT in the message (it is provider-controlled and
 * would reach the agent unscrubbed); it is carried on `cause` for logs.
 */
export class UniswapLiveFeeRequirementUnreadableError extends UniswapLiveFeeMarketRefusal {
  constructor(cause: unknown) {
    super(
      "live_fee_market_unreadable",
      true,
      "Refused before signing: the current gas market could not be read, so this quote's approved "
      + "gas ceiling could not be shown to still cover what the chain requires. Signing on an "
      + "unknown requirement risks broadcasting an underpriced transaction that sits pending "
      + "instead of settling. Nothing was signed and nothing was broadcast. Retry this execute in "
      + "a moment; if the node stays unreachable, request a fresh uniswap__swap_quote.",
      { cause },
    );
    this.name = "UniswapLiveFeeRequirementUnreadableError";
  }
}

/**
 * The chain answers in a DIFFERENT pricing mode than the approved cap was
 * priced in, so the two cannot be compared.
 *
 * Not a rise and not a read failure: a `gasPrice` and a `maxFeePerGas` are
 * different quantities, and `checkFeeCap` refuses to compare them for exactly
 * that reason (`swap-native-debit.ts:320-326`). The old build returned here,
 * which delegated the case to a "fallback owner" that cannot see it: the cap is
 * forced into `prepareTransactionRequest`, so the prepared request always comes
 * back in the APPROVED mode and the prepared-request check can never observe a
 * live mode change.
 *
 * Re-quote, not retry: a mode change is a property of the chain right now, and
 * repeating the same approved cap reproduces it exactly.
 */
export class UniswapApprovedGasPricingModeChangedError extends UniswapLiveFeeMarketRefusal {
  constructor(liveMode: LegFeeCap["mode"], approvedMode: LegFeeCap["mode"]) {
    super(
      "pricing_mode_changed",
      false,
      `Refused before signing: the chain changed pricing mode under your approval - it now prices `
      + `gas as ${liveMode} and this quote was approved under ${approvedMode}. Those are different `
      + "quantities, so the approved ceiling cannot be shown to still cover what the chain "
      + "requires. Nothing was signed and nothing was broadcast. Request a fresh "
      + "uniswap__swap_quote and execute against that.",
    );
    this.name = "UniswapApprovedGasPricingModeChangedError";
  }
}

/**
 * A leg whose current requirement no longer fits the ceiling its debit was
 * computed under.
 *
 * Its own class, like the final-request refusal, because it is not a router
 * revert: nothing was estimated wrong and nothing reverted - the chain simply
 * got more expensive than the total this execute proved the wallet could pay,
 * and the answer is a fresh quote rather than a retry at whatever the node now
 * asks for.
 */
export class UniswapFeeCapExceededError extends Error {
  constructor(field: string, requiredRaw: string, approvedRaw: string) {
    super(
      `Refused before signing: this leg's ${field} is now ${requiredRaw}, above the ${approvedRaw} `
      + "this execute's native-debit total was computed under. Nothing was signed and nothing was "
      + "broadcast. Request a fresh uniswap__swap_quote and execute against that.",
    );
    this.name = "UniswapFeeCapExceededError";
  }
}

/**
 * Judge the request that is about to be serialized against the approved
 * ceiling.
 *
 * The prices come off the REQUEST, never off the bounds: the ceiling is what
 * was asked for and this is what viem would serialize. An absent price on a
 * chain the cap calls EIP-1559 (or the reverse) is a pricing-mode mismatch,
 * which `checkFeeCap` refuses on its own - a cap approved as one mode says
 * nothing about what the other may be.
 */
function assertWithinLegFeeBounds(
  request: {
    readonly gasPrice?: bigint | undefined;
    readonly maxFeePerGas?: bigint | undefined;
    readonly maxPriorityFeePerGas?: bigint | undefined;
  },
  bounds: UniswapLegFeeBounds,
): void {
  if (request.maxFeePerGas === undefined && request.gasPrice === undefined) {
    // No price at all is not a cheap transaction: it is a request whose cost
    // this build cannot state, and a cost nobody can state cannot be inside a
    // ceiling. Refused rather than treated as zero.
    throw new UniswapFeeCapExceededError("fee price", "unstated", boundGasPriceWei(bounds.cap).toString(10));
  }
  const current: LegFeeCap = request.maxFeePerGas !== undefined
    ? {
        mode: "eip1559",
        maxFeePerGasWei: request.maxFeePerGas,
        maxPriorityFeePerGasWei: request.maxPriorityFeePerGas ?? 0n,
      }
    : { mode: "legacy", gasPriceWei: request.gasPrice ?? 0n };
  // The gas figure is passed EQUAL on both sides on purpose: this assertion is
  // about the per-gas price only (see `UniswapLegFeeBounds`), and `checkFeeCap`
  // is reused rather than re-implemented so the price comparison, the
  // mode-mismatch refusal and the debit arithmetic all come from one owner.
  const verdict = checkFeeCap(
    { gasLimit: 0n, cap: current },
    { gasLimit: 0n, cap: bounds.cap },
  );
  if (!verdict.withinCap) {
    throw new UniswapFeeCapExceededError(verdict.field, verdict.requiredRaw, verdict.approvedRaw);
  }
}

/**
 * Refuse when the LIVE fee requirement has risen above the approved ceiling.
 *
 * SAME BASIS ON BOTH SIDES, which is what makes the comparison meaningful: the
 * quote established its ceiling with headroom over `estimateFeesPerGas` (falling back to
 * `getGasPrice`) in `native-debit-plan.ts`'s `resolveUniswapLegFeeCap`, and this
 * reads the same two actions in the same order. A rise between them is a rise
 * in the same number the human approved, not a comparison of two different
 * quantities.
 *
 * FAIL-CLOSED ON BOTH NON-ANSWERS, which is the correction this function
 * carries. A requirement that cannot be READ and one that cannot be COMPARED
 * are each their own named refusal rather than a silent return:
 *
 *   - the other-direction assertion is not a fallback for either. It proves the
 *     bytes are not priced above the cap, which the forced cap guarantees by
 *     construction, and says nothing about the cap still being ENOUGH;
 *   - the prepared-request mode check is not a fallback for the mode case
 *     either, and cannot be: preparation is FORCED into the approved mode, so
 *     the request always comes back in it and a live mode change is invisible
 *     there.
 *
 * A control that could not run did not run. The alternative - returning - signs
 * a transaction that may already be underpriced, which is stuck pending and
 * ambiguous rather than refused, and reports a check it never performed.
 */
async function assertApprovedCapStillSuffices(
  publicClient: PublicClient<Transport, Chain>,
  bounds: UniswapLegFeeBounds,
): Promise<LegFeeCap> {
  let reading: LiveFeeRequirement;
  try {
    reading = await readLiveFeeRequirement(publicClient);
  } catch (cause) {
    throw new UniswapLiveFeeRequirementUnreadableError(cause);
  }
  const live = reading.cap;
  if (live.mode !== bounds.cap.mode) {
    // A legacy answer that exists ONLY because the 1559 question itself failed
    // is a degraded read, not evidence the chain repriced: reported as the
    // unreadable (retryable) case rather than sending the agent for a fresh
    // quote that would hit the same node.
    if (!reading.modeIsAuthoritative) {
      throw new UniswapLiveFeeRequirementUnreadableError(reading.suggestionFailure);
    }
    throw new UniswapApprovedGasPricingModeChangedError(live.mode, bounds.cap.mode);
  }

  if (live.mode === "eip1559" && bounds.cap.mode === "eip1559") {
    if (live.maxFeePerGasWei > bounds.cap.maxFeePerGasWei) {
      throw new UniswapApprovedGasPriceExceededError(
        "maxFeePerGas",
        live.maxFeePerGasWei.toString(10),
        bounds.cap.maxFeePerGasWei.toString(10),
      );
    }
    if (live.maxPriorityFeePerGasWei > bounds.cap.maxPriorityFeePerGasWei) {
      throw new UniswapApprovedGasPriceExceededError(
        "maxPriorityFeePerGas",
        live.maxPriorityFeePerGasWei.toString(10),
        bounds.cap.maxPriorityFeePerGasWei.toString(10),
      );
    }
    return live;
  }
  if (live.mode === "legacy" && bounds.cap.mode === "legacy"
    && live.gasPriceWei > bounds.cap.gasPriceWei) {
    throw new UniswapApprovedGasPriceExceededError(
      "gasPrice",
      live.gasPriceWei.toString(10),
      bounds.cap.gasPriceWei.toString(10),
    );
  }
  return live;
}

/** Reprice only the fee fields, before the final authority fence, under the sealed ceiling. */
export async function resolveUniswapSigningFees(
  client: PublicClient<Transport, Chain>,
  prepared: { readonly gasPrice?: bigint; readonly maxFeePerGas?: bigint; readonly maxPriorityFeePerGas?: bigint },
  bounds: UniswapLegFeeBounds,
): Promise<{ gasPrice: bigint; maxFeePerGas: undefined; maxPriorityFeePerGas: undefined }
  | { gasPrice: undefined; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  assertWithinLegFeeBounds(prepared, bounds);
  const live = await assertApprovedCapStillSuffices(client, bounds);
  return live.mode === "eip1559"
    ? { gasPrice: undefined, maxFeePerGas: live.maxFeePerGasWei, maxPriorityFeePerGas: live.maxPriorityFeePerGasWei }
    : { gasPrice: live.gasPriceWei, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined };
}

/** The chain's current requirement, plus how much its MODE can be trusted. */
interface LiveFeeRequirement {
  readonly cap: LegFeeCap;
  /**
   * Whether the mode of `cap` is the chain's ANSWER or an artifact of the
   * fallback. False when `estimateFeesPerGas` threw and only `getGasPrice`
   * replied: that legacy shape says nothing about how the chain prices gas, so
   * a mismatch against an EIP-1559 cap must be reported as an unreadable
   * market, never as a repricing.
   */
  readonly modeIsAuthoritative: boolean;
  /** The suggestion call's own failure, for the unreadable refusal's `cause`. */
  readonly suggestionFailure?: unknown;
}

/** The chain's CURRENT suggestion, in the same order the quote's cap was read. */
async function readLiveFeeRequirement(
  publicClient: PublicClient<Transport, Chain>,
): Promise<LiveFeeRequirement> {
  let suggestionFailure: unknown;
  try {
    const fees = await publicClient.estimateFeesPerGas();
    if (fees.maxFeePerGas !== undefined) {
      return {
        cap: {
          mode: "eip1559",
          maxFeePerGasWei: fees.maxFeePerGas,
          maxPriorityFeePerGasWei: fees.maxPriorityFeePerGas ?? 0n,
        },
        modeIsAuthoritative: true,
      };
    }
    if (fees.gasPrice !== undefined) {
      return { cap: { mode: "legacy", gasPriceWei: fees.gasPrice }, modeIsAuthoritative: true };
    }
    // Answered, but with neither price: nothing to compare and nothing to
    // classify as a repricing either.
    suggestionFailure = new Error("estimateFeesPerGas returned no price");
  } catch (err) {
    // Same fall-through the quote-time reader uses: a chain that cannot answer
    // the 1559 question can still state a gas price. What it cannot do is prove
    // the chain is a legacy chain, which is why the flag travels with it.
    suggestionFailure = err;
  }
  return {
    cap: { mode: "legacy", gasPriceWei: await publicClient.getGasPrice() },
    modeIsAuthoritative: false,
    suggestionFailure,
  };
}
