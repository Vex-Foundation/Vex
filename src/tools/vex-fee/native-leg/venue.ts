/**
 * What makes one venue's native Vex-fee leg different from another's.
 *
 * WHY THIS EXISTS. Three venues had grown a near-identical fee lane -
 * `pools-fun/fee/`, `uniswap/fee/` and `bridge-fee/` - each with its own
 * copy of the same five decisions: a bps rate, a treasury target, a native
 * transfer builder, a disclosure shape, and an `agent_activity` role. The
 * arithmetic was already shared (`../bps-split.ts`, extracted when four copies
 * of `(amount * 25n) / 10_000n` were found); everything ABOVE the arithmetic was
 * not. pools.fun would have been the fourth copy.
 *
 * The copies are the risk, not the duplication: a disclosure that says "after
 * the trade confirms" while the caller charges first, or a venue whose skipped-
 * fee note is subtly wrong, is a money-path defect that no test of the other
 * venues would catch. One implementation, parameterised by this descriptor,
 * means a fix to the ordering note or the zero-fee rule reaches every venue.
 *
 * What stays PER-VENUE is exactly what genuinely differs: the rate, the recorded
 * role, the protocol and log names, and the words describing which leg the fee
 * came out of. Nothing here is derived from model or tool input - every field is
 * a product-owner constant supplied at the call site (see
 * `fee-params-never-from-model.test.ts`).
 */

import type { Address } from "viem";

/**
 * The plain-language sentences a venue's disclosure needs.
 *
 * Authored per venue rather than generated, because they are the text a user
 * reads about their own money: "the ETH you receive from this sell" and "the ETH
 * this launch sends" are different facts, and a generic sentence covering both
 * would state neither.
 */
export interface NativeFeeVenueNotes {
  /** Where and when the fee leg runs. Must state that a failed action is never charged. */
  readonly ordering: string;
  /** Why no fee was taken when the rate floored to zero. */
  readonly skipped: string;
  /** Why no fee was taken when the base itself could not be proven (rule 90). */
  readonly unprovenBase: string;
}

/**
 * One venue's fee configuration.
 *
 * `Basis` is the venue's own union of charge bases (`"buy_eth_in"`,
 * `"launch_msg_value"`, ...). Keeping it a type parameter rather than widening
 * to `string` is what stops a caller disclosing a basis the venue does not have.
 */
export interface NativeFeeVenue<Basis extends string = string> {
  /** Whole basis points. A product-owner constant, never model input. */
  readonly bps: number;
  /** The treasury address the native transfer targets. */
  readonly receiver: Address;
  /**
   * The `agent_activity.event_role` this leg is recorded under. Bound by the
   * database's `agent_activity_kind_role_binding` CHECK, so a new venue needs a
   * migration before it can use a new role.
   */
  readonly activityEventRole: string;
  /** The `agent_activity.protocol` value, e.g. `"pools_fun"`. */
  readonly protocol: string;
  /** The chain slug stamped on the fee row. */
  readonly chainSlug: string;
  /** Display symbol of the native asset, e.g. `"ETH"`. */
  readonly nativeLabel: string;
  /** Decimals of the native asset. 18 everywhere today, stated rather than assumed. */
  readonly nativeDecimals: number;
  /** Label prefix for this venue's fee log lines, e.g. `"pools.fee"`. */
  readonly logPrefix: string;
  /** The venue's name as it appears in agent-facing prose, e.g. `"pools.fun"`. */
  readonly displayName: string;
  /** How the fee amount is named when the split refuses a non-positive base. */
  readonly amountLabel: string;
  /** Plain-language name of each charge base, keyed by basis. */
  readonly basisText: Readonly<Record<Basis, string>>;
  readonly notes: NativeFeeVenueNotes;
}
