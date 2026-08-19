/**
 * LAYER 3: is every price leg ANSWERING NOW?
 *
 * The only layer that sees the present moment. Curation is a judgement made
 * once and the implementation check is about bytecode; neither notices a feed
 * that went silent afterwards, and the 2026-08-17 survey found feeds 25, 76,
 * 149, 241 and 335 days stale still pricing funded markets.
 *
 * A REVERTING FEED IS A REFUSAL BY NAME, not a skipped check. An oracle whose
 * price source will not answer cannot be shown to price the collateral at all.
 *
 * THE TIMESTAMP IS JUDGED IN BOTH DIRECTIONS. A round dated in the future is not
 * a fresh price; it is a feed whose age cannot be measured, and `age > limit`
 * alone reads it as the freshest feed on the chain. The one such reading in the
 * 2026-08-18 survey was real: the sUSN/USDC feed on Ethereum
 * (`0x6e498b02c0036235c8164a502b0eecc7660bd889`, 1.6M USD supplied) reports its
 * timestamp in NANOSECONDS, which lands about 5.6e10 years ahead and passed the
 * old test unremarked. A ZERO timestamp is a separate fact again, handled by
 * `./zero-round-feeds.ts`.
 */

import type { Address } from "viem";

import { VexError, ErrorCodes } from "../../../../errors.js";
import {
  MORPHO_AGGREGATOR_V3_ABI,
  MORPHO_CHAINLINK_ORACLE_V2_ABI,
  MORPHO_FEED_MAX_AGE_SECONDS,
  MORPHO_ORACLE_FEED_GETTERS,
  type MorphoOracleFeedGetter,
} from "../../oracle-legs.js";
import type { MorphoActionClient } from "../client.js";
import { NOTHING_HAPPENED_HINT, policyViolation, ZERO_ADDRESS } from "./refusal.js";
import { findRecognizedZeroRoundFeed } from "./zero-round-feeds.js";

/**
 * How far AHEAD of Vex's own clock a feed's round may be dated.
 *
 * TWO MINUTES, from measurement. Across the 476 live feed legs read behind every
 * listed market on six chains on 2026-08-18, not one legitimate feed reported a
 * timestamp ahead of the host clock at the moment of the read. The host clock sat
 * 14 seconds behind Ethereum's latest block timestamp and 0 to 1 second behind
 * the other chains', which is block interval rather than drift: a feed updated in
 * the pending block can legitimately carry a timestamp a few seconds ahead of a
 * host that is otherwise in sync. Two minutes covers that plus ordinary NTP-scale
 * host drift with a wide margin, while still refusing the only real offender
 * found, which is ahead by geological amounts rather than by seconds.
 *
 * Owner-tunable in one place, never read from tool input or model output.
 */
export const MORPHO_FEED_MAX_CLOCK_SKEW_SECONDS = 120;

/**
 * A zero round is permitted only from a source Vex RECOGNISES.
 *
 * See `./zero-round-feeds.ts` for why this is a recognition rather than an
 * assumption, and for how the seed set was measured.
 */
function assertRecognizedZeroRoundFeed(chainId: number, feed: string, getter: MorphoOracleFeedGetter): void {
  if (findRecognizedZeroRoundFeed(chainId, feed) !== null) return;
  policyViolation(
    `Refusing the market: FAILING PREDICATE "oracle-feed-live". The price feed ${feed} its oracle uses as ${getter} `
    + "answers with NO ROUND AT ALL (updatedAt is zero), and it is not one of the exchange-rate adapters Vex "
    + `recognises on chain ${chainId}. An adapter that derives its price from live chain state legitimately has no `
    + "round, so it is judged on its answer alone - but so does a feed that is broken, uninitialised, or built to "
    + "report zero on purpose, and Vex cannot tell those apart from the timestamp. Rather than assume the harmless "
    + "one, it refuses and names the address.",
    "Nothing was approved, signed or sent. If this feed is a genuine exchange-rate adapter, it has to be added to "
    + "Vex's recognised list with the market and date it was observed, which is an owner decision rather than "
    + "something the agent can waive.",
  );
}

/**
 * Read one immutable feed leg off the oracle. A getter that does not answer is
 * a leg Vex cannot read, which is refused as UNPROVEN rather than treated as
 * absent: "I could not tell what price this reads" is not "it reads nothing".
 */
async function readOracleFeed(
  client: MorphoActionClient,
  oracle: Address,
  getter: MorphoOracleFeedGetter,
  chainId: number,
): Promise<string> {
  try {
    const value = await client.readContract({
      address: oracle,
      abi: MORPHO_CHAINLINK_ORACLE_V2_ABI,
      functionName: getter,
    });
    return String(value).toLowerCase();
  } catch (error) {
    throw new VexError(
      ErrorCodes.MORPHO_RPC_ERROR,
      `Refusing the market: Vex could not read ${getter}() from its oracle ${oracle.toLowerCase()} on chain `
      + `${chainId}, so which price source that oracle actually reads is UNKNOWN rather than acceptable.`,
      "Nothing was signed or sent. Retry once the RPC is reachable. Vex does not enter a Blue market whose price "
      + "legs it could not read, because those legs decide when the collateral is seized. The read failed with: "
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function assertOracleFeedsLive(
  client: MorphoActionClient,
  chainId: number,
  oracle: Address,
): Promise<void> {
  for (const getter of MORPHO_ORACLE_FEED_GETTERS) {
    const feed = await readOracleFeed(client, oracle, getter, chainId);
    if (feed === ZERO_ADDRESS) continue;

    let answer: bigint;
    let updatedAt: bigint;
    try {
      const round = await client.readContract({
        address: feed as Address,
        abi: MORPHO_AGGREGATOR_V3_ABI,
        functionName: "latestRoundData",
      });
      answer = round[1];
      updatedAt = round[3];
    } catch {
      policyViolation(
        `Refusing the market: FAILING PREDICATE "oracle-feed-live". The price feed ${feed} its oracle uses as `
        + `${getter} did not answer latestRoundData() at all. A feed that reverts cannot price the collateral, and a `
        + "position whose collateral cannot be priced is one whose liquidation nobody can predict.",
        NOTHING_HAPPENED_HINT,
      );
    }

    if (answer <= 0n) {
      policyViolation(
        `Refusing the market: FAILING PREDICATE "oracle-feed-live". The price feed ${feed} its oracle uses as `
        + `${getter} reports ${answer}, which is not a positive price. A feed answering zero prices the collateral `
        + "at nothing, and collateral worth nothing is a position that can be liquidated in full.",
        NOTHING_HAPPENED_HINT,
      );
    }

    if (updatedAt === 0n) {
      assertRecognizedZeroRoundFeed(chainId, feed, getter);
      continue;
    }

    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    if (updatedAt > nowSeconds + BigInt(MORPHO_FEED_MAX_CLOCK_SKEW_SECONDS)) {
      policyViolation(
        `Refusing the market: FAILING PREDICATE "oracle-feed-live". The price feed ${feed} its oracle uses as `
        + `${getter} reports a round dated ${updatedAt}, which is ${updatedAt - nowSeconds} seconds in the FUTURE, `
        + `beyond the ${MORPHO_FEED_MAX_CLOCK_SKEW_SECONDS}-second allowance Vex keeps for clock differences. A `
        + "timestamp ahead of now is not a fresh price: it is a feed whose age cannot be measured at all, and an age "
        + "test alone would have read it as the freshest feed on the chain.",
        NOTHING_HAPPENED_HINT,
      );
    }

    const ageSeconds = nowSeconds - updatedAt;
    if (ageSeconds > BigInt(MORPHO_FEED_MAX_AGE_SECONDS)) {
      policyViolation(
        `Refusing the market: FAILING PREDICATE "oracle-feed-live". The price feed ${feed} its oracle uses as `
        + `${getter} last reported ${Number(ageSeconds) / 86_400} days ago, beyond Vex's `
        + `${MORPHO_FEED_MAX_AGE_SECONDS / 86_400}-day limit. A stale price does not stop the market: it keeps `
        + "liquidating positions against a number that stopped tracking reality.",
        NOTHING_HAPPENED_HINT,
      );
    }
  }
}
