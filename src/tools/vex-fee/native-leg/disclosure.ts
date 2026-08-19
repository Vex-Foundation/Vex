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
 */

import { formatEther } from "viem";

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
      /** Exact decimal rendering of `feeAmountWei`. */
      readonly feeAmountEth: string;
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
    feeAmountEth: formatEther(input.feeWei),
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
