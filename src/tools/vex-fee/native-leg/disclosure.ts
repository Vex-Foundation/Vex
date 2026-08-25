/**
 * The agent-facing disclosure of a native Vex fee leg - ONE shape for every
 * venue that uses this lane.
 *
 * Field names mirror `bridge-fee/fee-disclosure.ts` deliberately: the agent
 * already reads that shape on every bridge, and a venue that renamed the same
 * facts would make the model relearn them.
 *
 * Two things any such disclosure must be honest about, which is why it carries
 * more than a number:
 *
 *   `basis`  - WHICH leg the fee came out of. On a Trench SELL that is the ETH
 *              the user RECEIVES rather than the token they sent, a deviation
 *              from `currency_in` that would mislead if merely implied.
 *   `note`   - that the fee leg runs AFTER the action confirms, as a separate
 *              transaction. An action that does not happen is never charged, and
 *              a fee that fails leaves the action untouched.
 *
 * The fee is disclosure, NOT an approval gate (owner decision, as on bridges).
 * It is exactly computable before any quote exists, so it can be stated
 * truthfully on every surface. USD figures are always labelled ESTIMATES and
 * degrade to `null` rather than to a fabricated figure.
 *
 * ## DEPRECATION, with its removal condition (rule 03)
 *
 * `feeAmountEth` is DEPRECATED in favour of `feeAmountHuman` + `nativeSymbol` +
 * `nativeDecimals`. Its name asserts ETH, and it was rendered with
 * `formatEther`, so it was only ever correct on an 18-decimal ETH venue - which
 * every venue on this lane happened to be until the generic signing lane joined
 * it and brought arbitrary EVM natives with it. The replacement renders through
 * the venue's OWN decimals and names the asset.
 *
 * It is RETAINED, not renamed, because this shape is MODEL-VISIBLE tool output:
 * the Trench quote surface reads it and external agents consume it with no
 * in-repo import to find. So the transition is additive - the field is emitted
 * ONLY where it was ever true (an ETH venue with 18 decimals) and omitted
 * everywhere else, rather than emitted with a wrong or misnamed number.
 *
 * REMOVAL CONDITION: `feeAmountEth` is removed only in a separately reviewed
 * output-contract change, once no consumer reads it - not as a side effect of
 * adding a venue.
 */

import { formatUnits } from "viem";

import type { NativeFeeVenue } from "./venue.js";

interface NativeFeeAmounts {
  /**
   * The native-leg amount the fee was computed from, in wei - or `null` when Vex
   * could not prove one.
   *
   * `null` is load-bearing on a sell whose proceeds failed to decode: the only
   * figure available there is the QUOTE, and publishing it as the fee's base
   * would put an estimate into the record of a settled trade. Rule 90: a decoder
   * that cannot prove what happened declines instead of guessing.
   */
  readonly baseAmountWei: string | null;
  readonly note: string;
}

export type NativeFeeDisclosure<Basis extends string = string> =
  | (NativeFeeAmounts & {
      readonly charged: true;
      readonly bps: number;
      /** Which native leg the fee is taken on - the honest name for any deviation. */
      readonly basis: Basis;
      readonly chargedOn: string;
      /** Smallest units, exact - debited from the wallet and sent to the treasury. */
      readonly feeAmountWei: string;
      /** Exact decimal rendering of `feeAmountWei` in the venue's OWN native units. */
      readonly feeAmountHuman: string;
      /** Display symbol of the native asset `feeAmountHuman` is denominated in. */
      readonly nativeSymbol: string;
      /** Decimals `feeAmountWei` was rendered with. Stated rather than assumed. */
      readonly nativeDecimals: number;
      /**
       * DEPRECATED - use `feeAmountHuman` with `nativeSymbol`. Emitted ONLY on a
       * venue whose native is ETH with 18 decimals, and ABSENT everywhere else:
       * the name asserts ETH, so on any other native it could only be a lie.
       * See the module header for the removal condition.
       */
      readonly feeAmountEth?: string;
      /**
       * What the venue is quoted for after the fee, where the fee reduces the
       * principal. `null` wherever it does not - on a sell the fee comes out of
       * the proceeds, and on a launch it is a separate transaction that does not
       * reduce `msg.value`.
       */
      readonly netAmountWei: string | null;
      /** Nullable ESTIMATE. */
      readonly feeUsdEstimate: string | null;
      readonly receiver: string;
    })
  | (NativeFeeAmounts & {
      readonly charged: false;
      readonly bps: 0;
      readonly basis: Basis;
      /** Plain-language reason no fee was taken. */
      readonly reason: string;
    });

export interface BuildNativeFeeDisclosureInput<Basis extends string> {
  readonly basis: Basis;
  readonly baseWei: bigint;
  readonly feeWei: bigint;
  /** Supplied only where the fee reduces the principal - see `netAmountWei`. */
  readonly netWei?: bigint | undefined;
  readonly feeUsdEstimate?: string | undefined;
  /**
   * Whether `netWei` is meaningful for THIS basis. A per-venue predicate rather
   * than a hard-coded basis name, because only the venue knows which of its
   * bases the fee is deducted from.
   */
  readonly netApplies: boolean;
}

export function buildNativeFeeDisclosure<Basis extends string>(
  venue: NativeFeeVenue<Basis>,
  input: BuildNativeFeeDisclosureInput<Basis>,
): NativeFeeDisclosure<Basis> {
  return {
    charged: true,
    bps: venue.bps,
    basis: input.basis,
    chargedOn: venue.basisText[input.basis],
    feeAmountWei: input.feeWei.toString(),
    feeAmountHuman: formatUnits(input.feeWei, venue.nativeDecimals),
    nativeSymbol: venue.nativeLabel,
    nativeDecimals: venue.nativeDecimals,
    // OMITTED, not set to null: an absent field cannot be read as a figure. The
    // predicate is exactly the condition under which the old name was true.
    ...(venue.nativeLabel === "ETH" && venue.nativeDecimals === 18
      ? { feeAmountEth: formatUnits(input.feeWei, 18) }
      : {}),
    netAmountWei: input.netApplies && input.netWei !== undefined ? input.netWei.toString() : null,
    feeUsdEstimate: input.feeUsdEstimate ?? null,
    receiver: venue.receiver,
    baseAmountWei: input.baseWei.toString(),
    note: venue.notes.ordering,
  };
}

/**
 * No fee was taken. Either the rate floored to zero, or - with `baseWei` omitted
 * - Vex could not prove a base at all and therefore took nothing rather than
 * charging a percentage of an estimate.
 */
export function buildNativeFeeSkippedDisclosure<Basis extends string>(
  venue: NativeFeeVenue<Basis>,
  input: {
    readonly basis: Basis;
    readonly baseWei?: bigint | undefined;
    readonly reason: string;
  },
): NativeFeeDisclosure<Basis> {
  return {
    charged: false,
    bps: 0,
    basis: input.basis,
    reason: input.reason,
    baseAmountWei: input.baseWei === undefined ? null : input.baseWei.toString(),
    note: input.baseWei === undefined ? venue.notes.unprovenBase : venue.notes.skipped,
  };
}
