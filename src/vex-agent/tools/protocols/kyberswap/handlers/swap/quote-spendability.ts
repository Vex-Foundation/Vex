/**
 * KyberSwap SPENDABILITY - can the selected wallet actually pay for the swap
 * this route describes, and can it still pay at the instant the key is used.
 *
 * TWO GATES, ONE DERIVATION (contract C2.6). The quote-time evaluation is for
 * the agent's reasoning: it answers with the route whatever the verdict, and a
 * shortfall makes the quote authorize nothing. The pre-sign evaluation is the
 * AUTHORITY: it runs inside `signStageBroadcast`'s last gate, on the request
 * that is about to be serialized, with the prices that request actually carries.
 * Both are assembled here so the two can never state different arithmetic about
 * the same swap; the judging itself belongs to `quote-authority/spendability.ts`
 * (`evaluateSpendability`), which this module never reimplements.
 *
 * WHY THE QUOTE CALLS `/route/build`. The native debit of a swap is a property
 * of the TRANSACTION, not of the route summary: the attached `value`, the gas
 * the router needs and the bytes an L2 posts to its L1 all live on the built
 * call. MEASURED live 2026-08-31 on Base: `/route/build` accepts a sender that
 * has granted no allowance and answers with `gas`, `transactionValue` and the
 * full 3236-byte calldata, so the shape is obtainable at quote time without
 * touching a key. The built transaction is ADVISORY here and never replaces the
 * stored route snapshot - the execute builds its own from the digest-verified
 * summary, exactly as before.
 *
 * THE LEG SET IS BOUNDED and comes from the same allowance read the execute
 * performs: an optional `allowance_reset`, an optional `allowance`, the required
 * `swap`, plus the measured follow-up reserve. Vex's 25 bps integrator fee is
 * embedded in the router calldata (`chargeFeeBy: currency_in`, echoed in
 * `routeSummary.extraFee` and pinned by the calldata guard), so it is a
 * component of the source principal and NEVER a fourth transaction.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE: no `StagedFeeBounds` ceiling is imposed on
 * the venue path. `evm-chains/staged-broadcast.ts` states the reason itself -
 * "on a venue path that is tolerable because the user authorized a trade, not a
 * gas price; on the generic signing path the fee caps ARE part of what the user
 * approved". The solvency question is answered instead from the prices the
 * prepared request really carries (`FinalSignedRequest`), which is strictly
 * stronger than a ceiling: a cap can only refuse, while reading the real prices
 * proves what the wallet will be charged.
 */

import { getKyberAggregatorClient } from "@tools/kyberswap/aggregator/client.js";
import type { SwapRouteSummary } from "@tools/kyberswap/aggregator/types.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import { buildApproveCalldata } from "@tools/kyberswap/evm-utils.js";
import type { ResolvedKyberTokenMetadata } from "@tools/kyberswap/helpers.js";
import type { KyberChainSlug } from "@tools/kyberswap/types.js";
import { getEvmNativeCurrency } from "@tools/evm-chains/native-currency.js";
import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import {
  observeEvmSwapBalances,
  type SourceBalanceClient,
} from "@tools/evm-chains/source-balance-observation.js";
import type { L1FeeOracleClient } from "@tools/evm-chains/l1-data-fee.js";
import {
  checkFeeCap,
  computeSwapNativeDebit,
  estimateLegL1DataFee,
  type FollowUpReserve,
  type LegFeeCap,
  type NativeDebitLeg,
  type NativeDebitLegRole,
  type SwapNativeDebit,
} from "@tools/evm-chains/swap-native-debit.js";
import type { FinalSignedRequest } from "@tools/evm-chains/staged-broadcast.js";
import type { Address, Hex } from "viem";

import { ErrorCodes, VexError } from "../../../../../../errors.js";
import {
  buildBoundDebitPlan,
  planFeeCapForRole,
  type BoundDebitPlan,
} from "../../../quote-authority/debit-plan.js";
import type { QuoteEligibility } from "../../../quote-authority/eligibility.js";
import {
  evaluateSpendability,
  formatShortfall,
  type SpendabilityAssetCheck,
  type SpendabilityOutcome,
} from "../../../quote-authority/spendability.js";
import type { AssetRef } from "../../../quote-authority/spendability-contract.js";

/**
 * The chain capabilities this module needs. A real viem public client satisfies
 * it; so does a fake, which is the point (`erc20-reads.ts` states the reason
 * viem's own generics cannot be a seam).
 */
export type KyberSpendabilityClient = SourceBalanceClient & L1FeeOracleClient & {
  estimateGas(parameters: {
    readonly account: Address;
    readonly to: Address;
    readonly data?: Hex;
    readonly value: bigint;
  }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{
    readonly maxFeePerGas?: bigint | undefined;
    readonly maxPriorityFeePerGas?: bigint | undefined;
  }>;
  getGasPrice(): Promise<bigint>;
  getTransactionCount(parameters: {
    readonly address: Address;
    readonly blockTag?: "pending" | "latest";
  }): Promise<number>;
};

/**
 * One transaction of the bound leg set, as both gates see it.
 *
 * `gasUnits` is the AUTHORIZED limit - the fresh estimate with this repository's
 * headroom policy already applied - because that is the number the chain may
 * charge against, not the estimate. For a leg that is currently being signed,
 * the pre-sign gate replaces it with the request's own `gas`.
 */
export interface KyberDebitLeg {
  readonly role: NativeDebitLegRole;
  readonly to: Address;
  readonly data: Hex;
  readonly valueWei: bigint;
  readonly gasUnits: bigint;
}

/**
 * Everything the pre-sign gate needs that does NOT change between plan time and
 * signature: the leg set, the reserve's measured gas, and the source asset the
 * principal is paid from.
 *
 * Prices are absent on purpose. They are read off the request being signed, so
 * a plan built minutes earlier cannot price a transaction it did not see.
 */
export interface KyberDebitPlan {
  readonly chainId: number;
  readonly wallet: Address;
  readonly legs: readonly KyberDebitLeg[];
  /** Measured gas for the cheapest real follow-up transaction (a self-transfer). */
  readonly reserveGasUnits: bigint;
  /** The source asset's identity, scale and symbol - never guessed (C1.2). */
  readonly source: KyberSourceAsset;
  /** Exact atomic units of the source asset the swap debits. */
  readonly sourceRequiredRaw: string;
  /**
   * The per-gas ceilings the APPROVED quote bound, by role
   * (`quote-authority/debit-plan.ts`).
   *
   * This venue imposes no `StagedFeeBounds` on its own path - the reason is in
   * the file header - so the prepared request arrives carrying whatever price
   * the node suggested. That is still answered from the request's real prices;
   * what this adds is the CEILING half: a request priced above what the human
   * approved is refused rather than signed, which a solvency check alone cannot
   * catch (a rich wallet can afford a price nobody agreed to).
   */
  readonly approvedPlan: BoundDebitPlan;
}

export interface KyberSourceAsset {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  /**
   * The ERC-20 contract to read, or `undefined` for the native asset - which is
   * also how this shape says "native": one field, so there is no second flag
   * that can disagree with it.
   */
  readonly token: Address | undefined;
}

/** Structural refusal classes this module produces. Never provider text. */
const CAUSES = {
  walletUnresolved: "kyber_wallet_not_selected",
  buildUnavailable: "kyber_swap_transaction_shape_unavailable",
  feePriceUnavailable: "evm_fee_price_unavailable",
  allowanceUnreadable: "kyber_allowance_read_failed",
  legGasUnavailable: "evm_leg_gas_estimate_failed",
  nonceUnavailable: "evm_nonce_read_failed",
  requestUnpriced: "evm_signed_request_carries_no_fee_price",
  /** The leg about to be signed is not one this execution planned and priced. */
  legNotInPlan: "kyber_leg_not_in_debit_plan",
} as const;

function nativeAssetRef(chainId: number): AssetRef {
  return {
    chainId,
    address: NATIVE_TOKEN_ADDRESS,
    symbol: getEvmNativeCurrency(chainId)?.symbol ?? null,
  };
}

function unavailable(asset: AssetRef, cause: string): QuoteEligibility {
  return { kind: "balance_unavailable", asset, cause };
}

/**
 * The per-gas price basis, read from the chain.
 *
 * EIP-1559 first, because that is what `prepareTransactionRequest` will fill on
 * a 1559 chain and the debit must be computed from the same ceiling the request
 * will carry. A chain that offers neither shape is a chain whose fee cannot be
 * priced, and an unpriced fee refuses rather than defaulting to zero.
 */
async function readLegFeeCap(client: KyberSpendabilityClient): Promise<LegFeeCap | null> {
  try {
    const fees = await client.estimateFeesPerGas();
    if (fees.maxFeePerGas !== undefined) {
      return {
        mode: "eip1559",
        maxFeePerGasWei: fees.maxFeePerGas,
        maxPriorityFeePerGasWei: fees.maxPriorityFeePerGas ?? 0n,
      };
    }
  } catch {
    // Falls through to the legacy read: a chain without a 1559 fee history is
    // not a chain without a gas price.
  }
  try {
    return { mode: "legacy", gasPriceWei: await client.getGasPrice() };
  } catch {
    return null;
  }
}

/**
 * The price basis of a request that is ABOUT TO BE SIGNED.
 *
 * Taken from the request and nothing else: `gas` is a count, and a count times
 * a price the gate merely asked for is not what the wallet will be charged. On
 * the 1559 arm `maxFeePerGas` is used ALONE - the priority fee is paid out of
 * that ceiling, and adding the two is the double count `swap-native-debit.ts`
 * exists to prevent.
 */
function feeCapOfRequest(request: FinalSignedRequest): LegFeeCap | null {
  if (request.maxFeePerGas !== undefined) {
    return {
      mode: "eip1559",
      maxFeePerGasWei: request.maxFeePerGas,
      maxPriorityFeePerGasWei: request.maxPriorityFeePerGas ?? 0n,
    };
  }
  if (request.gasPrice !== undefined) {
    return { mode: "legacy", gasPriceWei: request.gasPrice };
  }
  return null;
}

/**
 * Price every still-unbroadcast leg plus the follow-up reserve at one basis.
 *
 * The L1 data component is priced over each leg's OWN bytes, with the nonce it
 * will carry, because the serialized length is what an OP-stack chain charges
 * for. On a chain whose mechanism is not the oracle this adds no round trip and
 * contributes zero additional wei - and says so - rather than being skipped.
 */
async function priceNativeDebit(
  client: KyberSpendabilityClient,
  input: {
    readonly chainId: number;
    readonly wallet: Address;
    readonly legs: readonly KyberDebitLeg[];
    readonly firstNonce: number;
    readonly reserveGasUnits: bigint;
    readonly feeCap: LegFeeCap;
  },
): Promise<SwapNativeDebit> {
  const legs: NativeDebitLeg[] = [];
  for (const [offset, leg] of input.legs.entries()) {
    const l1 = await estimateLegL1DataFee(client, {
      chainId: input.chainId,
      transaction: {
        to: leg.to,
        data: leg.data,
        value: leg.valueWei,
        gas: leg.gasUnits,
        nonce: input.firstNonce + offset,
      },
      feeCap: input.feeCap,
    });
    legs.push({
      role: leg.role,
      valueWei: leg.valueWei,
      gasLimit: leg.gasUnits,
      feeCap: input.feeCap,
      l1,
      broadcast: false,
    });
  }

  const reserveL1 = await estimateLegL1DataFee(client, {
    chainId: input.chainId,
    transaction: {
      to: input.wallet,
      value: 0n,
      gas: input.reserveGasUnits,
      nonce: input.firstNonce + input.legs.length,
    },
    feeCap: input.feeCap,
  });
  const reserve: FollowUpReserve = {
    gasLimit: input.reserveGasUnits,
    feeCap: input.feeCap,
    l1: reserveL1,
  };
  return computeSwapNativeDebit({ legs, reserve });
}

/**
 * The two balance legs of one EVM swap, read sequentially at `pending` and
 * judged by the single evaluator.
 *
 * When the source asset IS the native asset the same read serves both legs, and
 * the native requirement carries the principal as well - which is what makes an
 * ERC-20 swap and a native swap the same arithmetic with different inputs.
 */
async function judgeSpendability(
  client: KyberSpendabilityClient,
  input: {
    readonly routeEligibility: QuoteEligibility;
    readonly chainId: number;
    readonly wallet: Address;
    readonly source: KyberSourceAsset;
    readonly sourceRequiredRaw: string;
    readonly nativeRequiredRaw: string;
    /** Carried onto the approval card when the quote seals one. */
    readonly debitPlan?: BoundDebitPlan;
  },
): Promise<SpendabilityOutcome> {
  const native = getEvmNativeCurrency(input.chainId);
  const sourceRequest = {
    chainId: input.chainId,
    wallet: input.wallet,
    subject: input.source.token === undefined
      ? ({ kind: "native" } as const)
      : ({ kind: "erc20", token: input.source.token } as const),
    assetAddress: input.source.address,
    decimals: input.source.decimals,
    symbol: input.source.symbol,
    blockTag: "pending" as const,
  };
  const nativeRequest = {
    chainId: input.chainId,
    wallet: input.wallet,
    subject: { kind: "native" } as const,
    assetAddress: NATIVE_TOKEN_ADDRESS,
    decimals: native?.decimals ?? null,
    symbol: native?.symbol ?? null,
    blockTag: "pending" as const,
  };

  const reads = await observeEvmSwapBalances(client, {
    source: sourceRequest,
    native: nativeRequest,
  });

  const sourceCheck: SpendabilityAssetCheck = {
    read: reads.source,
    requiredRaw: input.sourceRequiredRaw,
    symbol: input.source.symbol,
  };
  const nativeCheck: SpendabilityAssetCheck = {
    read: reads.native,
    requiredRaw: input.nativeRequiredRaw,
    symbol: native?.symbol ?? null,
  };
  return evaluateSpendability({
    routeEligibility: input.routeEligibility,
    source: sourceCheck,
    native: nativeCheck,
    ...(input.debitPlan === undefined ? {} : { debitPlan: input.debitPlan }),
  });
}

// ── Quote time ──────────────────────────────────────────────────────

/**
 * The quote-time outcome, plus the executable artifact the snapshot binds.
 *
 * `debitPlan` is present only on the arm that produced a card - the same arm
 * that produced a `preview` - because a quote with no card authorized nothing
 * and must seal no snapshot.
 */
export type KyberQuoteSpendabilityOutcome = SpendabilityOutcome & {
  readonly debitPlan: BoundDebitPlan | undefined;
};

export interface KyberQuoteSpendabilityInput {
  /** The verdict the route classifier already reached. A non-executable one is returned unchanged. */
  readonly routeEligibility: QuoteEligibility;
  readonly client: KyberSpendabilityClient;
  readonly chainId: number;
  readonly slug: KyberChainSlug;
  /** The selected wallet, resolved ADDRESS-ONLY - the quote decrypts nothing. */
  readonly wallet: Address;
  readonly tokenIn: ResolvedKyberTokenMetadata;
  readonly amountIn: bigint;
  readonly routerAddress: Address;
  /** The route summary this quote is answering with. POSTed verbatim, never mutated. */
  readonly approvedSummary: SwapRouteSummary;
  readonly slippageBps: number;
  /**
   * Read the wallet's CURRENT allowance decision for this token and spender.
   *
   * Injected rather than performed here so the one owner of that policy
   * (`planKyberAllowance`, which decides that a non-zero allowance must be reset
   * to zero first) stays the owner, and so this module's client seam stays
   * narrow enough for a fake to satisfy without a cast. Never called for a
   * native input, which needs no allowance at all.
   */
  readonly readAllowancePlan: () => Promise<{
    readonly needsReset: boolean;
    readonly needsApprove: boolean;
  }>;
}

/**
 * Evaluate whether the wallet can pay for the quoted swap.
 *
 * NEVER THROWS. Every failure to learn a number is a `balance_unavailable`
 * verdict naming its structural cause, because the quote must still answer with
 * the route it fetched (contract C2.1) and an unknown balance must never read as
 * an executable one (C2.3).
 */
export async function evaluateKyberQuoteSpendability(
  input: KyberQuoteSpendabilityInput,
): Promise<KyberQuoteSpendabilityOutcome> {
  const nativeRef = nativeAssetRef(input.chainId);
  const refuse = (cause: string): KyberQuoteSpendabilityOutcome =>
    ({ eligibility: unavailable(nativeRef, cause), preview: undefined, debitPlan: undefined });

  // The ACTUAL transaction shape. Advisory: it is used for value, gas units and
  // L1 bytes only, and the stored snapshot remains the route summary above.
  let built: { gas: string; transactionValue: string; data: string; routerAddress: Address };
  try {
    const response = await getKyberAggregatorClient().buildRoute(input.slug, {
      routeSummary: input.approvedSummary,
      sender: input.wallet,
      recipient: input.wallet,
      slippageTolerance: input.slippageBps,
    });
    built = response.data;
  } catch {
    return refuse(CAUSES.buildUnavailable);
  }

  let legs: readonly KyberDebitLeg[];
  try {
    legs = await planQuoteLegs(input, built);
  } catch (failure) {
    return refuse(failure instanceof LegPlanFailure ? failure.cause : CAUSES.legGasUnavailable);
  }

  const feeCap = await readLegFeeCap(input.client);
  if (feeCap === null) return refuse(CAUSES.feePriceUnavailable);

  let firstNonce: number;
  try {
    firstNonce = await input.client.getTransactionCount({
      address: input.wallet,
      blockTag: "pending",
    });
  } catch {
    return refuse(CAUSES.nonceUnavailable);
  }

  const reserveGasUnits = await measureReserveGas(input.client, input.wallet);
  if (reserveGasUnits === null) return refuse(CAUSES.legGasUnavailable);

  const debit = await priceNativeDebit(input.client, {
    chainId: input.chainId,
    wallet: input.wallet,
    legs,
    firstNonce,
    reserveGasUnits,
    feeCap,
  });
  if (!debit.ok) return refuse(debit.cause);

  // The plan the SNAPSHOT binds: the roles in broadcast order and the one
  // ceiling they were all costed at. Every leg here is PRICED - the approve legs
  // estimate live and the swap leg carries the provider's own build figure, and
  // a leg that could not be measured refused above - so none carries the
  // unpriced marker. Gas UNITS are deliberately absent: they drift 2.07x
  // block-to-block inside the quote window (measured on Base 2026-08-31), so
  // binding them would refuse fundable swaps.
  const debitPlan = buildBoundDebitPlan({
    legs: legs.map((leg) => ({ role: leg.role, unpriced: false })),
    feeCap,
  });
  const outcome = await judgeSpendability(input.client, {
    routeEligibility: input.routeEligibility,
    chainId: input.chainId,
    wallet: input.wallet,
    source: sourceAssetOf(input.tokenIn),
    sourceRequiredRaw: input.amountIn.toString(10),
    nativeRequiredRaw: debit.totalRaw,
    debitPlan,
  });
  return { ...outcome, debitPlan: outcome.preview === undefined ? undefined : debitPlan };
}

/** The source asset as this lane spells it. `decimals` is echoed, never repaired. */
export function sourceAssetOf(tokenIn: ResolvedKyberTokenMetadata): KyberSourceAsset {
  return {
    address: tokenIn.address,
    symbol: tokenIn.symbol,
    decimals: tokenIn.decimals,
    token: tokenIn.isNative ? undefined : tokenIn.address,
  };
}

/** A leg whose gas could not be measured. Carries the structural cause, not the node's text. */
class LegPlanFailure extends Error {
  override readonly cause: string;

  constructor(cause: string) {
    super(cause);
    this.name = "LegPlanFailure";
    this.cause = cause;
  }
}

/**
 * The quote-time leg set.
 *
 * The allowance legs are estimated LIVE, because an approve is estimable
 * whatever the current allowance is. The swap leg is NOT: with no allowance
 * granted, `eth_estimateGas` on the router call reverts, so the provider's own
 * `gas` from the build is the only figure available at quote time. It is a
 * provider estimate and is treated as one - the same headroom policy is applied
 * so the previewed debit is denominated in the units the execute would
 * authorize, and the pre-sign gate later replaces it with the request's own.
 */
async function planQuoteLegs(
  input: KyberQuoteSpendabilityInput,
  built: { gas: string; transactionValue: string; data: string; routerAddress: Address },
): Promise<readonly KyberDebitLeg[]> {
  const legs: KyberDebitLeg[] = [];

  if (!input.tokenIn.isNative) {
    let plan: { readonly needsReset: boolean; readonly needsApprove: boolean };
    try {
      plan = await input.readAllowancePlan();
    } catch {
      throw new LegPlanFailure(CAUSES.allowanceUnreadable);
    }
    if (plan.needsReset) {
      legs.push(await approveLeg(input, "allowance_reset", 0n));
    }
    if (plan.needsApprove) {
      legs.push(await approveLeg(input, "allowance", input.amountIn));
    }
  }

  legs.push({
    role: "swap",
    to: built.routerAddress,
    data: built.data as Hex,
    valueWei: BigInt(built.transactionValue),
    gasUnits: gasLimitWithHeadroom(BigInt(built.gas)),
  });
  return legs;
}

async function approveLeg(
  input: KyberQuoteSpendabilityInput,
  role: "allowance_reset" | "allowance",
  amount: bigint,
): Promise<KyberDebitLeg> {
  const data = buildApproveCalldata(input.routerAddress, amount);
  let estimate: bigint;
  try {
    estimate = await input.client.estimateGas({
      account: input.wallet,
      to: input.tokenIn.address,
      data,
      value: 0n,
    });
  } catch {
    throw new LegPlanFailure(CAUSES.legGasUnavailable);
  }
  return {
    role,
    to: input.tokenIn.address,
    data,
    valueWei: 0n,
    gasUnits: gasLimitWithHeadroom(estimate),
  };
}

/**
 * The follow-up reserve's gas, measured rather than assumed.
 *
 * A zero-value self-transfer is the cheapest real transaction on any EVM chain,
 * and it is ESTIMATED because chains disagree about what it costs: Arbitrum's
 * own empty-transfer estimate measured 21737 gas on 2026-08-31, 737 above the
 * EVM intrinsic. A failed estimate is not permission to reserve nothing.
 */
async function measureReserveGas(
  client: KyberSpendabilityClient,
  wallet: Address,
): Promise<bigint | null> {
  try {
    return await client.estimateGas({ account: wallet, to: wallet, value: 0n });
  } catch {
    return null;
  }
}

/** The verdict for a quote whose wallet could not be resolved at all. Fails closed. */
export function walletUnresolvedSpendability(chainId: number): KyberQuoteSpendabilityOutcome {
  return {
    eligibility: unavailable(nativeAssetRef(chainId), CAUSES.walletUnresolved),
    preview: undefined,
    debitPlan: undefined,
  };
}

// ── Execute time: the plan the pre-sign gate is built on ────────────

/**
 * One planned transaction as the execute already describes it, before its gas
 * has been measured.
 */
export interface KyberPlannedLeg {
  readonly role: NativeDebitLegRole;
  readonly to: Address;
  readonly data: Hex;
  readonly valueWei: bigint;
}

/**
 * Measure the debit plan for an execute that is about to create its intent.
 *
 * THROWS on any read it cannot make. This runs in Phase A, where nothing has
 * been signed and every failure is a clean pre-broadcast refusal - so a gas
 * figure that cannot be measured stops the execute here rather than becoming a
 * hole in the pre-sign arithmetic later.
 *
 * The SWAP leg's units come from the provider's build, for the same reason the
 * quote's do: with an allowance still ungranted, `eth_estimateGas` on the router
 * call reverts. `signStageBroadcast` estimates that leg itself immediately
 * before signing it, and the pre-sign gate then uses the request's own figure -
 * this one only sizes the legs that are still ahead.
 */
export async function measureKyberDebitPlan(
  client: KyberSpendabilityClient,
  input: {
    readonly chainId: number;
    readonly wallet: Address;
    readonly legs: readonly KyberPlannedLeg[];
    /** The provider's own gas figure for the swap leg, from `/route/build`. */
    readonly swapGasEstimate: bigint;
    readonly source: KyberSourceAsset;
    readonly sourceRequiredRaw: string;
    /** The plan the claimed snapshot bound. Its ceilings gate every signature. */
    readonly approvedPlan: BoundDebitPlan;
  },
): Promise<KyberDebitPlan> {
  const legs: KyberDebitLeg[] = [];
  for (const leg of input.legs) {
    const gasUnits = leg.role === "swap"
      ? gasLimitWithHeadroom(input.swapGasEstimate)
      : gasLimitWithHeadroom(await estimateOrThrow(client, {
          account: input.wallet, to: leg.to, data: leg.data, value: leg.valueWei,
        }));
    legs.push({ ...leg, gasUnits });
  }

  const reserveGasUnits = await estimateOrThrow(client, {
    account: input.wallet, to: input.wallet, value: 0n,
  });
  return {
    chainId: input.chainId,
    wallet: input.wallet,
    legs,
    reserveGasUnits,
    source: input.source,
    sourceRequiredRaw: input.sourceRequiredRaw,
    approvedPlan: input.approvedPlan,
  };
}

/**
 * A gas estimate, or a refusal that names what could not be measured.
 *
 * There is no default: signing a plan whose cost is partly unknown is exactly
 * the "continue with a hole where the number should be" that the debit module
 * refuses at its own boundary.
 */
async function estimateOrThrow(
  client: KyberSpendabilityClient,
  call: { readonly account: Address; readonly to: Address; readonly data?: Hex; readonly value: bigint },
): Promise<bigint> {
  try {
    return await client.estimateGas(call);
  } catch {
    throw new VexError(
      ErrorCodes.RPC_ERROR,
      "Refused before signing: the gas cost of one of this swap's transactions could not be measured, so the total native debit is unknown.",
      "Nothing was signed. Retry once the chain endpoint answers.",
    );
  }
}

// ── Pre-sign, the authoritative gate ────────────────────────────────

export interface KyberPreSignSpendabilityInput {
  readonly client: KyberSpendabilityClient;
  readonly plan: KyberDebitPlan;
  /** Index of the leg whose signature this gate stands in front of. */
  readonly legIndex: number;
  /** The request that will be serialized - the only place its real prices exist. */
  readonly request: FinalSignedRequest;
}

/**
 * Refuse the signature when the wallet cannot pay for THIS leg plus every leg
 * still authorized after it plus the follow-up reserve.
 *
 * WHY THE WHOLE REMAINDER AND NOT ONE LEG. Checking a leg at a time is how a
 * wallet funds the approval, signs it, and then discovers it cannot pay for the
 * swap - allowance granted, position not entered. Legs already broadcast are
 * excluded because their money is already gone; charging for them again would
 * refuse a swap that can in fact be paid for.
 *
 * WHY IT RUNS IN THIS WINDOW. The quote-time preview states what was true when
 * the quote was taken and says so on the card. Only here is the transaction
 * fixed, the price known and the balance current (contract C2.6; MetaMask
 * re-reads the live balance at submit for the same reason,
 * `strategy/server/server-submit.ts:518-565`).
 *
 * THROWS on every non-executable outcome. `signStageBroadcast` issues nothing
 * between this hook and the signature, so a throw here means nothing was signed,
 * staged or broadcast.
 */
export async function assertKyberPreSignSpendability(
  input: KyberPreSignSpendabilityInput,
): Promise<void> {
  const { plan, request, legIndex } = input;
  const feeCap = feeCapOfRequest(request);
  if (feeCap === null) {
    throw refusal(unavailable(nativeAssetRef(plan.chainId), CAUSES.requestUnpriced));
  }

  // THE APPROVED CEILING, held against the price these bytes actually carry.
  // The leg's role comes from the plan, whose order this build proved identical
  // to the approved one before the intent was created, so the ceiling applied
  // here is the ceiling that leg was quoted under.
  const signing = plan.legs[legIndex];
  if (signing === undefined) {
    throw refusal(unavailable(nativeAssetRef(plan.chainId), CAUSES.legNotInPlan));
  }
  const approvedCap = planFeeCapForRole(plan.approvedPlan, signing.role);
  if (approvedCap === null) {
    throw refusal(unavailable(nativeAssetRef(plan.chainId), CAUSES.legNotInPlan));
  }
  // Gas UNITS are deliberately NOT compared - both sides pass `0n` - because a
  // units ceiling taken at quote time refuses fundable swaps (2.07x measured
  // block-to-block drift on Base, 2026-08-31). Only the PRICE is bound.
  const capVerdict = checkFeeCap(
    { gasLimit: 0n, cap: feeCap },
    { gasLimit: 0n, cap: approvedCap },
  );
  if (!capVerdict.withinCap) {
    throw new VexError(
      ErrorCodes.KYBER_MALFORMED_PARAMS,
      `Refused at signing: this ${signing.role} transaction's ${capVerdict.field} is ${capVerdict.requiredRaw},`
        + ` above the ${capVerdict.approvedRaw} the approved quote was priced at.`,
      "Nothing was signed. Request a fresh kyberswap__swap_quote at the current gas price.",
    );
  }

  // The leg being signed carries the request's OWN gas and value; the legs after
  // it keep the units the plan authorized. Legs before it are already in flight.
  const remaining: KyberDebitLeg[] = plan.legs.slice(legIndex).map((leg, offset) =>
    offset === 0
      ? { ...leg, gasUnits: request.gas, valueWei: request.value }
      : leg,
  );

  const debit = await priceNativeDebit(input.client, {
    chainId: plan.chainId,
    wallet: plan.wallet,
    legs: remaining,
    firstNonce: request.nonce,
    reserveGasUnits: plan.reserveGasUnits,
    feeCap,
  });
  if (!debit.ok) {
    throw refusal(unavailable(nativeAssetRef(plan.chainId), debit.cause));
  }

  // The route was already claimed as executable, and this gate asks only the
  // spendability question - so the route verdict handed to the evaluator is the
  // executable one it already holds. `evaluateSpendability` remains the single
  // judge of shortfall, unreadable balance and gas reserve (contract C2).
  const outcome = await judgeSpendability(input.client, {
    routeEligibility: PRE_SIGN_ROUTE_VERDICT,
    chainId: plan.chainId,
    wallet: plan.wallet,
    source: plan.source,
    sourceRequiredRaw: plan.sourceRequiredRaw,
    nativeRequiredRaw: debit.totalRaw,
  });
  if (outcome.eligibility.kind !== "executable") {
    throw refusal(outcome.eligibility);
  }
}

/**
 * The route verdict the pre-sign gate reasons from.
 *
 * It is not a re-classification of the route: the claim already proved this
 * quote was executable and the calldata guard proves the build still is. It
 * exists so the ONE evaluator can be reused instead of a second comparison being
 * written here, which is the duplication contract C2 forbids.
 */
const PRE_SIGN_ROUTE_VERDICT: QuoteEligibility = {
  kind: "executable",
  priceImpactFraction: 0,
  adverse: false,
};

/**
 * Turn a spendability verdict into the refusal the agent reads.
 *
 * Each of the three states keeps its own remedy: fund the wallet, top up gas, or
 * retry a read that failed. Collapsing them into one message is the failure
 * rule 04 and contract C2.3 name, and "reduce the amount" is wrong advice for an
 * RPC that timed out.
 */
function refusal(eligibility: QuoteEligibility): VexError {
  switch (eligibility.kind) {
    case "insufficient_balance":
      return new VexError(
        ErrorCodes.INSUFFICIENT_BALANCE,
        `Refused at signing: the wallet no longer holds enough of the input token - required ${formatShortfall(eligibility.required)}, held ${formatShortfall(eligibility.current)}.`,
        "Nothing was signed. Fund the wallet or trade a smaller size, then request a fresh kyberswap__swap_quote.",
      );
    case "gas_reserve_insufficient":
      return new VexError(
        ErrorCodes.INSUFFICIENT_BALANCE,
        `Refused at signing: the native balance cannot cover this swap's remaining transactions and a reserve - required ${formatShortfall(eligibility.required)}, held ${formatShortfall(eligibility.current)}.`,
        "Nothing was signed. Top up the native balance, then request a fresh kyberswap__swap_quote.",
      );
    case "balance_unavailable":
      return new VexError(
        ErrorCodes.RPC_ERROR,
        `Refused at signing: a balance this swap depends on could not be read (${eligibility.cause}), so it is unknown whether the wallet can pay for it.`,
        "Nothing was signed. Retry once the chain endpoint answers.",
      );
    default:
      return new VexError(
        ErrorCodes.RPC_ERROR,
        "Refused at signing: this swap's spendability could not be established.",
        "Nothing was signed. Request a fresh kyberswap__swap_quote.",
      );
  }
}
