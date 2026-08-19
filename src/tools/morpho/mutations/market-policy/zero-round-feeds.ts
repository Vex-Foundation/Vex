/**
 * The price sources that legitimately report `updatedAt == 0`, and the rule that
 * everything else reporting it is REFUSED BY NAME.
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
 *
 * A Chainlink-shaped feed answers `latestRoundData()` with a round, and the
 * round's timestamp is what layer 3 judges freshness on. An EXCHANGE-RATE
 * ADAPTER has no round at all: it derives its answer from live chain state
 * (a vault's share price, a liquid-staking token's ratio, a Pendle PT's linear
 * discount) and returns zero for the timestamp because there is no report to
 * date. A staleness bound on zero would be a bound on a number carrying no time.
 *
 * The earlier rule read that the other way round: ANY feed answering zero was
 * assumed to be such an adapter and skipped the freshness test entirely, on no
 * evidence about the contract at all. That is an unclassified bypass. A feed
 * that is simply broken, uninitialised, or built to return zero on purpose gets
 * the same exemption as a real adapter, and the factory check does not close it:
 * the factory's creation path takes caller-selected feeds, so factory provenance
 * proves the ORACLE's implementation shape and says nothing about what the feed
 * underneath it is.
 *
 * So the exemption is now a RECOGNITION, not an assumption. A zero timestamp is
 * permitted only from a source in the table below; anything else answering zero
 * is refused, naming the address, so the failure is a reviewable fact rather
 * than a silent pass.
 *
 * ── HOW THE SEED SET WAS PRODUCED, 2026-08-18 ───────────────────────────────
 *
 * Empirically, not by guesswork and not from the two adapter families that were
 * assumed to be the whole class. Every LISTED market on the six Morpho chains
 * that carry them (1, 10, 130, 137, 8453, 42161) was read from Morpho's API,
 * every distinct oracle behind them was asked for its four immutable feed legs,
 * and every non-zero leg was called for `latestRoundData()` over public RPC.
 * 476 legs answered. Exactly the readings below returned `updatedAt == 0`, each
 * with a positive answer, and every one of them sits behind a market Morpho
 * curates today.
 *
 * THE MEASUREMENT CHANGED THE DESIGN. Seeding only the wstETH/stETH and
 * weETH/ETH class, which is what the class was believed to be, would have
 * refused twelve further sources behind live curated markets, including
 * wFalconX/USDC at 21.5M USD supplied and PT-sUSDS-26NOV2026/USDS at 2.6M. The
 * zero-timestamp population is mostly Pendle PT discount adapters and vault
 * share-price readers, not liquid-staking ratios.
 *
 * WHAT AN ENTRY MEANS, EXACTLY: on the date given, this address answered
 * `latestRoundData()` with a positive price and no round, behind a market Morpho
 * curates. It does NOT mean a human read its source. That is a weaker claim than
 * the owner allowlist in `../../constants.ts` makes, and it is the right strength
 * for what it authorizes: not entry to a market, only the right to be judged on
 * a positive answer instead of on a timestamp that does not exist. Layers 1 and
 * 2 still have to pass on their own.
 *
 * THE OWNER PATH TO EXTEND IT: re-run the survey above, and add the address with
 * the market it serves and the date it was observed. Widening this table widens
 * the set of markets Vex will fund, so it is a security-posture change under
 * rules/00 needing explicit owner approval, never a builder's judgement.
 */

/** One price source observed answering with a positive price and no round. */
export interface MorphoZeroRoundFeed {
  /** The feed contract, lower-cased. */
  readonly feed: string;
  /** The curated market(s) it was observed behind, for a reader and a re-check. */
  readonly markets: string;
  /** ISO date of the observation. */
  readonly observedOn: string;
}

const OBSERVED_ON = "2026-08-18";

/**
 * Sources permitted to answer with no round, per chain.
 *
 * Chains absent from this table have none, which is a measurement rather than an
 * omission: on 10, 137 and 42161 every leg behind every listed market answered
 * with a real round.
 */
export const MORPHO_ZERO_ROUND_FEEDS: Readonly<Record<number, readonly MorphoZeroRoundFeed[]>> = {
  1: [
    { feed: "0x905b7dabcd3ce6b792d874e303d336424cdb1421", markets: "wstETH/WETH, wstETH/USDS, wstETH/eUSD", observedOn: OBSERVED_ON },
    { feed: "0x4270e1817576bba4b640466be79a408ef128f828", markets: "weETH/WETH, weETH/USDT, weETH/RLUSD, weETH/tGBP", observedOn: OBSERVED_ON },
    { feed: "0xb2ca3c47b1bea4ad7cfd187a522be0f1bfc8652b", markets: "ezETH/WETH", observedOn: OBSERVED_ON },
    { feed: "0xb2b18e668ce6326760e3b063f72684fdf2a2d582", markets: "rswETH/msETH", observedOn: OBSERVED_ON },
    { feed: "0xf87d2f4d42856f0b6eae140aaf78bf0f777e9936", markets: "ETH+/WETH", observedOn: OBSERVED_ON },
    { feed: "0x50449b3d1f5931d568a1951ee506a9534e7f7dff", markets: "wFalconX/USDC", observedOn: OBSERVED_ON },
    { feed: "0x9dd65b6d956e31f4dc093372d975275986695827", markets: "fxSAVE/USDC", observedOn: OBSERVED_ON },
    { feed: "0xcb8c6585bd593a4b7d91bfcc85ff1dcfa04a640b", markets: "PT-strUSD-26NOV2026/USDC", observedOn: OBSERVED_ON },
    { feed: "0x7180e88ac8883aac79934ad27cfab41d5aa74d19", markets: "PT-trUSD-26NOV2026/USDC", observedOn: OBSERVED_ON },
    { feed: "0xd1264c014a912da0415a03df8580bb63add0e0a4", markets: "PT-sUSDS-26NOV2026/USDS", observedOn: OBSERVED_ON },
    { feed: "0xd59b907b5cc2ca17bda83ccbf7f636536be9c866", markets: "PT-USDe-31JUL2025/DAI", observedOn: OBSERVED_ON },
    { feed: "0xb608a1584322e68c401129e1e8775777c43cb6f7", markets: "PT-sUSDE-31JUL2025/DAI", observedOn: OBSERVED_ON },
    { feed: "0x7aa6a2a9f61502e3e411b7b3db625c1851ad7fb4", markets: "PT-USDS-14AUG2025/DAI", observedOn: OBSERVED_ON },
  ],
  130: [
    { feed: "0x2cc00aa368c105575e0c55e9e528fa4ded3e41b7", markets: "PT-cUSD-23JUL2026-(ETH)/USDC", observedOn: OBSERVED_ON },
  ],
  8453: [
    { feed: "0x998a521d787457c646b15fdfd24beffd09fbf2cf", markets: "uniBTC/USDC", observedOn: OBSERVED_ON },
  ],
};

/** Is this price source one Vex recognises as having no round to be stale? */
export function findRecognizedZeroRoundFeed(chainId: number, feed: string): MorphoZeroRoundFeed | null {
  const wanted = feed.trim().toLowerCase();
  return (MORPHO_ZERO_ROUND_FEEDS[chainId] ?? []).find((entry) => entry.feed === wanted) ?? null;
}
