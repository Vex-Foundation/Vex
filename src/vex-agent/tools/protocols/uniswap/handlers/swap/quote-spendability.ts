/**
 * The Uniswap half of SPENDABILITY: turn this venue's leg plan and EVM chain
 * reads into the two legs `quote-authority/spendability.ts` judges, and refuse
 * a signature the wallet can no longer pay for.
 *
 * WHY IT LIVES HERE and not beside the reads. `src/tools` may not import
 * `src/vex-agent`, and the shared evaluator, the shortfall vocabulary and the
 * eligibility union all live on the agent side. So `tools/evm-chains` owns the
 * RPC primitives and the debit arithmetic (WP2-E0), `./native-debit-plan.ts`
 * owns what THIS venue's swap costs, and this module owns the composition into
 * the one evaluator every venue shares. There is no second verdict here.
 *
 * ONE DERIVATION, TWO WINDOWS. The quote handler and every leg's pre-sign gate
 * call the SAME planner over the SAME legs. What differs is only WHEN it runs
 * and what a shortfall does: at quote time it records an ineligible row, at
 * pre-sign it refuses the signature.
 */

import { type Address } from "viem";

import { observeErc20SourceBalance, observeNativeSourceBalance } from "@tools/evm-chains/source-balance-observation.js";
import { checkFeeCap, type LegFeeCap, type NativeDebitLegRole } from "@tools/evm-chains/swap-native-debit.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/uniswap/execute.js";
import type { UniswapToken } from "@tools/uniswap/types.js";

import { VexError, ErrorCodes } from "../../../../../../errors.js";
import type { BoundDebitPlan } from "../../../quote-authority/debit-plan.js";
import {
  judgePendingObservation,
  type InFlightBroadcastReader,
} from "../../../quote-authority/pending-debit-compensation.js";
import type { QuoteEligibility } from "../../../quote-authority/eligibility.js";
import {
  evaluateSpendability,
  formatShortfall,
  type SpendabilityAssetCheck,
} from "../../../quote-authority/spendability.js";
import type {
  AssetRef,
  SourceBalanceRead,
  SpendabilityPreview,
} from "../../../quote-authority/spendability-contract.js";
import { nativeSymbolFor } from "./chain-native.js";
import {
  estimateUniswapPlanGas,
  priceUniswapNativeDebit,
  UNISWAP_SPENDABILITY_CAUSES,
  type UniswapNativeDebit,
  type UniswapPlannedLeg,
  type UniswapSpendabilityClient,
} from "./native-debit-plan.js";

/** Every EVM native coin this venue serves has 18 decimals. */
const NATIVE_DECIMALS = 18;

export interface UniswapSpendabilityObservation {
  readonly source: SpendabilityAssetCheck;
  readonly native: SpendabilityAssetCheck;
  readonly debit: UniswapNativeDebit;
}

/**
 * Read both legs for one plan.
 *
 * Never throws for a chain-read failure: an unreadable balance is a FIRST-CLASS
 * outcome that becomes `balance_unavailable`, which fails closed in both
 * windows. A native-input swap takes ONE read and uses it for both legs - the
 * same balance answered twice from two moments is two statements about two
 * different worlds.
 */
export async function observeUniswapSwapSpendability(input: {
  readonly client: UniswapSpendabilityClient;
  readonly chainId: number;
  readonly wallet: Address;
  readonly tokenIn: UniswapToken;
  /**
   * What the SOURCE asset must still cover. The FULL requested amount while the
   * swap is unbroadcast - never the router's net figure, because the fee leg
   * takes the remainder out of the same asset.
   */
  readonly sourceRequiredRaw: bigint;
  readonly debit: UniswapNativeDebit;
  readonly signal?: AbortSignal;
  /** Injectable for tests; production reads Vex's own durable broadcast record. */
  readonly readInFlightBroadcast?: InFlightBroadcastReader | undefined;
}): Promise<UniswapSpendabilityObservation> {
  const { client, chainId, wallet, tokenIn } = input;
  const nativeSymbol = nativeSymbolFor(chainId);
  const nativeAsset: AssetRef = {
    chainId,
    address: NATIVE_TOKEN_ADDRESS,
    symbol: nativeSymbol,
  };
  const sourceAsset: AssetRef = {
    chainId,
    address: tokenIn.isNative ? NATIVE_TOKEN_ADDRESS : tokenIn.address,
    symbol: tokenIn.isNative ? nativeSymbol : tokenIn.symbol,
  };

  // DOES `pending` MEAN ANYTHING ON THIS CHAIN. Fourteen of the eighteen endpoints
  // a Vex venue reaches answer the tag with the head block or expose no pending
  // block at all (measured, `evm-chains/pending-block-capability.ts`), so on
  // those the read below cannot see this wallet's own in-flight spending and is
  // compensated by Vex's durable record of what it broadcast. Asked BEFORE the
  // reads: a verdict that refuses makes both reads unusable, and taking them
  // anyway would spend two round trips to produce numbers no gate may use.
  // `undefined` selects the parameter's own default reader; it is never a
  // silent "skip the check".
  const pending = await judgePendingObservation({ chainId, wallet }, input.readInFlightBroadcast);
  if (!pending.ok) {
    return {
      source: {
        read: { ok: false, asset: sourceAsset, cause: pending.cause },
        requiredRaw: input.sourceRequiredRaw.toString(10),
        symbol: tokenIn.isNative ? nativeSymbol : tokenIn.symbol,
      },
      native: {
        read: { ok: false, asset: nativeAsset, cause: pending.cause },
        requiredRaw: input.debit.ok ? input.debit.totalRaw : "0",
        symbol: nativeSymbol,
      },
      debit: input.debit,
    };
  }

  const nativeRead: SourceBalanceRead = await observeNativeSourceBalance(client, {
    chainId,
    wallet,
    assetAddress: NATIVE_TOKEN_ADDRESS,
    decimals: NATIVE_DECIMALS,
    symbol: nativeSymbol,
    blockTag: "pending",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const sourceRead: SourceBalanceRead = tokenIn.isNative
    ? nativeRead
    : await observeErc20SourceBalance(client, {
        chainId,
        wallet,
        token: tokenIn.address as Address,
        assetAddress: tokenIn.address,
        decimals: tokenIn.decimals,
        symbol: tokenIn.symbol,
        blockTag: "pending",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });

  return {
    source: {
      read: sourceRead,
      requiredRaw: input.sourceRequiredRaw.toString(10),
      symbol: tokenIn.isNative ? nativeSymbol : tokenIn.symbol,
    },
    native: {
      // A debit that could not be STATED is a requirement nobody knows, and an
      // unknown requirement fails closed exactly like an unreadable balance.
      // The read itself may well have succeeded; what is missing is the other
      // half of the comparison, and the cause names which.
      read: input.debit.ok
        ? nativeRead
        : { ok: false, asset: nativeAsset, cause: input.debit.cause },
      requiredRaw: input.debit.ok ? input.debit.totalRaw : "0",
      symbol: nativeSymbol,
    },
    debit: input.debit,
  };
}

/**
 * Judge one observation with the shared evaluator.
 *
 * `routeEligibility` is what the ROUTE already earned - impact, snapshot size,
 * provider shape. A non-executable route is returned unchanged: a wallet that
 * cannot fund an unusable route has the smaller problem.
 */
export function judgeUniswapSpendability(
  observation: UniswapSpendabilityObservation,
  routeEligibility: QuoteEligibility,
  debitPlan?: BoundDebitPlan,
): { readonly eligibility: QuoteEligibility; readonly preview: SpendabilityPreview | undefined } {
  return evaluateSpendability({
    routeEligibility,
    source: observation.source,
    native: observation.native,
    // Carried onto the card so a person sees the transaction set the binding
    // will enforce, not only the total it costs. Absent at the pre-sign gate,
    // whose caller renders no card.
    ...(debitPlan === undefined ? {} : { debitPlan }),
  });
}

/**
 * The agent-facing consequence of a SPENDABILITY verdict, in the same breath as
 * the route. Mirrors the sibling venue's wording, because the three verdicts
 * mean exactly the same thing on both and an agent should not have to learn two
 * vocabularies for one union.
 *
 * The executable arm is not silent about HOW the total was reached: a leg priced
 * conservatively is named, with the reason it could not be simulated.
 */
export function uniswapSpendabilityNote(
  eligibility: QuoteEligibility,
  conservativeRoles: readonly NativeDebitLegRole[] = [],
): string {
  switch (eligibility.kind) {
    case "insufficient_balance":
      return `The wallet does not hold enough of the input token for this trade: required ${formatShortfall(eligibility.required)},`
        + ` current ${formatShortfall(eligibility.current)}, missing ${formatShortfall(eligibility.missing)}.`
        + " The route is shown, but this quote does NOT authorize an execute. Fund the wallet or trade a smaller size, then quote again.";
    case "balance_unavailable":
      return `A balance this trade depends on could not be read (${eligibility.cause}), so it is unknown whether the wallet can pay for it.`
        + " The route is shown, but this quote does NOT authorize an execute - an unreadable balance fails closed."
        + " Retry the quote; if it keeps failing, check the chain connection before trading.";
    case "gas_reserve_insufficient":
      return `The wallet cannot cover this swap's native gas debit: required ${formatShortfall(eligibility.required)},`
        + ` current ${formatShortfall(eligibility.current)}, missing ${formatShortfall(eligibility.missing)}.`
        + " The required figure covers every transaction this swap would broadcast - allowance legs, the swap, the Vex fee transfer -"
        + " plus a measured reserve for the next one."
        + " The route is shown, but this quote does NOT authorize an execute. Top up the native balance, then quote again.";
    default:
      return conservativeRoles.length === 0
        ? "The wallet's input balance and its whole native debit (every leg this swap broadcasts, plus a measured follow-up reserve)"
          + " were read at the pending block and both cover this trade. That is a quote-time observation; the authoritative read happens"
          + " immediately before signing."
        : `The wallet's input balance and this swap's WHOLE native debit were read at the pending block and both cover this trade.`
          + ` The ${conservativeRoles.join(" and ")} leg could not be simulated yet (an ERC-20 swap cannot be simulated before its`
          + " allowance exists), so its gas was priced CONSERVATIVELY from the quoter's own estimate plus headroom rather than measured."
          + " The total is a whole cost, not a lower bound. The authoritative read happens immediately before signing, where every"
          + " remaining leg is priced again.";
  }
}

/**
 * The refusal an ineligible verdict becomes in the PRE-SIGN window.
 *
 * States the same three figures the approval card carried - required, held,
 * missing - so a person who consented to a quote can see exactly which of them
 * changed underneath it. `null` for an executable verdict: there is nothing to
 * refuse.
 */
export function preSignSpendabilityRefusal(
  eligibility: QuoteEligibility,
): UniswapPreSignDebitRefusal | null {
  switch (eligibility.kind) {
    case "insufficient_balance":
      return new UniswapPreSignDebitRefusal(
        ErrorCodes.INSUFFICIENT_BALANCE,
        `Refusing to sign: the wallet no longer holds enough of the input token to fund this swap. Required ${formatShortfall(eligibility.required)},`
          + ` held ${formatShortfall(eligibility.current)}, short ${formatShortfall(eligibility.missing)}.`,
        "Nothing was signed or broadcast. Fund the wallet or re-quote a smaller amount.",
        false,
      );
    case "gas_reserve_insufficient":
      return new UniswapPreSignDebitRefusal(
        ErrorCodes.INSUFFICIENT_BALANCE,
        `Refusing to sign: the wallet cannot cover this swap's remaining native cost. Required ${formatShortfall(eligibility.required)}`
          + ` (this leg, every leg still to be broadcast, and a measured follow-up reserve), held ${formatShortfall(eligibility.current)},`
          + ` short ${formatShortfall(eligibility.missing)}.`,
        "Nothing was signed or broadcast. Top up the native balance and request a fresh uniswap__swap_quote.",
        false,
      );
    case "balance_unavailable":
      return new UniswapPreSignDebitRefusal(
        ErrorCodes.RPC_ERROR,
        `Refusing to sign: this swap's cost could not be verified before signing (${eligibility.cause}).`,
        "Nothing was signed or broadcast. This is a fail-closed refusal; retry once the chain endpoint answers.",
        true,
      );
    default:
      return null;
  }
}

// ── The pre-sign gate ───────────────────────────────────────────────────

/**
 * A pre-sign spendability refusal.
 *
 * Its own class so the staged loop can tell it apart from a router revert:
 * nothing was estimated wrong and nothing reverted - the wallet cannot pay for
 * what is still to come, or the cost could not be verified at all. Classifying
 * it as a revert would replace the only sentence that says what was actually
 * wrong (the same reason `UniswapFinalRequestRefusal` exists).
 */
export class UniswapPreSignDebitRefusal extends VexError {
  /**
   * Whether repeating the call unchanged could plausibly succeed.
   *
   * FALSE for a shortfall: the same call against the same wallet refuses again,
   * and telling an agent to retry a trade it cannot afford is how a loop starts.
   * TRUE for an unreadable balance or an unpriceable leg, where nothing about
   * the wallet is known to be wrong and the chain endpoint is what failed.
   */
  override readonly retryable: boolean;

  constructor(code: string, message: string, hint: string, retryable: boolean) {
    super(code, message, hint);
    this.name = "UniswapPreSignDebitRefusal";
    this.retryable = retryable;
  }
}

/**
 * The AUTHORITATIVE debit gate, one closure per leg.
 *
 * Contract C2.6: the quote-time observation is for the agent's reasoning, and
 * THIS is the authority. It runs inside the pre-sign window, where the
 * transaction about to be signed is already fixed, and it reads the chain -
 * which that window explicitly permits (`staged-broadcast.ts`'s `onBeforeSign`;
 * MetaMask re-reads the live balance at submit for the same reason,
 * `strategy/server/server-submit.ts:518-565`). What may not happen is a read
 * AFTER it resolves, and the Uniswap signer closes that window by signing
 * offline.
 *
 * AT LEG N IT COVERS N PLUS EVERYTHING STILL AUTHORIZED. This leg's gas and
 * prices come from the REQUEST (exact, and the bytes' own), every later leg is
 * re-estimated fresh, every earlier leg is dropped because its money is already
 * spent, and the measured follow-up reserve is added once. A wallet that can
 * pay for leg one and not for leg three must find that out before leg one is
 * signed, not after the allowance is granted and the position half-entered.
 */
export function createUniswapPreSignDebitGate(input: {
  readonly client: UniswapSpendabilityClient;
  readonly chainId: number;
  readonly wallet: Address;
  readonly tokenIn: UniswapToken;
  /** The whole plan, in broadcast order, from {@link planUniswapDebitLegs}. */
  readonly legs: readonly Omit<UniswapPlannedLeg, "gas" | "broadcast">[];
  readonly feeCap: LegFeeCap;
  /** The FULL requested input amount - swap leg plus fee leg. */
  readonly principalRaw: bigint;
  /** What the fee leg takes from the source asset, or `0n` when none applies. */
  readonly feeRaw: bigint;
  /** The venue's own QuoterV2 figure, used only when a live estimate cannot run. */
  readonly quotedSwapGas?: bigint | undefined;
  /** Injectable for tests; production reads Vex's own durable broadcast record. */
  readonly readInFlightBroadcast?: InFlightBroadcastReader | undefined;
}): (role: NativeDebitLegRole) => (request: PreSignRequestFacts) => Promise<void> {
  return (role) => async (request) => {
    const index = input.legs.findIndex((leg) => leg.role === role);
    if (index < 0) {
      // A leg nobody planned is a leg nobody priced, and this gate is the last
      // place that can say so before it is signed.
      throw new UniswapPreSignDebitRefusal(
        ErrorCodes.SWAP_FAILED,
        `Refusing to sign: this execution's native-debit plan has no ${role} leg (${UNISWAP_SPENDABILITY_CAUSES.legNotInPlan}).`,
        "Nothing was signed or broadcast. Request a fresh uniswap__swap_quote.",
        false,
      );
    }
    // THE PRICE THE BYTES CARRY, held against the ceiling the debit total was
    // computed under. On the swap legs the signer already forced the cap into
    // preparation and refused above it; the fee leg has no units ceiling to
    // carry a `StagedFeeBounds` on, so this is where its price is bounded. Every
    // leg is then PRICED at the approved cap, which is at or above what the
    // request carries - a guard that rounds toward charging the wallet more is
    // the safe direction for a guard.
    assertLegPriceWithinCap(request, input.feeCap);

    const broadcastRoles = new Set(input.legs.slice(0, index).map((leg) => leg.role));
    const legs = await estimateUniswapPlanGas({
      client: input.client,
      wallet: input.wallet,
      legs: input.legs,
      ...(input.quotedSwapGas === undefined ? {} : { quotedSwapGas: input.quotedSwapGas }),
      broadcastRoles,
      // THIS leg's gas is not estimated again: the request carries the exact
      // figure the bytes will commit to, and a second estimate would price
      // something the chain will not be asked to run.
      fixedGas: new Map([[role, request.gas]]),
    });

    // EVERY REMAINING LEG CARRIES A FIGURE OR THIS REFUSES. `priceUniswapNativeDebit`
    // owns that rule now: a leg with neither a measurement nor a conservative
    // estimate makes the debit unstatable, which becomes `balance_unavailable`
    // below and refuses the signature. There is no window in which a prior leg
    // may be signed against a total that left a later leg out - which is exactly
    // what the ratified LOWER BOUND used to permit at an allowance leg.
    const debit = await priceUniswapNativeDebit({
      client: input.client,
      chainId: input.chainId,
      wallet: input.wallet,
      legs,
      feeCap: input.feeCap,
      nonce: request.nonce,
    });

    const observation = await observeUniswapSwapSpendability({
      client: input.client,
      chainId: input.chainId,
      wallet: input.wallet,
      tokenIn: input.tokenIn,
      // Once the swap is broadcast the source asset owes only the fee; until
      // then it owes the WHOLE requested amount, because the router input and
      // the fee both come out of it.
      sourceRequiredRaw: role === "swap_fee" ? input.feeRaw : input.principalRaw,
      debit,
      ...(input.readInFlightBroadcast === undefined
        ? {}
        : { readInFlightBroadcast: input.readInFlightBroadcast }),
    });
    const judged = judgeUniswapSpendability(observation, PRE_SIGN_ROUTE_EXECUTABLE);
    const refusal = preSignSpendabilityRefusal(judged.eligibility);
    if (refusal !== null) throw refusal;
  };
}

/** What a pre-sign gate reads off the request that is about to be serialized. */
export interface PreSignRequestFacts {
  readonly gas: bigint;
  readonly nonce: number;
  readonly gasPrice?: bigint | undefined;
  readonly maxFeePerGas?: bigint | undefined;
  readonly maxPriorityFeePerGas?: bigint | undefined;
}

/**
 * Refuse a request whose per-gas price is above the approved ceiling.
 *
 * An ABSENT price is refused too: a request whose cost this build cannot state
 * is not a cheap one, and a cost nobody can state cannot be inside a ceiling.
 * A pricing-MODE mismatch is a refusal as well - `checkFeeCap` owns that rule,
 * because a cap approved as EIP-1559 says nothing about what a legacy gas price
 * may be.
 */
function assertLegPriceWithinCap(request: PreSignRequestFacts, cap: LegFeeCap): void {
  if (request.maxFeePerGas === undefined && request.gasPrice === undefined) {
    throw new UniswapPreSignDebitRefusal(
      ErrorCodes.SWAP_FAILED,
      "Refusing to sign: the prepared transaction states no fee price, so its cost cannot be checked against the ceiling this swap's debit was computed under.",
      "Nothing was signed or broadcast. Request a fresh uniswap__swap_quote.",
      false,
    );
  }
  const current: LegFeeCap = request.maxFeePerGas !== undefined
    ? {
        mode: "eip1559",
        maxFeePerGasWei: request.maxFeePerGas,
        maxPriorityFeePerGasWei: request.maxPriorityFeePerGas ?? 0n,
      }
    : { mode: "legacy", gasPriceWei: request.gasPrice ?? 0n };
  const verdict = checkFeeCap({ gasLimit: 0n, cap: current }, { gasLimit: 0n, cap });
  if (!verdict.withinCap) {
    throw new UniswapPreSignDebitRefusal(
      ErrorCodes.SWAP_FAILED,
      `Refusing to sign: this leg's ${verdict.field} is now ${verdict.requiredRaw}, above the ${verdict.approvedRaw} this swap's native-debit total was computed under.`,
      "Nothing was signed or broadcast. Request a fresh uniswap__swap_quote and execute against that.",
      false,
    );
  }
}

/**
 * The route verdict the pre-sign gate hands the evaluator.
 *
 * The route was judged at quote time and re-bound by the snapshot claim, the
 * drift check and the final-request guard; this gate answers the WALLET half
 * only, so it states the route half as already settled and lets the evaluator
 * decide nothing else.
 */
const PRE_SIGN_ROUTE_EXECUTABLE = {
  kind: "executable",
  priceImpactFraction: 0,
  adverse: false,
} as const satisfies QuoteEligibility;
