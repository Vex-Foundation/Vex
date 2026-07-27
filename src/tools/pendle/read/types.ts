/**
 * Pendle READ-SURFACE types — the normalized shapes the read validators
 * (`./validation/*`) produce from the hosted Pendle API's documented read
 * endpoints.
 *
 * DELIBERATELY SEPARATE from `tools/pendle/types.ts`. That module types the
 * MONEY path: `PendleMarket` feeds `market-lookup.ts`, which every mutating
 * handler and the prequote identity resolve through, and `PendleAsset` carries
 * the `decimals` / `price.acc` / `baseType` that size and value a trade. Nothing
 * here may widen those. These types exist so read tools can describe markets the
 * money path is not allowed to see (matured ones) and data it never consumes at
 * all (history, candles, order books, merkle rewards) without touching them.
 *
 * CONTRACT for this module:
 *   - No value here is ever consumed financially. Read handlers display it.
 *   - Display fields (names, protocol labels, APYs, USD figures) are TOLERANT:
 *     absent or wrong-typed becomes `null`, never a throw.
 *   - Identity and raw-amount fields are STRICT: addresses must be 40-hex, raw
 *     base-unit amounts must be decimal-digit strings. A row that fails is
 *     dropped by the validator; a body where every row fails RAISES.
 *   - Raw base-unit amounts travel WITHOUT decimals here, because these
 *     endpoints do not carry them. Any consumer that renders one must resolve
 *     decimals from the chain's asset catalogue first (rules/90: "raw amounts
 *     must travel with the decimals needed to read them").
 *   - Free text (market `name`, `protocol`) is carried RAW, exactly as
 *     `tools/pendle/types.ts` does; the `protocols/pendle/trusted-fields.ts`
 *     boundary bounds and sanitizes it before a model sees it.
 *
 * Addresses arrive from the API either bare (`0x…`) or as a `chainId-address`
 * composite (`1-0x…`); validators split the prefix so every address here is a
 * bare LOWERCASE `0x…`.
 */

// ── /v2/markets/all ────────────────────────────────────────────────

/**
 * Display-only market metrics. APYs and ROIs are DECIMAL FRACTIONS as Pendle
 * returns them (0.0228 = 2.28%); USD figures are provider floats. Neither is
 * safe to compute with — they exist to be shown and ranked.
 */
export interface PendleReadMarketDetails {
  liquidityUsd: number | null;
  totalTvlUsd: number | null;
  tradingVolumeUsd: number | null;
  impliedApy: number | null;
  underlyingApy: number | null;
  pendleApy: number | null;
  aggregatedApy: number | null;
  maxBoostedApy: number | null;
  ytFloatingApy: number | null;
  swapFeeApy: number | null;
  feeRate: number | null;
  ptRoi: number | null;
  ytRoi: number | null;
}

/**
 * One row of `/v2/markets/all`, reduced to what a read tool needs to identify,
 * rank and label a market — including a MATURED one, which the mutating
 * resolvers cannot see by design.
 */
export interface PendleReadMarket {
  chainId: number;
  /** Market (LP) contract, bare lowercase 0x. */
  address: string;
  name: string | null;
  /** Provider/issuer label (e.g. "Strata"). Free text. */
  protocol: string | null;
  /** ISO expiry (immutable). */
  expiry: string | null;
  /** Per-leg contracts, bare lowercase 0x. Null when the row omits the leg. */
  pt: string | null;
  yt: string | null;
  sy: string | null;
  underlyingAsset: string | null;
  accountingAsset: string | null;
  details: PendleReadMarketDetails;
  categoryIds: string[];
  isNew: boolean;
  isPrime: boolean;
}

/** One validated page of `/v2/markets/all`. */
export interface PendleReadMarketPage {
  /** Rows the provider says match the filter, across ALL pages. */
  total: number;
  /** Page size the provider actually applied. */
  limit: number;
  /** Offset the provider actually applied. */
  skip: number;
  results: PendleReadMarket[];
}

/**
 * A paginated catalogue read. `complete` is false when the page budget ran out
 * before `total` was reached — an EXPLICIT partial answer. Never treat an
 * incomplete result as "the market does not exist" (rules/90: refuse rather than
 * guess; owner rule: outputs are never silently truncated).
 */
export interface PendleReadMarketCatalog {
  markets: PendleReadMarket[];
  total: number;
  complete: boolean;
  pagesFetched: number;
}

// ── /v1/sdk/{chainId}/markets/{market}/tokens ──────────────────────

/**
 * The token sets a market accepts. Call this before building a convert request:
 * an off-list `tokenOut` is the documented cause of Pendle's
 * "tokenOut must be in the SY token out list" 400 (G-05).
 */
export interface PendleReadMarketTokens {
  tokensMintSy: string[];
  tokensRedeemSy: string[];
  tokensIn: string[];
  tokensOut: string[];
}

// ── /v1/sdk/{chainId}/markets/{market}/swapping-prices ─────────────

/**
 * Pendle's own real-time pre-trade rates. Pendle's docs are explicit that a
 * convert quote is NOT a price oracle and route price reads here instead.
 *
 * A null leg means the provider omitted it — the swap is not currently possible
 * (thin liquidity). It is NOT zero, and must never be rendered as a rate of 0.
 * A MATURED market does not return null legs at all: the endpoint answers
 * HTTP 404 `Given market is expired` (live-verified 2026-07-27), which surfaces
 * as `PENDLE_MARKET_NOT_FOUND` with `httpStatus` 404.
 */
export interface PendleReadSwappingPrices {
  /** Underlying token the rates are quoted against, bare lowercase 0x. */
  underlyingToken: string | null;
  underlyingTokenToPtRate: number | null;
  ptToUnderlyingTokenRate: number | null;
  underlyingTokenToYtRate: number | null;
  ytToUnderlyingTokenRate: number | null;
  /** Decimal fraction (0.0228 = 2.28%). */
  impliedApy: number | null;
}

// ── /v3/{chainId}/markets/{market}/historical-data ─────────────────

/** Series resolution the endpoint accepts. */
export type PendleReadTimeFrame = "hour" | "day" | "week";

/**
 * Selectable history fields, LIVE-VERIFIED one by one on 2026-07-27 (the
 * endpoint answers HTTP 400 `Invalid fields: …` for anything else — `feeRate`,
 * `liquidity`, `ptDiscount` and `yieldRange` were all rejected). Copied from the
 * provider's behaviour, not from its prose.
 */
export const PENDLE_READ_HISTORY_FIELDS = [
  "impliedApy",
  "underlyingApy",
  "maxApy",
  "baseApy",
  "tvl",
  "ptPrice",
  "ytPrice",
  "lpPrice",
  "tradingVolume",
  "pendleApy",
  "aggregatedApy",
  "swapFeeApy",
  "ytFloatingApy",
  "totalPt",
  "totalSy",
  "totalSupply",
  "totalActiveSupply",
] as const;

export type PendleReadHistoryField = (typeof PENDLE_READ_HISTORY_FIELDS)[number];

/**
 * One point of the series. `values` carries only the fields that were REQUESTED
 * and that the provider actually returned for that timestamp — a selected field
 * can legitimately be absent from a row (live: `totalActiveSupply`), which is
 * why the map is partial rather than a fixed record of nulls.
 */
export interface PendleReadMarketHistoryPoint {
  /** ISO timestamp of the bucket. */
  timestamp: string;
  values: Partial<Record<PendleReadHistoryField, number>>;
}

export interface PendleReadMarketHistory {
  /** Points the provider says the window holds. */
  total: number;
  /** ISO window bounds the provider actually applied. */
  timestampStart: string | null;
  timestampEnd: string | null;
  points: PendleReadMarketHistoryPoint[];
}

// ── /v4/{chainId}/prices/{asset}/ohlcv ─────────────────────────────

/**
 * One candle. Prices are quoted in `PendleReadCandles.currency`.
 *
 * `volume` is nullable BY DESIGN: the CSV legitimately carries an empty trailing
 * volume column on candles with no recorded trades, and for LP assets Pendle
 * documents volume as always 0 there (market `tradingVolume` in the history
 * endpoint is the real figure).
 */
export interface PendleReadCandle {
  /** Unix SECONDS, as the CSV carries them. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

/**
 * Parsed candles. The provider ships them as a CSV STRING inside JSON, so this
 * is a bounded parse: at most `PENDLE_READ_MAX_CANDLE_ROWS` rows are decoded and
 * `truncated` says so explicitly rather than dropping the tail in silence.
 */
export interface PendleReadCandles {
  /** Quote currency the provider reported (live: "USD"). */
  currency: string | null;
  timeFrame: PendleReadTimeFrame | null;
  /** Rows the provider says the window holds. */
  total: number;
  candles: PendleReadCandle[];
  truncated: boolean;
}

// ── /v1/prices/assets ──────────────────────────────────────────────

/** Asset classes the endpoint's `type` filter accepts. */
export const PENDLE_READ_ASSET_PRICE_TYPES = ["PENDLE_LP", "SY", "PT", "YT"] as const;

export type PendleReadAssetPriceType = (typeof PENDLE_READ_ASSET_PRICE_TYPES)[number];

/**
 * One priced asset. The provider returns a MAP keyed by the `chainId-address`
 * composite (not an array of rows), which the validator splits into these.
 *
 * `priceUsd` is a spot snapshot Pendle refreshes on the order of 15-60 s — a
 * display figure, never a pre-trade rate (that is `swapping-prices`).
 */
export interface PendleReadAssetPrice {
  chainId: number;
  /** Bare lowercase 0x. */
  address: string;
  priceUsd: number;
}

export interface PendleReadAssetPrices {
  /** Assets the provider says match the filter, across all pages. */
  total: number;
  skip: number;
  prices: PendleReadAssetPrice[];
}

// ── /v1/dashboard/merkle-rewards/{user} ────────────────────────────

/**
 * One merkle-distributed reward accrual.
 *
 * NO CLAIM MATERIAL IS CARRIED HERE, and none is available: the live endpoint
 * returns `{user, token, merkleRoot, chainId, assetId, amount, toTimestamp,
 * fromTimestamp}` with NO `proof` array and NO `verifyCallData`
 * (live-verified 2026-07-27 against a wallet with 7 pending rewards). The
 * provider-side merkle root, and the echoed `user` the caller already knows, are
 * dropped on purpose: this type is amounts and tokens only, so no future card
 * can mistake it for something that could build a claim transaction.
 *
 * `amountRaw` is base units with NO decimals attached — the endpoint does not
 * carry them. Resolve decimals from the chain's asset catalogue before rendering.
 */
export interface PendleReadMerkleReward {
  chainId: number;
  /** Reward token contract, bare lowercase 0x. */
  token: string;
  /** Pendle asset the reward accrued against (`chainId-address` composite, raw). */
  assetId: string | null;
  /** Base-unit amount, decimal digits only. */
  amountRaw: string;
  /** ISO accrual window reported by the provider. */
  fromTimestamp: string | null;
  toTimestamp: string | null;
}

export interface PendleReadMerkleRewards {
  claimable: PendleReadMerkleReward[];
  claimed: PendleReadMerkleReward[];
}

// ── /v2/limit-orders/book/{chainId} ────────────────────────────────

/**
 * One depth level of the limit-order book.
 *
 * Sizes are RAW base-unit strings of the market's PY unit, with no decimals on
 * this endpoint — resolve them from the asset catalogue before rendering.
 * `ammSize` is present only when the request asked for `includeAmm`.
 */
export interface PendleReadOrderbookLevel {
  /** Decimal fraction (0.1052 = 10.52%), rounded to the requested precision. */
  impliedApy: number;
  limitOrderSizeRaw: string;
  ammSizeRaw: string | null;
  incentiveQualifiedPySizeRaw: string | null;
}

/**
 * Merged limit-order (and optionally AMM) depth for one market. A market that is
 * not limit-order whitelisted answers HTTP 404 rather than an empty book
 * (live-verified: the deepest chain-1 market, wstETH, is not whitelisted).
 */
export interface PendleReadOrderbook {
  longYieldEntries: PendleReadOrderbookLevel[];
  shortYieldEntries: PendleReadOrderbookLevel[];
}
