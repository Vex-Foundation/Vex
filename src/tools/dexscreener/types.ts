/**
 * DexScreener API type definitions.
 *
 * Covers REST responses and WebSocket handshake shapes.
 * All fields mirror the official OpenAPI spec at https://docs.dexscreener.com/api/reference
 */

// ── Pair (core schema, used across most endpoints) ──────────────────

export interface DexToken {
  address: string;
  name: string;
  symbol: string;
}

export interface DexQuoteToken {
  address: string | null;
  name: string | null;
  symbol: string | null;
}

export interface DexTxnCounts {
  buys: number;
  sells: number;
}

export interface DexLiquidity {
  usd: number | null;
  base: number;
  quote: number;
}

export interface DexPairInfo {
  imageUrl: string | null;
  websites: Array<{ url: string }> | null;
  socials: Array<{ platform: string; handle: string }> | null;
}

export interface DexBoosts {
  active: number;
}

export interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  labels: string[] | null;
  baseToken: DexToken;
  quoteToken: DexQuoteToken;
  priceNative: string;
  priceUsd: string | null;
  txns: Record<string, DexTxnCounts>;
  volume: Record<string, number>;
  priceChange: Record<string, number> | null;
  liquidity: DexLiquidity | null;
  fdv: number | null;
  marketCap: number | null;
  pairCreatedAt: number | null;
  info: DexPairInfo | null;
  boosts: DexBoosts | null;
}

// ── Response wrappers ───────────────────────────────────────────────

export interface PairsResponse {
  schemaVersion: string;
  pairs: DexPair[] | null;
}

export interface SearchResponse {
  schemaVersion: string;
  pairs: DexPair[];
}

// TokensResponse and TokensPairsResponse are bare arrays of DexPair
export type TokensResponse = DexPair[];
export type TokensPairsResponse = DexPair[];

// ── Token Profiles ──────────────────────────────────────────────────

export interface DexLink {
  type: string | null;
  label: string | null;
  url: string;
}

export interface DexTokenProfile {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon: string;
  header: string | null;
  description: string | null;
  links: DexLink[] | null;
}

// ── Token Boosts ────────────────────────────────────────────────────
//
// ONE tolerant row shape serves BOTH boost endpoints. They disagree about
// `amount` — `/token-boosts/latest/v1` sends it on 30/30 rows,
// `/token-boosts/top/v1` on 0/30 (live-verified 2026-07-27, captures in
// `__tests__/dexscreener/fixtures/live-captures/`). Requiring it killed
// `dexscreener.boosts.top` on every call for months.
//
// Two per-endpoint schemas were considered and rejected: the amounts are
// display-only promotional credits (Vex never spends or prices them), so the
// tolerant-reader rule applies to both; the WS layer already treats `boosts`
// and `boosts-top` as one row type through `parseBoost`; and pinning each
// endpoint's CURRENT field set is precisely the mistake that caused this
// outage — it would simply re-arm on whichever side drifts next.

export interface DexBoost {
  url: string;
  chainId: string;
  tokenAddress: string;
  /**
   * Boost units bought in the most recent purchase. Display-only.
   * `null` = the endpoint did not send the field (always the case on
   * `top/v1`), which is NOT the same as a boost of zero.
   */
  amount: number | null;
  /** Cumulative boost units currently active. Display-only, same null rule. */
  totalAmount: number | null;
  icon: string | null;
  header: string | null;
  description: string | null;
  links: DexLink[] | null;
}

/**
 * A boost feed plus the number of rows dropped because they did not parse.
 * A malformed row is skipped and COUNTED rather than throwing the whole feed
 * away — but the count is surfaced, so a silently-degraded feed is impossible
 * to mistake for a healthy one.
 */
export interface DexBoostFeed {
  boosts: DexBoost[];
  skipped: number;
}

// ── Orders ──────────────────────────────────────────────────────────
//
// `/orders/v1/{chainId}/{tokenAddress}` returns an OBJECT — `{orders, boosts}`
// — not an array (live-verified 2026-07-27). The sibling `boosts` array is the
// boost-payment ledger for the same token.

/** Order types observed live. NOT enforced as a closed set — see `DexOrder.type`. */
export type DexOrderType = "tokenProfile" | "communityTakeover" | "tokenAd" | "trendingBarAd";
/** Order statuses documented by DexScreener. NOT enforced — see `DexOrder.status`. */
export type DexOrderStatus = "processing" | "cancelled" | "on-hold" | "approved" | "rejected";

export interface DexOrder {
  chainId: string;
  tokenAddress: string;
  /**
   * Kept as `string`, not `DexOrderType`. DexScreener adds promotional
   * products, and a membership check would throw on the first new one — the
   * same failure class this module was just repaired for. The union above
   * documents the vocabulary; the value is echoed to the agent, never branched
   * on. (The previous code claimed `DexOrderType` while casting any string to
   * it, so the type was already fiction; this makes it honest, not looser.)
   */
  type: string;
  /** Same reasoning as `type`. See `DexOrderStatus` for the documented set. */
  status: string;
  /**
   * Unix epoch MILLISECONDS — 13 digits, e.g. `1785076668204` = 2026-07-26.
   * The unit is in the NAME because getting it wrong is silent: read as
   * seconds this lands in the year ~58,000. `DexScreener.md` claimed seconds
   * and prescribed `×1000` until 2026-07-27; it did not survive a live check.
   */
  paymentTimestampMs: number | null;
}

/**
 * One boost PURCHASE from the `/orders/v1` sibling ledger — a payment event,
 * distinct from `DexBoost` (a row in the boost RANKING feed) and carrying a
 * different field set.
 */
export interface DexBoostPayment {
  chainId: string;
  tokenAddress: string;
  /** Opaque DexScreener payment id. */
  id: string | null;
  /** Boost units bought in this purchase. Display-only. */
  amount: number | null;
  /** Unix epoch MILLISECONDS — see `DexOrder.paymentTimestampMs`. */
  paymentTimestampMs: number | null;
}

/** The full `/orders/v1` envelope: paid orders, the boost ledger, and drop counts. */
export interface DexOrdersResponse {
  orders: DexOrder[];
  boostPayments: DexBoostPayment[];
  /** Order rows dropped because they did not parse. */
  skippedOrders: number;
  /** Ledger rows dropped because they did not parse. */
  skippedBoostPayments: number;
}

// ── Community Takeovers ─────────────────────────────────────────────

export interface DexCommunityTakeover {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon: string;
  header: string | null;
  description: string | null;
  links: DexLink[] | null;
  claimDate: string;
}

// ── Ads ─────────────────────────────────────────────────────────────

export interface DexAd {
  url: string;
  chainId: string;
  tokenAddress: string;
  date: string;
  type: string;
  durationHours: number | null;
  impressions: number | null;
}

// ── Trending (combined profiles + boosts) ───────────────────────────

export interface DexTrendingItem {
  chainId: string;
  tokenAddress: string;
  url: string | null;
  icon: string | null;
  header: string | null;
  description: string | null;
  links: DexLink[] | null;
  /**
   * Boost units from the merged boost feed. `null` = the feed did not report
   * the field; `0` = the token has no boost. The two are NOT collapsed — a
   * missing measurement and a measured zero are different facts.
   */
  boostAmount: number | null;
  boostTotalAmount: number | null;
  hasProfile: boolean;
}

// ── Metas / narratives (live, undocumented API surface) ─────────────
//
// `GET /metas/trending/v1` returns trending NARRATIVES (themes/categories such
// as "knockoff-legends", "ai", "dog"), NOT individual tokens. `GET
// /metas/meta/v1/{slug}` returns one narrative plus the DEX pairs inside it.
// These endpoints are live-verified but absent from the official reference, so
// every field is nullable and parsers are tolerant (see `validation/metas.ts`).

export interface DexMetaIcon {
  type: string | null;
  value: string | null;
}

/** Change/delta windows keyed by timeframe (percent for change, absolute USD for delta). */
export interface DexMetaWindows {
  m5: number | null;
  h1: number | null;
  h6: number | null;
  h24: number | null;
}

export interface DexMeta {
  slug: string | null;
  name: string | null;
  description: string | null;
  icon: DexMetaIcon | null;
  marketCap: number | null;
  liquidity: number | null;
  volume: number | null;
  tokenCount: number | null;
  marketCapChange: DexMetaWindows | null;
  marketCapDelta: DexMetaWindows | null;
}

/** One narrative plus the DEX pairs indexed under it. */
export interface DexMetaDetail extends DexMeta {
  pairs: DexPair[];
}

// ── Token profile updates (recent-updates feed, live/undocumented) ──
//
// `GET /token-profiles/recent-updates/v1` — profile-shaped rows enriched with
// `updatedAt` (ISO 8601) and a `cto` flag. Superset of `DexTokenProfile`.

export interface DexProfileUpdate extends DexTokenProfile {
  updatedAt: string | null;
  cto: boolean | null;
}

// ── WebSocket handshake ─────────────────────────────────────────────

export interface WsHandshake<T> {
  limit: number;
  data: T[];
}

export type DexStreamChannel = "profiles" | "boosts" | "boosts-top" | "community-takeovers" | "ads";
