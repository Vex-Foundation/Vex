/**
 * How Vex reads a Morpho Blue market's ORACLE and the price legs underneath it,
 * and the freshness bound those legs are judged against.
 *
 * ── WHY THE FACTORY CHECK IS NOT ENOUGH ON ITS OWN ──────────────────────────
 *
 * `MORPHO_MARKET_POLICY_CONTRACTS[chainId].chainlinkOracleFactory` answers
 * `isMorphoChainlinkOracleV2(address)`, and Vex used to treat a `true` there as
 * the oracle being acceptable. IT IS NOT. The deployed factory's creation
 * function is COMPLETELY UNRESTRICTED. Read from its Sourcify-verified source
 * on Base 2026-08-17 (`0x2DC205F24BCb6B311E5cdf0745B0741648Aebd3d`):
 *
 *   function createMorphoChainlinkOracleV2(
 *       IERC4626 baseVault, uint256 baseVaultConversionSample,
 *       AggregatorV3Interface baseFeed1, AggregatorV3Interface baseFeed2,
 *       uint256 baseTokenDecimals, IERC4626 quoteVault, ...,
 *       bytes32 salt
 *   ) external returns (MorphoChainlinkOracleV2 oracle) {
 *       oracle = new MorphoChainlinkOracleV2{salt: salt}(...);
 *       isMorphoChainlinkOracleV2[address(oracle)] = true;
 *   }
 *
 * The whole contract has two functions, one event and one storage mapping.
 * There is no owner, no `Ownable`, no allowlist and no modifier of any kind, and
 * `msg.sender` is used only in the event. So ANY address can deploy an oracle
 * with feeds, vaults, decimals and salt entirely of its own choosing and have
 * the factory mark it `true` in the same transaction.
 *
 * WHAT THE FACTORY ANSWER PROVES, exactly: the oracle's IMPLEMENTATION is
 * Morpho's audited `MorphoChainlinkOracleV2` bytecode, so it runs no arbitrary
 * code and its arithmetic is the reviewed arithmetic. It proves NOTHING about
 * which prices the oracle reads, and the prices decide when the collateral is
 * seized. An attacker does not need arbitrary code: a standard oracle pointed
 * at a feed they control reports whatever they want through audited math.
 *
 * ── WHY THERE IS NO PINNED FEED ALLOWLIST HERE ──────────────────────────────
 *
 * An earlier revision of this work pinned a per-chain list of verified feed
 * addresses, seeded from Morpho's top markets by TVL. The coordinator's
 * measurement retired it, and the reason is worth keeping because it is the
 * kind of number that misleads: the two catastrophic markets that motivated the
 * list, K/USDC on Arbitrum (4.89B USD reported, feed 335 days stale) and
 * sdeUSD/USDC on Ethereum (2.97B USD reported, feed reverting), are BOTH
 * `listed: false`. They are permissionless markets Morpho does not curate. The
 * headline "70% of USD capacity excluded" was measured against a pool dominated
 * by exactly the junk we never wanted, next to which genuine curated markets
 * look small (cbBTC/USDC is `listed: true` at 308.7M USD).
 *
 * A static allowlist also cannot do the job it was hired for. It inherits only
 * the liveness of the day it was seeded, needs a dated commit to admit any new
 * market, and would still have to be paired with a live freshness read to catch
 * a feed that rots afterwards. Once that read exists, the list is a maintenance
 * burden that mostly refuses honest markets.
 *
 * ── THE THREE LAYERS, AND WHY NONE OF THEM IS REDUNDANT ─────────────────────
 *
 * `../mutations/market-policy.ts` applies these in order:
 *
 *   1. CURATION. `listed: true` from Morpho's own API, checked AT EXECUTION
 *      TIME rather than only during discovery. This is the main filter.
 *   2. IMPLEMENTATION. The factory check above, unchanged.
 *   3. LIVENESS. Every non-zero feed leg is read ON CHAIN and must answer with
 *      a positive price and a round no older than {@link MORPHO_FEED_MAX_AGE_SECONDS}.
 *
 * The owner's manual oracle allowlist stands in for LAYER 2 ALONE. A human can
 * read verified source and say "this implementation is sound"; a human cannot
 * say "and its feed will still be answering next month", and layer 1 is not
 * theirs to waive either. So an allowlisted oracle is still refused on an
 * uncurated market and still refused on a stale feed.
 *
 * They cover different failures and cannot substitute for one another:
 *
 *   - layer 1 is an OFF-CHAIN assertion, and this repository's own rules forbid
 *     an indexed value being the sole basis of a signing decision. It is also
 *     the only layer that can be wrong because an API is wrong;
 *   - layer 2 needs NO NETWORK AT ALL beyond one chain read, and it is what
 *     still stands if the API lies or is compromised;
 *   - layer 3 is the ONLY layer that sees the present moment. Curation is a
 *     judgement made once; a feed can rot the day after it is made.
 *
 * ── EXCHANGE-RATE ADAPTERS AND `updatedAt == 0` ─────────────────────────────
 *
 * A Lido or Ether.fi style adapter (wstETH/stETH, weETH/ETH and their class)
 * returns `updatedAt == 0` because it DERIVES its answer from live chain state
 * rather than from a pushed report. There is no round, so there is nothing to
 * be stale, and a staleness bound on it would be a bound on a number that
 * carries no time. Those pass layer 3 on a POSITIVE ANSWER ALONE.
 *
 * That exemption is safe here only because layers 1 and 2 still apply to them:
 * the market is one Morpho curates and the oracle is the standard
 * implementation. It is deliberately not a hole an arbitrary contract can climb
 * through by returning a zero timestamp, because such a contract would have to
 * be inside a curated market behind a factory-minted oracle first.
 */

/**
 * The immutable legs a `MorphoChainlinkOracleV2` exposes.
 *
 * NAMES CONFIRMED EMPIRICALLY, not assumed: each getter below was called with
 * `cast` against the live cbBTC/USDC oracle
 * `0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9` on Base 2026-08-17 and answered.
 * 85 of the 86 distinct Base oracles probed answer all of them.
 */
export const MORPHO_CHAINLINK_ORACLE_V2_ABI = [
  { name: "BASE_FEED_1", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "BASE_FEED_2", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "QUOTE_FEED_1", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "QUOTE_FEED_2", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** `latestRoundData()`, the liveness read. Chainlink's AggregatorV3 shape. */
export const MORPHO_AGGREGATOR_V3_ABI = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** The four price legs an oracle may carry. A zero address means "not used". */
export const MORPHO_ORACLE_FEED_GETTERS = [
  "BASE_FEED_1",
  "BASE_FEED_2",
  "QUOTE_FEED_1",
  "QUOTE_FEED_2",
] as const;

export type MorphoOracleFeedGetter = (typeof MORPHO_ORACLE_FEED_GETTERS)[number];

/**
 * How old a feed's last ROUND may be at execution time.
 *
 * SEVEN DAYS, chosen from measurement rather than taste. The 2026-08-17 survey
 * of every oracle behind Morpho's listed markets on nine chains found healthy
 * feeds updating anywhere from seconds to about twenty hours apart: real
 * heartbeats vary that much, so a tight global bound would refuse honest slow
 * feeds on a money path, which is its own kind of harm. Seven days admits every
 * feed observed answering normally and still refuses the class this check
 * exists for, the 25, 76, 149, 241 and 335 day corpses the same survey found
 * sitting in funded markets.
 *
 * Tightening it is a product decision with a real refusal cost, so it is one
 * owner-tunable constant in one place rather than a number spread across call
 * sites. It is never read from tool input or model output.
 */
export const MORPHO_FEED_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
