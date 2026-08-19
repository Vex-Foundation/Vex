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

/** PartyFactory - deploys the token, creates and seeds the Sushi V3 pool. */
export const POOLS_FACTORY_ADDRESS = "0x626C3d09B65bF5d1D40E0D5F25e19fa49783B3D4";

/** PartyLocker - holds every LP NFT forever; owns `getPoolInfo` / `getPoolSplits`. */
export const POOLS_LOCKER_ADDRESS = "0x35E41f84d3fD61d4648F0c8B41a1E7d301bCd75E";

/**
 * PoolsFunLaunchGateway - the launch path Vex USES (owner decision; see the
 * P3 section of `pools-fun-integration.plan.md`). The backend mines the salt and
 * returns ready `Gateway.launch(tuple)` calldata, and the gateway collects
 * `deploymentFeeWei` - a fee a direct `PartyFactory.launch()` from the EOA would
 * not pay, accepted deliberately in exchange for the prepared path.
 *
 * The attribution consequence a settlement decode must carry: on this path the
 * on-chain `creator` is the GATEWAY, and the real launcher is in `launcherOf`.
 * Note this does NOT affect `pools.my_launches`, because the launchpad's own
 * deployer index credits the launching wallet (measured).
 *
 * Launch phase, not P1.
 */
export const POOLS_GATEWAY_ADDRESS = "0x3AB42e7dd316aF8854033bc216C657eD34961164";

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
