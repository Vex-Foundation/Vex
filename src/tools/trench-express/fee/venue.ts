/**
 * Trench Express as the shared native-fee lane sees it.
 *
 * Every value here was previously spelled out across `constants.ts`,
 * `fee-transfer.ts` and `fee-disclosure.ts`; the extraction moved the MECHANISM
 * to `@tools/vex-fee/native-leg/` and left the venue's own decisions - the rate,
 * the recorded role, and the sentences describing which leg the fee came out of
 * - right here, where the owner's reasoning for them already lived.
 *
 * The prose is reproduced verbatim from the pre-extraction disclosure. It is
 * what a user reads about their own money, so the refactor had to carry it
 * across unchanged rather than paraphrase it.
 */

import type { NativeFeeVenue } from "../../vex-fee/native-leg/index.js";
import {
  TRENCH_FEE_ACTIVITY_EVENT_ROLE,
  TRENCH_FEE_BPS,
  TRENCH_FEE_RECEIVER_EVM,
  type TrenchFeeBasis,
} from "./constants.js";

const ORDERING_NOTE =
  `Vex charges ${TRENCH_FEE_BPS} bps (0.25%) on the ETH leg of every Trench Express action, as a SEPARATE `
  + "transfer to the Vex treasury that runs AFTER the trade or launch confirms. A trade or launch that does "
  + "not happen is never charged, and a fee transfer that fails leaves the trade itself completely unaffected. "
  + "USD figures are estimates.";

const SKIPPED_NOTE =
  "No Vex fee was taken on this Trench Express action: 25 bps of the ETH leg floors to zero at this size, "
  + "so no fee transfer is made at all.";

const UNPROVEN_BASE_NOTE =
  "No Vex fee was taken on this Trench Express action: the ETH leg it would be charged on could not be "
  + "established from the transaction, and Vex does not charge a percentage of an amount it cannot prove. "
  + "The action itself is unaffected.";

// `satisfies`, not a type annotation: the annotation would widen
// `activityEventRole` to `string`, and the runtime half needs the LITERAL
// `"trench_fee"` to prove against the database's role vocabulary at compile time.
export const TRENCH_FEE_VENUE = {
  bps: TRENCH_FEE_BPS,
  receiver: TRENCH_FEE_RECEIVER_EVM,
  activityEventRole: TRENCH_FEE_ACTIVITY_EVENT_ROLE,
  protocol: "trench",
  chainSlug: "robinhood",
  nativeLabel: "ETH",
  nativeDecimals: 18,
  logPrefix: "trench.fee",
  displayName: "Trench",
  amountLabel: "Trench ETH-leg amount",
  basisText: {
    buy_eth_in: "the ETH you spend on this buy",
    sell_eth_out: "the ETH you receive from this sell",
    launch_msg_value: "the ETH this launch sends (creation fee + prebuy)",
  },
  notes: { ordering: ORDERING_NOTE, skipped: SKIPPED_NOTE, unprovenBase: UNPROVEN_BASE_NOTE },
} satisfies NativeFeeVenue<TrenchFeeBasis>;
