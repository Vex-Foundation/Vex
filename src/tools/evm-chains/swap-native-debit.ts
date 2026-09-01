/**
 * THE WHOLE NATIVE DEBIT of an EVM swap: what every leg still to be broadcast
 * will take out of the wallet's gas asset, plus a measured reserve for the
 * move after it.
 *
 * WHY A SWAP'S NATIVE COST IS NOT `gasLimit * gasPrice`. A swap is a PLAN, not
 * a transaction: an allowance reset, an allowance, the swap itself, sometimes a
 * fee leg. Each leg pays its own gas, a rollup leg also pays to have its data
 * posted (`./l1-data-fee.ts`), and a native-input swap additionally sends
 * `value`. Checking one leg at a time is how a wallet funds leg one, signs it,
 * and then discovers it cannot pay for leg three - with the allowance already
 * granted and the position half-entered. Rabby computes the same total shape
 * before it will let a send through (`src/utils/transaction.ts:873-887`
 * composes gas cost plus the L1 fee; `:1017-1023` compares
 * `maxGasCost + sendNativeAmount` against the balance), and contract C2.5
 * binds Vex to it.
 *
 * WHY EVERY ERC-20 SWAP STILL HAS A NATIVE LEG. The source asset pays the
 * principal; the gas asset pays for the right to move it. A wallet with plenty
 * of USDC and no ETH can quote a swap it can never sign.
 *
 * THE RESERVE IS MEASURED, NEVER A PERCENTAGE (owner decision 2026-08-31). It
 * is a freshly priced zero-value self-transfer on this chain, including its L1
 * data fee where the chain has one: the cheapest real transaction that proves
 * the wallet can still act after the swap. A percentage of the trade would
 * scale with size and mean nothing at either end - the same reason rule 90
 * forbids a percentage money tolerance. Rabby reserves with a 1.1 multiplier
 * over the live estimate (`SendToken/index.tsx:2519-2526`); Vex prices the
 * follow-up transaction itself instead of multiplying.
 *
 * EIP-1559: `maxFeePerGas` ALREADY INCLUDES the priority component - it is the
 * ceiling per gas unit, not the base half of one. Adding the priority fee on
 * top double-counts it, and is the arithmetic mistake this module's tests pin.
 */

import { z } from "zod";

import type { Address, Hex } from "viem";

import {
  estimateL1DataFee,
  type L1DataFeeEstimate,
  type L1FeeOracleClient,
} from "./l1-data-fee.js";
import type { StagedFeeBounds } from "./staged-broadcast.js";

/**
 * The APPROVED price ceiling for one leg, in wei per gas unit.
 *
 * The same two pricing modes `StagedFeeBounds` carries, because this is where
 * that ceiling is DECIDED (at quote time) and that is where it is ENFORCED (on
 * the request about to be serialized). One shape, two ends of the same wire.
 */
export type LegFeeCap =
  | {
      readonly mode: "eip1559";
      readonly maxFeePerGasWei: bigint;
      readonly maxPriorityFeePerGasWei: bigint;
    }
  | { readonly mode: "legacy"; readonly gasPriceWei: bigint };

/**
 * The per-gas price a debit is computed from.
 *
 * For EIP-1559 that is `maxFeePerGas` and ONLY `maxFeePerGas`: the priority fee
 * is paid OUT OF it, never beside it. A wallet that adds the two produces a
 * total the chain will never charge, refuses swaps the user can afford, and
 * calls the refusal a safety property.
 */
export function boundGasPriceWei(cap: LegFeeCap): bigint {
  return cap.mode === "eip1559" ? cap.maxFeePerGasWei : cap.gasPriceWei;
}

/** Which leg of the plan a cost belongs to. Closed, so a total is auditable. */
export type NativeDebitLegRole =
  | "allowance_reset"
  | "allowance"
  | "swap"
  | "swap_fee";

/**
 * One leg of the plan, as the debit sees it.
 *
 * `broadcast` is the whole reason this is a plan and not a sum: a leg already
 * in flight has already taken its money, and charging the wallet for it again
 * at leg three would refuse a swap that can in fact be paid for. Only legs
 * STILL TO BE SENT are counted.
 */
export interface NativeDebitLeg {
  readonly role: NativeDebitLegRole;
  /** Native value the leg sends. `0n` for an allowance or an ERC-20 swap. */
  readonly valueWei: bigint;
  /** Gas UNITS authorized for this leg, headroom already applied. */
  readonly gasLimit: bigint;
  readonly feeCap: LegFeeCap;
  /** The chain's answer for THIS leg's bytes. `unavailable` refuses the total. */
  readonly l1: L1DataFeeEstimate;
  readonly broadcast: boolean;
}

/**
 * The follow-up reserve: a priced zero-value self-transfer, never a percentage.
 * Produced by {@link priceFollowUpReserve} against the live chain.
 */
export interface FollowUpReserve {
  readonly gasLimit: bigint;
  readonly feeCap: LegFeeCap;
  readonly l1: L1DataFeeEstimate;
}

/** What one counted leg costs, itemized so a card and an audit can show the work. */
export interface NativeDebitLegCost {
  readonly role: NativeDebitLegRole | "follow_up_reserve";
  readonly valueWei: bigint;
  readonly gasWei: bigint;
  readonly l1DataFeeWei: bigint;
  readonly totalWei: bigint;
}

/**
 * Why a total could not be stated.
 *
 * Every one of these is a REFUSAL, not a zero: a debit that silently drops a
 * component it could not price is a debit that under-charges the wallet at
 * exactly the moment the answer mattered.
 */
export type NativeDebitRefusalCause =
  | "l1_data_fee_capability_unknown"
  | "l1_data_fee_oracle_read_failed"
  | "negative_amount";

export type SwapNativeDebit =
  | {
      readonly ok: true;
      /** The exact total, in wei. */
      readonly totalWei: bigint;
      /** The same total as an exact base-10 integer string, for `Shortfall.raw`. */
      readonly totalRaw: string;
      readonly legs: readonly NativeDebitLegCost[];
      readonly reserveWei: bigint;
    }
  | {
      readonly ok: false;
      readonly cause: NativeDebitRefusalCause;
      /** Which leg could not be priced, so a refusal can name it. */
      readonly role: NativeDebitLegCost["role"];
    };

function l1WeiOrRefusal(
  l1: L1DataFeeEstimate,
): { readonly wei: bigint } | { readonly cause: NativeDebitRefusalCause } {
  return l1.kind === "priced" ? { wei: l1.additionalWei } : { cause: l1.cause };
}

/**
 * Total the native debit for one swap plan.
 *
 * PURE. Every chain read the total depends on has already happened, which is
 * what makes the arithmetic a deterministic function of stated evidence and
 * lets the double-counting tests exist at all.
 */
export function computeSwapNativeDebit(input: {
  readonly legs: readonly NativeDebitLeg[];
  readonly reserve: FollowUpReserve;
}): SwapNativeDebit {
  const costs: NativeDebitLegCost[] = [];

  for (const leg of input.legs) {
    if (leg.broadcast) continue;
    if (leg.valueWei < 0n || leg.gasLimit < 0n || boundGasPriceWei(leg.feeCap) < 0n) {
      return { ok: false, cause: "negative_amount", role: leg.role };
    }
    const l1 = l1WeiOrRefusal(leg.l1);
    if (!("wei" in l1)) return { ok: false, cause: l1.cause, role: leg.role };

    const gasWei = leg.gasLimit * boundGasPriceWei(leg.feeCap);
    costs.push({
      role: leg.role,
      valueWei: leg.valueWei,
      gasWei,
      l1DataFeeWei: l1.wei,
      totalWei: leg.valueWei + gasWei + l1.wei,
    });
  }

  if (input.reserve.gasLimit < 0n || boundGasPriceWei(input.reserve.feeCap) < 0n) {
    return { ok: false, cause: "negative_amount", role: "follow_up_reserve" };
  }
  const reserveL1 = l1WeiOrRefusal(input.reserve.l1);
  if (!("wei" in reserveL1)) {
    return { ok: false, cause: reserveL1.cause, role: "follow_up_reserve" };
  }
  const reserveGasWei = input.reserve.gasLimit * boundGasPriceWei(input.reserve.feeCap);
  const reserveWei = reserveGasWei + reserveL1.wei;
  costs.push({
    role: "follow_up_reserve",
    valueWei: 0n,
    gasWei: reserveGasWei,
    l1DataFeeWei: reserveL1.wei,
    totalWei: reserveWei,
  });

  const totalWei = costs.reduce((sum, cost) => sum + cost.totalWei, 0n);
  return { ok: true, totalWei, totalRaw: totalWei.toString(10), legs: costs, reserveWei };
}

// ── The follow-up reserve, priced live ──────────────────────────────

/**
 * The client capabilities pricing a reserve needs, narrowly stated (the reason
 * is in `erc20-reads.ts`: viem's generics admit no concrete implementation, so
 * a seam typed with them can only be crossed by a cast).
 */
export interface ReservePricingClient extends L1FeeOracleClient {
  estimateGas(parameters: {
    readonly account: Address;
    readonly to: Address;
    readonly value: bigint;
  }): Promise<bigint>;
}

export type FollowUpReservePricing =
  | { readonly ok: true; readonly reserve: FollowUpReserve }
  | {
      readonly ok: false;
      readonly cause: "follow_up_reserve_estimate_failed" | NativeDebitRefusalCause;
    };

/**
 * Price the follow-up reserve against the live chain.
 *
 * The transaction priced is the CHEAPEST REAL ONE: a zero-value transfer from
 * the wallet to itself. It is estimated rather than assumed 21000, because a
 * chain may charge more (Arbitrum's own empty-transfer estimate was measured at
 * 21737 gas on 2026-08-31, the extra units being its L1 posting cost), and the
 * point of the reserve is that it is measured.
 *
 * A failed estimate REFUSES. There is no default reserve: a swap that leaves
 * the wallet unable to move again is exactly the outcome the reserve exists to
 * prevent, so not knowing the number is not permission to use zero.
 */
export async function priceFollowUpReserve(
  client: ReservePricingClient,
  request: {
    readonly chainId: number;
    readonly wallet: Address;
    readonly feeCap: LegFeeCap;
    /** The nonce the follow-up would carry; it changes the serialized length. */
    readonly nonce: number;
    readonly signal?: AbortSignal;
  },
): Promise<FollowUpReservePricing> {
  let gasLimit: bigint;
  try {
    gasLimit = await client.estimateGas({
      account: request.wallet,
      to: request.wallet,
      value: 0n,
    });
  } catch {
    return { ok: false, cause: "follow_up_reserve_estimate_failed" };
  }

  const l1 = await estimateL1DataFee(client, {
    chainId: request.chainId,
    transaction: {
      to: request.wallet,
      gas: gasLimit,
      nonce: request.nonce,
      maxFeePerGasWei: boundGasPriceWei(request.feeCap),
      maxPriorityFeePerGasWei:
        request.feeCap.mode === "eip1559" ? request.feeCap.maxPriorityFeePerGasWei : 0n,
    },
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  if (l1.kind === "unavailable") return { ok: false, cause: l1.cause };

  return { ok: true, reserve: { gasLimit, feeCap: request.feeCap, l1 } };
}

// ── Quote-time fee caps, enforced against the approved ceiling ──────
//
// The persistence half that once lived here (PersistedLegFeeCap and its
// codec) was removed 2026-08-31: the binding that ships carries per-gas
// PRICE caps inside the route snapshot's bound debit plan
// (`quote-authority/debit-plan.ts`), which deliberately binds no gas-unit
// ceiling - router gas estimates moved 2.07x across 12 Base blocks, so a
// unit ceiling sealed at quote time refuses fundable swaps. `checkFeeCap`
// below is the enforcement seam both designs share.

/**
 * Does the chain's CURRENT requirement still fit inside the ceiling the quote
 * was approved under.
 *
 * A mismatch of MODE is a refusal too, and deliberately so: a cap approved as
 * EIP-1559 says nothing about what a legacy gas price may be, and treating one
 * as evidence about the other is how a ceiling gets bypassed by a chain that
 * changed pricing underneath the quote. The answer to every refusal is the same
 * and is stated in the field name: quote again.
 */
export type FeeCapCheck =
  | { readonly withinCap: true }
  | {
      readonly withinCap: false;
      readonly field: "gas limit" | "maxFeePerGas" | "maxPriorityFeePerGas" | "gasPrice" | "pricing mode";
      readonly requiredRaw: string;
      readonly approvedRaw: string;
    };

export function checkFeeCap(
  current: { readonly gasLimit: bigint; readonly cap: LegFeeCap },
  approved: { readonly gasLimit: bigint; readonly cap: LegFeeCap },
): FeeCapCheck {
  if (current.gasLimit > approved.gasLimit) {
    return {
      withinCap: false,
      field: "gas limit",
      requiredRaw: current.gasLimit.toString(10),
      approvedRaw: approved.gasLimit.toString(10),
    };
  }
  if (current.cap.mode !== approved.cap.mode) {
    return {
      withinCap: false,
      field: "pricing mode",
      requiredRaw: current.cap.mode,
      approvedRaw: approved.cap.mode,
    };
  }
  if (current.cap.mode === "eip1559" && approved.cap.mode === "eip1559") {
    if (current.cap.maxFeePerGasWei > approved.cap.maxFeePerGasWei) {
      return {
        withinCap: false,
        field: "maxFeePerGas",
        requiredRaw: current.cap.maxFeePerGasWei.toString(10),
        approvedRaw: approved.cap.maxFeePerGasWei.toString(10),
      };
    }
    if (current.cap.maxPriorityFeePerGasWei > approved.cap.maxPriorityFeePerGasWei) {
      return {
        withinCap: false,
        field: "maxPriorityFeePerGas",
        requiredRaw: current.cap.maxPriorityFeePerGasWei.toString(10),
        approvedRaw: approved.cap.maxPriorityFeePerGasWei.toString(10),
      };
    }
    return { withinCap: true };
  }
  if (current.cap.mode === "legacy" && approved.cap.mode === "legacy"
    && current.cap.gasPriceWei > approved.cap.gasPriceWei) {
    return {
      withinCap: false,
      field: "gasPrice",
      requiredRaw: current.cap.gasPriceWei.toString(10),
      approvedRaw: approved.cap.gasPriceWei.toString(10),
    };
  }
  return { withinCap: true };
}

/**
 * The bytes an L1 data fee is priced over for a leg whose calldata is known.
 * Exposed so a venue adapter prices the SAME transaction it will sign.
 */
export interface SwapLegTransaction {
  readonly to: Address;
  readonly data?: Hex;
  readonly value?: bigint;
  readonly gas: bigint;
  readonly nonce: number;
}

/** Price one leg's L1 data component under its own approved cap. */
export async function estimateLegL1DataFee(
  client: L1FeeOracleClient,
  request: {
    readonly chainId: number;
    readonly transaction: SwapLegTransaction;
    readonly feeCap: LegFeeCap;
    readonly signal?: AbortSignal;
  },
): Promise<L1DataFeeEstimate> {
  return await estimateL1DataFee(client, {
    chainId: request.chainId,
    transaction: {
      ...request.transaction,
      maxFeePerGasWei: boundGasPriceWei(request.feeCap),
      maxPriorityFeePerGasWei:
        request.feeCap.mode === "eip1559" ? request.feeCap.maxPriorityFeePerGasWei : 0n,
    },
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}
