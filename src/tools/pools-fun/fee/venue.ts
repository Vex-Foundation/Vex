/**
 * pools.fun as the shared native-fee lane sees it.
 *
 * Same mechanism as Trench (`@tools/trench-express/fee/venue.ts`), same rate,
 * different venue: the fee is a SEPARATE native transfer to the Vex treasury
 * that runs AFTER the launch confirms, because the gateway exposes no fee
 * parameter to embed one in.
 *
 * ONE BASIS, and the exclusion it implies. pools.fun launches charge on
 * `launch_msg_value` - the native value the launch sends, which is the gateway
 * deployment fee plus a NATIVE prebuy. A USDG prebuy is an ERC-20 leg and is
 * therefore NOT in the native basis and NOT charged (builder-brief condition,
 * verbatim force). That is a deliberate product position: changing it needs a
 * separate owner decision, not an implementation choice.
 */

import { gasLimitWithHeadroom } from "../../evm-chains/gas-limit-headroom.js";
import type { NativeFeeVenue } from "../../vex-fee/native-leg/index.js";
import { VEX_TREASURY_EVM } from "../../../lib/vex-treasury.js";

/** Same 25 bps as every other venue on this lane. A product-owner constant, never model input. */
export const POOLS_FEE_BPS = 25;

/**
 * Gas budgeted for the fee leg - WHAT THE BROADCASTER WILL SIGN, not the
 * intrinsic floor.
 *
 * The leg is a plain native transfer with empty calldata. That exact call was
 * estimated live on Robinhood Chain (4663) at 21000 and captured in
 * `src/__tests__/trench-express/fixtures/live-captures/fee-leg-gas-estimate.json`;
 * the staged broadcaster always signs `gasLimitWithHeadroom(estimate)`, so the
 * headroomed figure is what the wallet must actually be able to pay. It is
 * budgeted rather than estimated because the leg is not built at plan time, and
 * estimating a transaction that will be sent AFTER another one confirms would be
 * a guess dressed as a measurement.
 *
 * Derived through the shared helper rather than hand-typed, so retuning the
 * headroom moves this with it.
 */
export const POOLS_FEE_LEG_GAS_LIMIT = gasLimitWithHeadroom(21_000n);

/** The `agent_activity.event_role` a pools.fun fee leg is recorded under (migration 082). */
export const POOLS_FEE_ACTIVITY_EVENT_ROLE = "pools_fee" as const;

/** The only basis pools.fun charges on. */
export type PoolsFeeBasis = "launch_msg_value";

const ORDERING_NOTE =
  `Vex charges ${POOLS_FEE_BPS} bps (0.25%) on the native value a pools.fun launch sends (the gateway `
  + "deployment fee plus any ETH prebuy), as a SEPARATE transfer to the Vex treasury that runs AFTER the "
  + "launch confirms. A launch that does not happen is never charged, and a fee transfer that fails leaves "
  + "the launch itself completely unaffected. A USDG prebuy is an ERC-20 leg and is not part of this basis. "
  + "USD figures are estimates.";

const SKIPPED_NOTE =
  "No Vex fee was taken on this pools.fun launch: 25 bps of the native launch value floors to zero at this "
  + "size, so no fee transfer is made at all.";

const UNPROVEN_BASE_NOTE =
  "No Vex fee was taken on this pools.fun launch: the native value it would be charged on could not be "
  + "established from the transaction, and Vex does not charge a percentage of an amount it cannot prove. "
  + "The launch itself is unaffected.";

// `satisfies`, not an annotation: the runtime half needs the LITERAL
// `"pools_fee"` to prove against the database's role vocabulary at compile time.
export const POOLS_FEE_VENUE = {
  bps: POOLS_FEE_BPS,
  receiver: VEX_TREASURY_EVM,
  activityEventRole: POOLS_FEE_ACTIVITY_EVENT_ROLE,
  protocol: "pools",
  chainSlug: "robinhood",
  nativeLabel: "ETH",
  nativeDecimals: 18,
  logPrefix: "pools.fee",
  displayName: "pools.fun",
  amountLabel: "pools.fun launch value",
  basisText: {
    launch_msg_value: "the ETH this launch sends (deployment fee + any ETH prebuy)",
  },
  notes: { ordering: ORDERING_NOTE, skipped: SKIPPED_NOTE, unprovenBase: UNPROVEN_BASE_NOTE },
} satisfies NativeFeeVenue<PoolsFeeBasis>;
