/**
 * WHAT A UNISWAP SWAP COSTS THE WALLET IN NATIVE: the leg plan, the per-gas
 * ceiling, and the whole debit those two produce.
 *
 * ONE OWNER for the arithmetic both windows depend on. The quote handler calls
 * it to disclose and every leg's pre-sign gate calls it to refuse
 * (`./quote-spendability.ts`), so the number a person approves and the number a
 * signature is refused on cannot drift apart by construction. What differs is
 * only WHEN it runs and what is already known.
 *
 * ## The leg set, and why the fee leg is in it from the start
 *
 *   optional allowance_reset -> optional allowance -> required swap
 *   -> optional swap_fee (LAST, and only after the swap confirms)
 *   -> the measured follow-up reserve.
 *
 * The Vex fee is a SEPARATE transfer this venue signs after the swap
 * (`fee/run.ts`), so its gas and - for a native input - its value are money the
 * wallet must still have when the swap is done. Leaving it out of the initial
 * plan is how a wallet funds the swap, watches it confirm, and then cannot pay
 * the fee leg it was told about (contract C2.5).
 *
 * ## What "unpriced" means, and why it is not a silent gap
 *
 * A leg's gas comes from a FRESH `eth_estimateGas` of that leg's own calldata
 * (the policy `evm-chains/gas-limit-headroom.ts` states: never a cached or
 * hardcoded limit), or from the venue's own QuoterV2 figure for the swap - and
 * a V2 route carries none at all, measured live 2026-08-31. A swap through an
 * ERC-20 the router may not yet move CANNOT be estimated before its allowance
 * leg lands - the estimate reverts inside `transferFrom` - so at the earlier
 * windows that leg's gas is genuinely unknown.
 *
 * Such a leg is carried as UNPRICED rather than as zero: the total becomes an
 * explicit LOWER BOUND, a shortfall against it still refuses (a wallet that
 * cannot cover even the priceable legs cannot cover them all), and coverage
 * against it is disclosed as provisional, never as proof. The window that
 * actually matters admits none of it: at the swap leg's own pre-sign gate the
 * swap gas is exact, the fee leg is a plain transfer that estimates, and the
 * reserve is priced - so the money moment is fully priced or it refuses.
 */

import { type Address, type Hex } from "viem";

import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import type { BalanceBlockTag, NativeReadClient } from "@tools/evm-chains/erc20-reads.js";
import {
  computeSwapNativeDebit,
  estimateLegL1DataFee,
  priceFollowUpReserve,
  type LegFeeCap,
  type NativeDebitLeg,
  type NativeDebitLegCost,
  type NativeDebitLegRole,
} from "@tools/evm-chains/swap-native-debit.js";
import { buildApproveTx, buildSwapTx } from "@tools/uniswap/execute.js";
import { buildEvmVexFeeTransfer } from "@tools/bridge-fee/evm-fee-transfer.js";
import type { UniswapDeployment } from "@tools/uniswap/deployments.js";
// The fee receiver is a product constant owned by `@tools/uniswap/fee`, taken
// from the same module the fee leg itself is built from, so the planner and the
// executor cannot disagree about where the fee goes.
import { UNISWAP_FEE_RECEIVER_EVM as FEE_RECEIVER, type UniswapFeeCharge } from "@tools/uniswap/fee/index.js";
import type { UniswapToken } from "@tools/uniswap/types.js";

import type { QuotedRoute } from "./route-quote.js";

/** The deadline a quote-time swap leg is priced with: it only changes the bytes. */
const PLANNING_DEADLINE_SECONDS = 600;

/**
 * The bounded cause classes this lane may attach to `balance_unavailable`.
 *
 * Structural classes only, never provider text: the caller's decision is the
 * same whatever the node said, and an RPC message is uncontrolled payload
 * (rule 04 error layers).
 */
export const UNISWAP_SPENDABILITY_CAUSES = {
  /** The native debit itself could not be stated, so the requirement is unknown. */
  debitUnpriceable: "uniswap_native_debit_unpriceable",
  /** The follow-up reserve could not be priced live. */
  reserveUnpriceable: "uniswap_follow_up_reserve_unpriceable",
  /** A leg's gas could not be measured in a window that requires every leg priced. */
  legGasUnpriceable: "uniswap_leg_gas_unpriceable",
  /** The leg about to be signed is not one this execution planned and priced. */
  legNotInPlan: "uniswap_leg_not_in_debit_plan",
} as const;

/**
 * The client capabilities this lane needs, stated NARROWLY for the reason
 * `erc20-reads.ts` gives: viem's generics admit no concrete implementation, so
 * a seam typed with them can only be crossed by a cast, and a cast on a money
 * path is the hole rule 04 says not to open. A real viem public client
 * satisfies this, and so does a plain fake.
 */
export interface UniswapSpendabilityClient extends NativeReadClient {
  /**
   * ONE contract-read signature covering every question this lane asks: the
   * ERC-20 balance and the OP-stack L1-fee oracle. The two shared seams
   * (`Erc20ReadClient`, `L1FeeOracleClient`) each narrow `functionName` to their
   * own method, so a client cannot extend both; this union is the same shape a
   * viem client already has, and a real client satisfies all three at once.
   */
  readContract(parameters: {
    readonly address: Address;
    readonly abi: readonly unknown[];
    readonly functionName: "balanceOf" | "decimals" | "symbol" | "getL1Fee";
    readonly args?: readonly unknown[];
    readonly blockTag?: BalanceBlockTag;
    readonly requestOptions?: { readonly signal: AbortSignal };
  }): Promise<unknown>;
  estimateGas(parameters: {
    readonly account: Address;
    readonly to: Address;
    readonly data?: Hex;
    readonly value: bigint;
  }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{
    readonly maxFeePerGas?: bigint | undefined;
    readonly maxPriorityFeePerGas?: bigint | undefined;
    readonly gasPrice?: bigint | undefined;
  }>;
  getGasPrice(): Promise<bigint>;
  getTransactionCount(parameters: {
    readonly address: Address;
    readonly blockTag?: "pending";
  }): Promise<number>;
}

/**
 * One leg of the plan as this venue builds it: the exact transaction, and the
 * gas the leg is authorized for when that can be measured yet.
 *
 * `gasLimit: null` is the UNPRICED case documented in the file header. It is a
 * distinct state from `0n`, which would silently price a real transaction as
 * free.
 */
export interface UniswapPlannedLeg {
  readonly role: NativeDebitLegRole;
  readonly to: Address;
  readonly data: Hex;
  readonly valueWei: bigint;
  readonly gasLimit: bigint | null;
  /** True once this leg's bytes are already in flight: its money is spent. */
  readonly broadcast: boolean;
}

/** The whole native cost of a plan, or the named reason it could not be stated. */
export type UniswapNativeDebit =
  | {
      readonly ok: true;
      readonly totalWei: bigint;
      /** The same total as an exact base-10 integer string, for `Shortfall.raw`. */
      readonly totalRaw: string;
      readonly legs: readonly NativeDebitLegCost[];
      readonly reserveWei: bigint;
      /**
       * Legs whose gas could not be measured yet and are therefore NOT in the
       * total. Non-empty means `totalWei` is a LOWER BOUND, and every consumer
       * says so out loud.
       */
      readonly unpricedRoles: readonly NativeDebitLegRole[];
    }
  | { readonly ok: false; readonly cause: string; readonly role: string };

/**
 * Build the exact transactions of a Uniswap swap plan, in broadcast order.
 *
 * ONE OWNER for what a swap actually costs: the quote calls it to disclose, the
 * execute calls it to gate, and both get the same legs from the same builders
 * the executor signs (`buildApproveTx` / `buildSwapTx` / the shared fee
 * transfer). A second list assembled by hand at either end is how the two ends
 * end up describing different trades.
 *
 * `currentAllowance` decides the allowance legs by exactly the rule
 * `planSwapEvents` applies, and the caller asserts the two agree.
 */
export function planUniswapDebitLegs(input: {
  readonly deployment: UniswapDeployment;
  readonly router: Address;
  readonly recipient: Address;
  readonly tokenIn: UniswapToken;
  readonly tokenOut: UniswapToken;
  readonly quoted: QuotedRoute;
  readonly charge: UniswapFeeCharge;
  readonly currentAllowance: bigint;
  readonly now?: () => number;
}): readonly Omit<UniswapPlannedLeg, "gasLimit" | "broadcast">[] {
  const { tokenIn, charge, quoted } = input;
  const swapAmount = charge.swapAmountRaw;
  const needsAllowance = !tokenIn.isNative && input.currentAllowance < swapAmount;
  const needsReset = needsAllowance && input.currentAllowance > 0n;

  const legs: Omit<UniswapPlannedLeg, "gasLimit" | "broadcast">[] = [];
  if (needsReset) {
    const reset = buildApproveTx(tokenIn.address as Address, input.router, 0n);
    legs.push({ role: "allowance_reset", to: reset.to, data: reset.data, valueWei: reset.value });
  }
  if (needsAllowance) {
    const approve = buildApproveTx(tokenIn.address as Address, input.router, swapAmount);
    legs.push({ role: "allowance", to: approve.to, data: approve.data, valueWei: approve.value });
  }

  const nowMs = (input.now ?? Date.now)();
  const swap = buildSwapTx({
    deployment: input.deployment,
    route: quoted.route,
    amountIn: swapAmount,
    minAmountOut: quoted.minAmountOut,
    recipient: input.recipient,
    deadline: BigInt(Math.floor(nowMs / 1000) + PLANNING_DEADLINE_SECONDS),
    tokenInIsNative: tokenIn.isNative,
    tokenOutIsNative: input.tokenOut.isNative,
  });
  legs.push({ role: "swap", to: swap.to, data: swap.data, valueWei: swap.value });

  if (charge.feeRaw !== null && charge.feeTokenAddress !== null) {
    const transfer = buildEvmVexFeeTransfer(charge.feeTokenAddress, charge.feeRaw, FEE_RECEIVER);
    legs.push({
      role: "swap_fee",
      to: transfer.to,
      data: transfer.kind === "native" ? "0x" : transfer.data,
      valueWei: transfer.value,
    });
  }
  return legs;
}

/**
 * Estimate one leg's gas against the live chain, with the repository's headroom
 * policy applied, or `null` when the chain cannot answer yet.
 *
 * A failed estimate is NOT an error here. The common reason is structural and
 * expected: a swap that spends an ERC-20 the router has no allowance for cannot
 * be simulated before the allowance leg lands.
 */
async function estimateLegGas(
  client: UniswapSpendabilityClient,
  wallet: Address,
  leg: Omit<UniswapPlannedLeg, "gasLimit" | "broadcast">,
): Promise<bigint | null> {
  try {
    const estimate = await client.estimateGas({
      account: wallet,
      to: leg.to,
      data: leg.data,
      value: leg.valueWei,
    });
    return gasLimitWithHeadroom(estimate);
  } catch {
    return null;
  }
}

/**
 * The per-gas ceiling every leg of one plan is priced and signed under.
 *
 * Read ONCE per plan, from the chain, so the debit total and the bytes commit
 * to the same number (Rabby binds the same price it priced with to the
 * transaction it sends, `SendToken/index.tsx:1188`). EIP-1559 is preferred when
 * the chain offers it, and `maxFeePerGas` alone is the ceiling - the priority
 * fee is paid OUT of it, never beside it.
 */
export async function resolveUniswapLegFeeCap(
  client: UniswapSpendabilityClient,
): Promise<LegFeeCap> {
  try {
    const fees = await client.estimateFeesPerGas();
    if (fees.maxFeePerGas !== undefined) {
      return {
        mode: "eip1559",
        maxFeePerGasWei: fees.maxFeePerGas,
        maxPriorityFeePerGasWei: fees.maxPriorityFeePerGas ?? 0n,
      };
    }
    if (fees.gasPrice !== undefined) return { mode: "legacy", gasPriceWei: fees.gasPrice };
  } catch {
    // Fall through to the legacy read: a chain that cannot answer the 1559
    // question can still state a gas price, and the alternative is refusing a
    // swap for a fee-market shape rather than for a money fact.
  }
  return { mode: "legacy", gasPriceWei: await client.getGasPrice() };
}

/**
 * Price the whole plan: every leg still to be broadcast, plus the measured
 * follow-up reserve.
 *
 * Sequential on purpose - the reads are about one wallet on one node, and the
 * politeness budget of a user's own RPC is not a place to fan out.
 */
export async function priceUniswapNativeDebit(input: {
  readonly client: UniswapSpendabilityClient;
  readonly chainId: number;
  readonly wallet: Address;
  readonly legs: readonly UniswapPlannedLeg[];
  readonly feeCap: LegFeeCap;
  /** The nonce the follow-up would carry; it changes the serialized length. */
  readonly nonce: number;
  readonly signal?: AbortSignal;
}): Promise<UniswapNativeDebit> {
  const priced: NativeDebitLeg[] = [];
  const unpricedRoles: NativeDebitLegRole[] = [];

  for (const leg of input.legs) {
    if (leg.broadcast) continue;
    if (leg.gasLimit === null) {
      unpricedRoles.push(leg.role);
      continue;
    }
    const l1 = await estimateLegL1DataFee(input.client, {
      chainId: input.chainId,
      transaction: {
        to: leg.to,
        data: leg.data,
        value: leg.valueWei,
        gas: leg.gasLimit,
        nonce: input.nonce,
      },
      feeCap: input.feeCap,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    priced.push({
      role: leg.role,
      valueWei: leg.valueWei,
      gasLimit: leg.gasLimit,
      feeCap: input.feeCap,
      l1,
      broadcast: false,
    });
  }

  const reserve = await priceFollowUpReserve(input.client, {
    chainId: input.chainId,
    wallet: input.wallet,
    feeCap: input.feeCap,
    nonce: input.nonce,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!reserve.ok) {
    return {
      ok: false,
      cause: reserve.cause === "follow_up_reserve_estimate_failed"
        ? UNISWAP_SPENDABILITY_CAUSES.reserveUnpriceable
        : reserve.cause,
      role: "follow_up_reserve",
    };
  }

  const total = computeSwapNativeDebit({ legs: priced, reserve: reserve.reserve });
  if (!total.ok) return { ok: false, cause: total.cause, role: total.role };
  return {
    ok: true,
    totalWei: total.totalWei,
    totalRaw: total.totalRaw,
    legs: total.legs,
    reserveWei: total.reserveWei,
    unpricedRoles,
  };
}

/** Price one leg's gas where it can be measured, else carry it unpriced. */
export async function estimateUniswapPlanGas(input: {
  readonly client: UniswapSpendabilityClient;
  readonly wallet: Address;
  readonly legs: readonly Omit<UniswapPlannedLeg, "gasLimit" | "broadcast">[];
  /**
   * The venue's OWN gas figure for the swap, when QuoterV2 stated one. Used
   * only when the live estimate could not run - it is a measurement by the
   * quoter over the same pools, not a constant.
   */
  readonly quotedSwapGas?: bigint | undefined;
  /** Roles whose bytes are already in flight. */
  readonly broadcastRoles?: ReadonlySet<NativeDebitLegRole>;
  /** Gas limits already fixed by a prepared request, per role. */
  readonly fixedGas?: ReadonlyMap<NativeDebitLegRole, bigint>;
}): Promise<readonly UniswapPlannedLeg[]> {
  const out: UniswapPlannedLeg[] = [];
  for (const leg of input.legs) {
    const broadcast = input.broadcastRoles?.has(leg.role) ?? false;
    if (broadcast) {
      out.push({ ...leg, gasLimit: null, broadcast: true });
      continue;
    }
    const fixed = input.fixedGas?.get(leg.role);
    if (fixed !== undefined) {
      out.push({ ...leg, gasLimit: fixed, broadcast: false });
      continue;
    }
    const estimated = await estimateLegGas(input.client, input.wallet, leg);
    const gasLimit = estimated
      ?? (leg.role === "swap" && input.quotedSwapGas !== undefined
        ? gasLimitWithHeadroom(input.quotedSwapGas)
        : null);
    out.push({ ...leg, gasLimit, broadcast: false });
  }
  return out;
}
