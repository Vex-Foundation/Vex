/**
 * LAYER 1: is this a market Morpho actually curates?
 *
 * ASKED LIVE, AT EXECUTION TIME, not inherited from discovery. Morpho Blue is
 * permissionless, so `listed` is the difference between a market a curator
 * stands behind and one anybody opened this morning. The discovery lane already
 * defaults to listed markets, but a market id can reach an execute tool by any
 * route at all, and the id proves only that five parameters hash to it.
 *
 * WHY THIS IS THE MAIN FILTER, measured rather than assumed: the two ruinous
 * markets found in the 2026-08-17 survey, K/USDC on Arbitrum with a 335-day
 * stale feed and sdeUSD/USDC on Ethereum with a reverting one, are both
 * `listed: false`.
 *
 * AN UNREACHABLE API IS A REFUSAL, NOT A BYPASS. If the curation check cannot
 * be performed, the market is refused and the reason says the check could not
 * run. Vex does NOT fall back to signing on the implementation and liveness
 * layers alone, and it does not accept a cached flag: the uncached read in
 * `MorphoClient.getMarketCuration` is what makes "at execution time" true.
 */

import { VexError, ErrorCodes } from "../../../../errors.js";
import { getMorphoClient } from "../../client.js";
import { NOTHING_HAPPENED_HINT, policyViolation } from "./refusal.js";

export async function assertMorphoCuratesMarket(chainId: number, marketId: string): Promise<void> {
  let listed: boolean;
  try {
    listed = (await getMorphoClient().getMarketCuration({ chainId, marketId })).listed;
  } catch (error) {
    if (error instanceof VexError && error.code === ErrorCodes.MORPHO_MARKET_POLICY_VIOLATION) throw error;
    throw new VexError(
      ErrorCodes.MORPHO_RPC_ERROR,
      `Refusing the market: Vex could not ask Morpho whether it curates market ${marketId.toLowerCase()} on chain `
      + `${chainId}, so its curation status is UNKNOWN rather than acceptable.`,
      "Nothing was signed or sent. This is a refusal to proceed without the check, not a judgement on the market: "
      + "Vex will not enter a permissionless lending market on the strength of the other checks alone. Retry once "
      + `Morpho's API answers. The read failed with: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!listed) {
    policyViolation(
      `Refusing the market: FAILING PREDICATE "listed". Morpho does not curate market ${marketId.toLowerCase()} on `
      + `chain ${chainId}. The market EXISTS and is perfectly real - Morpho Blue lets anyone create one by naming `
      + "five parameters - but nobody has vouched for its oracle, its collateral or its risk. The markets carrying "
      + "the worst broken price feeds Vex has measured were all uncurated ones exactly like this.",
      NOTHING_HAPPENED_HINT,
    );
  }
}
