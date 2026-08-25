/**
 * The site's Avro-dialect schema tables.
 *
 * These are the WRITER's field orders, read out of the site bundle and each one
 * verified byte-exact against a captured response (see
 * `src/__tests__/dexscreener-site/`). The decoder in `dsavro.ts` owns the
 * dialect; this module owns the site's vocabulary, which is the part that
 * changes when DexScreener deploys.
 *
 * Reading the tables:
 *
 *  - `dsDouble()` appears where the site's own schema says `long`. That is not
 *    a mistake: the writer emits those fields as 8-byte doubles (measured).
 *    Millisecond timestamps and block numbers are therefore `number`, exact up
 *    to 2^53, which covers both for the lifetime of this surface.
 *  - price and amount fields are STRINGS on the wire and stay strings here.
 *    They are decimal values that must never touch binary floating point;
 *    conversion happens at the projection boundary that knows the token's
 *    decimals.
 */

import {
  dsArray,
  dsBoolean,
  dsDouble,
  dsEnum,
  dsExtendRecord,
  dsMap,
  dsOptional,
  dsRecord,
  dsString,
  type DsAvroType,
  type DsAvroValue,
} from "./dsavro.js";

/* ------------------------------------------------------------------ */
/* /dex/chart/{amm|...}/v3/{dex}/bars/{chain}/{pair} - OHLCV bars       */
/* ------------------------------------------------------------------ */

/**
 * One candle. Prices are decimal strings; the `*Usd` companions are absent
 * (null) when the pair has no USD reference at that bar.
 *
 * `minBlockNumber`/`maxBlockNumber` are the block range the bar aggregates and
 * are what the backward walk uses as its cursor.
 */
export const PL_BAR = dsRecord({
  timestamp: dsDouble(),
  open: dsString(),
  openUsd: dsOptional(dsString()),
  high: dsString(),
  highUsd: dsOptional(dsString()),
  low: dsString(),
  lowUsd: dsOptional(dsString()),
  close: dsString(),
  closeUsd: dsOptional(dsString()),
  volumeUsd: dsOptional(dsString()),
  minBlockNumber: dsDouble(),
  maxBlockNumber: dsDouble(),
});

export const PL_BARS_RESPONSE = dsRecord({
  schemaVersion: dsString(),
  bars: dsOptional(dsArray(PL_BAR)),
});

export type PlBar = DsAvroValue<typeof PL_BAR>;
export type PlBarsResponse = DsAvroValue<typeof PL_BARS_RESPONSE>;

/* ------------------------------------------------------------------ */
/* /dex/log/{amm|...}/v5/{dex}/top/{chain}/{pair} - top makers          */
/* ------------------------------------------------------------------ */

/**
 * One maker's aggregate over the pair.
 *
 * `amountBuy`/`amountSell`/`balanceAmount` are decimal strings in BASE token
 * units. `balancePercentage` is a percentage (0-100) and is null when the
 * provider cannot compute it.
 */
export const TOPMAKER = dsRecord({
  maker: dsString(),
  label: dsOptional(dsString()),
  url: dsOptional(dsString()),
  buys: dsDouble(),
  sells: dsDouble(),
  volumeUsdBuy: dsDouble(),
  volumeUsdSell: dsDouble(),
  amountBuy: dsString(),
  amountSell: dsString(),
  balanceAmount: dsOptional(dsString()),
  balancePercentage: dsOptional(dsDouble()),
  firstSwap: dsDouble(),
  lastSwap: dsDouble(),
});

export const TOPMAKERS = dsArray(TOPMAKER);

export type TopMaker = DsAvroValue<typeof TOPMAKER>;

/* ------------------------------------------------------------------ */
/* /metas/v1/all and /metas/v1/trending - narratives                    */
/* ------------------------------------------------------------------ */

const META_FIELDS = {
  id: dsString(),
  description: dsOptional(dsString()),
  icon: dsRecord({ type: dsEnum(), value: dsString() }),
  name: dsString(),
  slug: dsString(),
  alternativeSlugs: dsOptional(dsArray(dsString())),
} as const;

/**
 * A narrative. `id` is what the screener's `filters[metaIds][]` takes; the
 * `slug` is for the site's own URLs and is NOT accepted by that filter
 * (measured: slug "ai" matches 0 pairs, its id matches 243).
 */
export const META = dsRecord(META_FIELDS);

/** The four screener windows, always all present. */
const TIMEFRAME4 = dsRecord({
  m5: dsDouble(),
  h1: dsDouble(),
  h6: dsDouble(),
  h24: dsDouble(),
});

/** A narrative with its market columns appended, in that order. */
export const META_TRENDING = dsExtendRecord(META_FIELDS, {
  marketCap: dsDouble(),
  liquidity: dsDouble(),
  volume: dsDouble(),
  tokenCount: dsDouble(),
  marketCapChange: TIMEFRAME4,
  marketCapDelta: TIMEFRAME4,
});

export const METAS_ALL = dsArray(META);
export const METAS_TRENDING = dsArray(META_TRENDING);

export type Meta = DsAvroValue<typeof META>;
export type MetaTrending = DsAvroValue<typeof META_TRENDING>;

/* ------------------------------------------------------------------ */
/* /dex/trending/v6/... - the trending bar                              */
/* ------------------------------------------------------------------ */

const PROFILE = dsRecord({
  eti: dsBoolean(),
  header: dsOptional(dsBoolean()),
  website: dsOptional(dsBoolean()),
  twitter: dsOptional(dsBoolean()),
  discord: dsOptional(dsBoolean()),
  linkCount: dsOptional(dsDouble()),
  imgKey: dsOptional(dsString()),
  nsfw: dsOptional(dsBoolean()),
});

const CMS_PROFILE = dsRecord({
  headerId: dsOptional(dsString()),
  iconId: dsString(),
  description: dsOptional(dsString()),
  links: dsOptional(
    dsArray(dsRecord({ type: dsOptional(dsEnum()), url: dsString() }))
  ),
});

/**
 * A trending row, schemaVersion 1.5 on capture. `priceChange` and `volume` are
 * maps keyed by window ("m5", "h1", "h6", "h24") whose values may be absent.
 *
 * KEPT DELIBERATELY WITH NO PRODUCTION CALLER (S8 / A3 decision).
 *
 *  - Consumer: the endpoint-wave verification pass, plus `dsavro-decode.test.ts`
 *    against the committed `trending-solana-h24` capture.
 *  - What it buys: `/dex/trending/v6` is the INDEPENDENT ORACLE for the one
 *    model-visible claim `dexscreener__pairs_trending_list` makes about
 *    ordering ("the same ordering as the DexScreener homepage"). That claim is
 *    served from the screener's `trendingScore{TF}` board, so the board cannot
 *    check itself; the trending endpoint re-verified it 4/4 exact, 30/30 rows,
 *    on 2026-08-25. Deleting the table would mean re-deriving the codec from
 *    scratch every time that claim needs re-proving.
 *  - Why it is NOT consumed: every trending field is a strict subset of the
 *    screener row (`tokenIconId` measured identical on 30/30 rows), it is
 *    capped at 30 rows with no pagination, and the two transports are edge
 *    cached ~30 s and were measured disagreeing with each other on marketCap
 *    and priceChange. Consuming it would trade depth and freshness for bytes.
 *  - Removal condition: delete both this table and the `dex_trending.*`
 *    allowlist entries if `dexscreener__pairs_trending_list` ever stops
 *    claiming homepage ordering, or if a trending module is written and this
 *    table becomes its live dependency instead of an oracle.
 */
export const TRENDING_PAIR = dsRecord({
  pairAddress: dsString(),
  baseToken: dsRecord({
    address: dsString(),
    name: dsString(),
    symbol: dsString(),
  }),
  chainId: dsString(),
  priceChange: dsMap(dsOptional(dsDouble())),
  volume: dsMap(dsOptional(dsDouble())),
  liquidity: dsOptional(
    dsRecord({ usd: dsDouble(), base: dsDouble(), quote: dsDouble() })
  ),
  pairCreatedAt: dsOptional(dsDouble()),
  schemaVersion: dsString(),
  profile: dsOptional(PROFILE),
  cmsProfile: dsOptional(CMS_PROFILE),
  isBoostable: dsBoolean(),
  boosts: dsOptional(dsRecord({ active: dsDouble() })),
  marketCap: dsOptional(dsDouble()),
  fdv: dsOptional(dsDouble()),
});

export const TRENDING_V6 = dsArray(TRENDING_PAIR);

export type TrendingPair = DsAvroValue<typeof TRENDING_PAIR>;

/** Every table this module publishes, for the drift and conformance tests. */
export const DSAVRO_SCHEMAS: Readonly<Record<string, DsAvroType<unknown>>> = {
  PL_BARS_RESPONSE,
  TOPMAKERS,
  METAS_ALL,
  METAS_TRENDING,
  TRENDING_V6,
};
