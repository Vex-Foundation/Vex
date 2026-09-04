/**
 * pools.fun launchpad - fixed provider facts.
 *
 * pools.fun is a NO-CURVE launchpad on Robinhood Chain (chainId 4663): every
 * token is minted into a live SushiSwap V3 pool (1% fee tier) at deploy time,
 * so there is no bonding curve and no graduation. These values come from the
 * probe of 2026-08-17/18 (`agents_dm/pools-fun-probe/`): contract addresses are
 * Blockscout-verified, and every enum below was read back out of the provider's
 * own zod rejection messages rather than guessed.
 *
 * The REST base lives in config (`services.poolsFunApiUrl`) because it is an
 * environment endpoint, not a secret; the addresses and chain here are protocol
 * constants that never move without a contract migration.
 */

/** Default REST base (also the `services.poolsFunApiUrl` default). */
export const POOLS_FUN_API_URL = "https://api.bankr.bot";

/** Robinhood Chain id the launchpad runs on. Pinned - the agent never picks a chain. */
export const POOLS_CHAIN_ID = 4663;

/**
 * The provider's chain slug. ALWAYS sent: omitting `chain` silently defaults the
 * API to Base, and the resulting rows look like plausible Robinhood data
 * (probe HARD RULE 1).
 */
export const POOLS_CHAIN_SLUG = "robinhood";

/**
 * THE CONTRACT SUITES, and why there are three.
 *
 * pools.fun redeployed its whole triple twice inside three days (V1 -> V2 on
 * 2026-09-02, V2 -> V3 on 2026-09-03), and the launchpad keeps every generation
 * ALIVE: a token registered with V1 is still claimable from the V1 locker, and
 * `launches/prepare` targets whichever gateway is current. Pinning one triple as
 * "the" addresses is what made `pools__token_get` report every post-migration
 * token as "unregistered / older sushi launcher" and made every launch refuse
 * with `calldata_undecodable` (measured, REPORT.md sections 4 and 9).
 *
 * So the addresses are a TABLE keyed by the gateway's own `VERSION()`, and a
 * consumer says which suite it means. Every row was read back from the chain on
 * 2026-09-04 (`live-chain/suite_probe_2026-09-04.json`): the gateway's
 * `VERSION()` equals the key, `gateway.factory()` equals `factory`,
 * `factory.locker()` equals `locker`, and `locker.factory()` closes the loop
 * back to `factory`. The suite is a closed triangle, which is what lets suite
 * detection require agreement instead of trusting one lookup.
 *
 * READS AND CLAIMS SPAN ALL THREE (owner decision D-suites). LAUNCHES TARGET
 * {@link POOLS_LAUNCH_SUITE_VERSION} ONLY - V1 and V2 launch code is deleted
 * rather than kept "just in case", because a second launch path is a second
 * money path nobody exercises.
 *
 * CAPABILITIES DIFFER BY SUITE, and the differences are facts, not omissions:
 *   V1  no holder rewards, no stock pricing at all (`FEES_TO_HOLDERS`,
 *       `priceSigner`, `pricingEpoch`, `MIN/MAX_SIGNED_QUOTE_AGE` all revert).
 *   V2  `FEES_TO_HOLDERS` only - the PAIRED and BOTH sentinels do not exist, so
 *       V2 holder rewards are token-mode only.
 *   V3  all three sentinels, and the signed-stock pricing surface.
 * `holderRewardsDeployer` is therefore optional on a row, and a caller that
 * needs it on a suite that has none is told so by name.
 */
export interface PoolsContractSuite {
  /** The gateway's own `VERSION()`. The key, and the thing that is verified. */
  readonly version: 1 | 2 | 3;
  /** PoolsFunLaunchGateway - the prepared launch path, and `launcherOf`. */
  readonly gateway: string;
  /** PartyFactory - deploys the token, creates and seeds the Sushi V3 pool. */
  readonly factory: string;
  /** PartyLocker - holds every LP NFT forever; owns `getPoolInfo` / `getPoolSplits`. */
  readonly locker: string;
  /**
   * HolderRewardsDeployer singleton, which mints one distributor per opted-in
   * token. Absent on V1: that suite has no holder rewards at all.
   */
  readonly holderRewardsDeployer?: string;
}

/**
 * Every suite Vex knows, newest LAST so `POOLS_SUITES` reads as a history.
 *
 * A token that matches none of these is not a pools.fun gateway token at all -
 * which is a fact about the token, not about this table, and is reported in
 * exactly those words.
 */
export const POOLS_SUITES: readonly PoolsContractSuite[] = [
  {
    version: 1,
    gateway: "0x3AB42e7dd316aF8854033bc216C657eD34961164",
    factory: "0x626C3d09B65bF5d1D40E0D5F25e19fa49783B3D4",
    locker: "0x35E41f84d3fD61d4648F0c8B41a1E7d301bCd75E",
  },
  {
    version: 2,
    gateway: "0xC5cf20C52b98bEe5fa2440ed0D2CFBBe9a4c2fc0",
    factory: "0x80709b9040C2f794ffceE629dE5b6dF7594A4A58",
    locker: "0x7BDF342857BBb1dED76b3aa5E0C580D5c87aD49E",
    holderRewardsDeployer: "0x2da890c5F7c17ca1c07d0D3c709F4Ca3B9F34378",
  },
  {
    version: 3,
    gateway: "0x2Bc81783Ed0fDd8B04604FF93FA3872212cac429",
    factory: "0x5f13c63a8060Fd47f7B7278FBCb3A6f47FCb2DC6",
    locker: "0xd64C1f0f26b6f636520bC686f8E25cBA58082cFE",
    holderRewardsDeployer: "0x5aeE24bD5c0aD32C136B96d82157C0D3A6d7BBAA",
  },
] as const;

/** A suite version, as a type. Reads accept any of them; launches accept one. */
export type PoolsSuiteVersion = PoolsContractSuite["version"];

/**
 * The ONE suite a launch may target.
 *
 * Owner decision D-suites: launches are V3-only. This constant is not a default
 * a caller may override - it is the whole launch surface, and the verifier
 * proves the live gateway's `VERSION()` equals it before anything is signed. A
 * fourth suite appearing on-chain does NOT silently become the launch target: a
 * `gatewayVersion` the table does not carry is refused by name until this
 * constant, the ABI and the verifier are updated together.
 */
export const POOLS_LAUNCH_SUITE_VERSION = 3 as const;

/**
 * The suite a version names, or `undefined` when Vex does not know that suite.
 *
 * Not exported: the only caller is {@link poolsLaunchSuite} below. A lane that
 * needs version lookup exports it when it has a consumer, rather than this one
 * publishing a surface nobody uses.
 */
function poolsSuiteByVersion(version: number): PoolsContractSuite | undefined {
  return POOLS_SUITES.find((suite) => suite.version === version);
}

/**
 * The suite a launch targets. Never `undefined` - the table and the constant are
 * pinned together, and a table that lost its launch suite is a build-time bug
 * rather than a runtime branch, so this throws instead of returning a fallback.
 */
export function poolsLaunchSuite(): PoolsContractSuite {
  const suite = poolsSuiteByVersion(POOLS_LAUNCH_SUITE_VERSION);
  if (suite === undefined) {
    throw new Error(
      `POOLS_SUITES has no entry for the pinned launch suite V${POOLS_LAUNCH_SUITE_VERSION}.`,
    );
  }
  return suite;
}

/**
 * USDG - the one launchable pair whose address is NOT derivable from the
 * gateway.
 *
 * WETH is read live from `PoolsFunLaunchGateway.weth()` (it is the address the
 * gateway's own native-prebuy guard compares against), so it is deliberately
 * NOT pinned here. USDG has no such on-chain derivation, so it is pinned - the
 * same address the shared chain registry carries for 4663, on-chain symbol and
 * decimals verified 2026-07-05, six decimals. It is still only usable when the
 * factory's `allowedPairedAsset` says so at the anchored block; this constant
 * names the asset, it never authorizes it.
 */
export const POOLS_USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

/** SushiLaunchpad - the older sibling launcher behind `platform=sushi` rows. */
export const POOLS_SUSHI_LAUNCHPAD_ADDRESS = "0x104F1Ab42674565EC3DF0BFEbCcC4186f72fA7ED";

/** REST endpoint paths. `ohlcv` is a template - the token address is a path segment. */
export const POOLS_ENDPOINTS = {
  discover: "/discover",
  ohlcv: (token: string) => `/discover/${token}/ohlcv`,
  // Launch preparation. Note `uploadImage` sits UNDER `/launches/`:
  // `/pools-fun/upload-image` is a 404 (measured).
  launchConfig: "pools-fun/launches/config",
  uploadImage: "pools-fun/launches/upload-image",
  devBuyQuote: "pools-fun/launches/dev-buy-quote",
  prepareLaunch: "pools-fun/launches/prepare",
  // Reads added 2026-09-04. `launchAssets` is the authoritative tokenised-stock
  // universe (the frontend bundle also ships a 200-entry CoinGecko fallback
  // list, which is NOT authoritative); `holderRewards` is the fees-to-holders
  // distributor read. Neither is under `/launches/`.
  launchAssets: "pools-fun/launch-assets",
  holderRewards: "pools-fun/holder-rewards",
} as const;

/**
 * The launcher a row came from. `poolsfun` = PartyFactory, `sushi` = the older
 * SushiLaunchpad, `all` = both. Omitting the param entirely (not offered here)
 * returns Bankr/Doppler tokens from a THIRD launchpad on the same chain, which
 * is why `platform` is a required client argument rather than an optional one.
 */
export const POOLS_PLATFORMS = ["poolsfun", "sushi", "all"] as const;
export type PoolsPlatform = (typeof POOLS_PLATFORMS)[number];

/**
 * The launchers a ROW can actually come from.
 *
 * Deliberately NOT the same set as {@link POOLS_PLATFORMS}: `all` is a request
 * SELECTOR meaning "either launcher", and no row is ever authored by a launcher
 * called "all". Letting the selector type describe a row means a response
 * carrying `platform: "all"` validates, gets projected, and tells the agent a
 * launcher that does not exist - so the two ideas are two types.
 */
export const POOLS_ROW_PLATFORMS = ["poolsfun", "sushi"] as const;
export type PoolsRowPlatform = (typeof POOLS_ROW_PLATFORMS)[number];

/** Server sort keys, read verbatim from the provider's zod rejection. */
export const POOLS_SORT_KEYS = [
  "marketCapUsd",
  "vol1m",
  "vol5m",
  "vol1h",
  "vol6h",
  "vol24h",
  "txCount24h",
  "priceChange1m",
  "priceChange5m",
  "priceChange1h",
  "priceChange6h",
  "priceChange24h",
  "lastTradeAt",
  "deployedAt",
] as const;
export type PoolsSortKey = (typeof POOLS_SORT_KEYS)[number];

export const POOLS_SORT_ORDERS = ["desc", "asc"] as const;
export type PoolsSortOrder = (typeof POOLS_SORT_ORDERS)[number];

/** Windows the `minVolUsd` floor can be measured over. Server enum. */
export const POOLS_VOL_TIMEFRAMES = ["1m", "5m", "1h", "6h", "24h"] as const;
export type PoolsVolTimeframe = (typeof POOLS_VOL_TIMEFRAMES)[number];

/** Candle base unit; the candle span is `aggregate` x this. Server enum. */
export const POOLS_CANDLE_TIMEFRAMES = ["minute", "hour", "day"] as const;
export type PoolsCandleTimeframe = (typeof POOLS_CANDLE_TIMEFRAMES)[number];

/** Server page-size cap on `/discover`. The client clamps to match. */
export const POOLS_DISCOVER_LIMIT_CAP = 100;

/** Server cap on `/discover/{token}/ohlcv?limit=`. */
export const POOLS_CANDLE_LIMIT_CAP = 1000;

/** Server cap on the candle `aggregate` multiplier. */
export const POOLS_CANDLE_AGGREGATE_CAP = 24;

/**
 * Fee tier of every pools.fun pool, in basis points. It is charged by the pool
 * itself, so a quote on a pools.fun token shows roughly 100 bps of "price
 * impact" before any real slippage - that is the fee, not depth.
 */
export const POOLS_POOL_FEE_BPS = 100;
