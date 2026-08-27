/**
 * Indexify constants — the Solana social-index ("stacks") platform.
 *
 * Indexify is a CUSTODIAL API venue: trades execute server-side against the
 * account's Indexify-embedded wallet, authorized by an `ix_` API key alone.
 * Nothing in this module ever sees a private key and no Vex wallet signs
 * anything on this venue — which is exactly why the exposure policy below is
 * structural rather than advisory.
 *
 * EXPOSURE POLICY (teardown 2026-08-26, docs 0.1.12-beta): the following
 * documented actions are NEVER wrapped by this client, so no handler can be
 * miswired into calling them —
 *   - `txn.php?action=export_key`      (returns the raw private key)
 *   - `txn.php?action=withdraw_usdc`   (moves funds to an arbitrary address)
 *   - `user_info.php?action=delete_account` (irreversible; response leaks the key)
 *   - every profile / social / notification write
 * Measured live defects the client works around:
 *   - `txn.php?action=balance` is documented but answers `{"error":"Invalid
 *     action"}` — per-mint balances are NOT available, so no method exists.
 *   - `deanon.php` is documented but not deployed (web-server 404).
 *   - `stack_info.php?action=trending` requires `limit` AND `offset` together
 *     despite both being documented optional; the client always sends both.
 */

/** ENV var holding the account's `ix_` API key. Gates every authenticated tool. */
export const INDEXIFY_API_KEY_ENV = "INDEXIFY_API_KEY";

/** Header the key travels in. Never logged, never echoed into errors. */
export const INDEXIFY_API_KEY_HEADER = "X-API-KEY";

/** The chain slug every Indexify row lives on. The venue is Solana-only. */
export const INDEXIFY_CHAIN_SLUG = "solana";

/**
 * Web app origin — stack pages live at `${INDEXIFY_APP_URL}/stacks/<slug>`
 * (plural `stacks`; the singular path 404s, probed live 2026-08-26).
 */
export const INDEXIFY_APP_URL = "https://app.indexify.finance";

/** Build the shareable web link for one stack. */
export function indexifyStackUrl(slug: string): string {
  return `${INDEXIFY_APP_URL}/stacks/${encodeURIComponent(slug)}`;
}

// ── Endpoints (path only; `?action=` is appended by the client) ────

export const INDEXIFY_ENDPOINTS = {
  stackInfo: "/api/stack_info.php",
  tokenInfo: "/api/token_info.php",
  tokenTrading: "/api/token_trading.php",
  search: "/api/search.php",
  txn: "/api/txn.php",
  orders: "/api/orders.php",
  userOrders: "/api/user_orders.php",
  transactionHistory: "/api/transaction_history.php",
  fee: "/api/fee.php",
  userInfo: "/api/user_info.php",
  bulkStackStats: "/api/bulk_stack_stats.php",
} as const;

// ── Bounds ─────────────────────────────────────────────────────────

/**
 * Hard cap on stack rows one list call returns. Measured 2026-08-26: one raw
 * stack row is ~3.6 KB (every row embeds its full token objects), so provider
 * defaults would blow the tool-output budget. Rows are PROJECTED before they
 * leave a handler, and this cap bounds the projected list too.
 */
export const INDEXIFY_LIST_LIMIT_CAP = 25;

/** Default rows per list call when the caller does not say. */
export const INDEXIFY_LIST_LIMIT_DEFAULT = 10;

/** Cap on order / history rows per call (provider max is 100; rows are lean). */
export const INDEXIFY_HISTORY_LIMIT_CAP = 50;

/** Default order / history rows per call. */
export const INDEXIFY_HISTORY_LIMIT_DEFAULT = 10;

/** Max tokens one stack may hold (provider rule, stated in the create docs). */
export const INDEXIFY_MAX_STACK_TOKENS = 12;

/** Weights in `stackTokenInfo` are integer percents and must sum to exactly this. */
export const INDEXIFY_WEIGHT_SUM = 100;

// ── Enums (provider vocabularies, captured from docs 0.1.12-beta) ──

/** Which provider feed fills the shared stack-row shape. */
export const INDEXIFY_STACK_FEEDS = ["all", "trending", "official"] as const;
export type IndexifyStackFeed = (typeof INDEXIFY_STACK_FEEDS)[number];

/** Ranking keys `stack_info.php?action=paginated_list` accepts. */
export const INDEXIFY_STACK_SORTS = [
  "change4H", "change1D", "change1W", "change1M", "changeAll",
  "newest", "oldest", "price", "mcap",
] as const;
export type IndexifyStackSort = (typeof INDEXIFY_STACK_SORTS)[number];

/** Risk/duration categories a stack is created under. */
export const INDEXIFY_CATEGORIES = [
  "high_risk_short", "high_risk_long",
  "medium_risk_short", "medium_risk_long",
  "low_risk_short", "low_risk_long",
] as const;
export type IndexifyCategory = (typeof INDEXIFY_CATEGORIES)[number];

/** Leaderboard ranking windows. */
export const INDEXIFY_LEADERBOARD_PERIODS = ["4h", "7d", "30d", "3m", "all", "ath"] as const;
export type IndexifyLeaderboardPeriod = (typeof INDEXIFY_LEADERBOARD_PERIODS)[number];

/** Leaderboard ranking keys. */
export const INDEXIFY_LEADERBOARD_SORTS = [
  "points", "pnl", "stacks_created", "last_activity", "stack_trades", "hit_rate", "best_stack_ath",
] as const;
export type IndexifyLeaderboardSort = (typeof INDEXIFY_LEADERBOARD_SORTS)[number];

/** Order lifecycle statuses the trading endpoints report. */
export const INDEXIFY_ORDER_STATUSES = ["PENDING", "PROCESSING", "SUCCESS", "FAILED", "PARTIAL"] as const;
export type IndexifyOrderStatus = (typeof INDEXIFY_ORDER_STATUSES)[number];

/** How a PARTIAL order may be resolved. */
export const INDEXIFY_PARTIAL_RESOLUTIONS = ["acknowledge", "retry", "sell_all"] as const;
export type IndexifyPartialResolution = (typeof INDEXIFY_PARTIAL_RESOLUTIONS)[number];

/** Trade directions. `fromUSDC` = buy with USDC; `toUSDC` = sell a % of holdings. */
export const INDEXIFY_TRADE_DIRECTIONS = ["buy", "sell"] as const;
export type IndexifyTradeDirection = (typeof INDEXIFY_TRADE_DIRECTIONS)[number];

/** Provider spelling of the two directions on `txn.php?action=swap`. */
export const INDEXIFY_TRADE_CUES: Record<IndexifyTradeDirection, "fromUSDC" | "toUSDC"> = {
  buy: "fromUSDC",
  sell: "toUSDC",
};
