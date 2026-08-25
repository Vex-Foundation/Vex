/**
 * Indexify domain types — validated shapes the client returns.
 *
 * Raw provider rows are FAT (one stack row measured ~3.6 KB, embedding full
 * token objects with categories arrays). The client validates structure but
 * returns rows close to the wire; PROJECTION to agent-sized rows happens in
 * the protocol handlers (`vex-agent/tools/protocols/indexify/handlers/project.ts`),
 * so the provider layer stays a faithful, testable picture of the API.
 *
 * Numeric fields the provider serves as strings (`total_balance`, weights)
 * keep their string form here — converting is presentation, not transport.
 */

import type {
  IndexifyCategory,
  IndexifyLeaderboardPeriod,
  IndexifyLeaderboardSort,
  IndexifyOrderStatus,
  IndexifyStackFeed,
  IndexifyStackSort,
} from "./constants.js";

// ── Stacks ─────────────────────────────────────────────────────────

/** One token inside a stack row (subset the projection reads; wire-shaped). */
export interface IndexifyStackToken {
  address: string;
  symbol: string;
  name: string;
  decimals?: number;
  price?: number | null;
  market_cap?: number | string | null;
  image_url?: string | null;
  is_verified?: boolean | number;
}

/** One stack row from `stack_info.php` list/fetch/trending/official. Wire-shaped. */
export interface IndexifyStack {
  id: number;
  stack_name: string;
  slug: string;
  description?: string | null;
  category?: string | null;
  creator_fee?: number | null;
  price?: number | null;
  weighted_market_cap?: number | null;
  market_volume_24h?: number | null;
  platform_volume_total?: number | null;
  tvl?: number | null;
  change4H?: number | null;
  change1D?: number | null;
  change1W?: number | null;
  change1M?: number | null;
  changeAll?: number | null;
  is_company_stack?: boolean;
  is_verified?: boolean;
  archived?: boolean;
  is_closed?: boolean;
  time_p?: number | null;
  current_allocation_version?: number | null;
  /** Parallel to `tokens`; integer percents as strings. */
  token_weights?: readonly string[] | null;
  tokens?: readonly IndexifyStackToken[];
  user?: { username?: string | null } | null;
  user_is_holding?: boolean;
  user_is_creator?: boolean;
}

export interface IndexifyStackListParams {
  feed: IndexifyStackFeed;
  limit: number;
  offset: number;
  sort?: IndexifyStackSort;
  order?: "ASC" | "DESC";
  minMarketCapUsd?: number;
  maxMarketCapUsd?: number;
  /** Restrict to stacks created by these usernames. */
  usernames?: readonly string[];
}

export interface IndexifyStackFetchParams {
  slug?: string;
  stackId?: number;
}

// ── Search ─────────────────────────────────────────────────────────

/** One row from `search.php` simple mode (stack-name search). */
export interface IndexifySearchRow {
  stack_name: string;
  stack_id: number;
  slug: string;
  description_truncated?: string | null;
}

// ── Tokens ─────────────────────────────────────────────────────────

/** One row from `token_info.php?action=search`. */
export interface IndexifyTokenRow {
  name: string;
  address: string;
  symbol: string;
  icon?: string | null;
  is_verified?: boolean | number;
}

// ── Creators ───────────────────────────────────────────────────────

export interface IndexifyLeaderboardRow {
  username: string;
  rank?: number;
  points?: number | null;
  combined_pnl?: number | null;
  stacks_created?: number | null;
  stack_trades?: number | null;
  follower_count?: number | null;
}

export interface IndexifyLeaderboardParams {
  period: IndexifyLeaderboardPeriod;
  sortBy: IndexifyLeaderboardSort;
  limit: number;
  offset: number;
}

export interface IndexifyPublicProfile {
  username: string;
  bio?: string | null;
  created_at?: string | null;
  twitter?: string | null;
  telegram?: string | null;
}

export interface IndexifyProfileMetrics {
  best_stack_ath?: number | null;
  hit_rate?: number | null;
  combined_pnl?: number | null;
  followers?: number | null;
  stack_count?: number | null;
  points?: number | null;
}

// ── Account / portfolio ────────────────────────────────────────────

export interface IndexifyPortfolio {
  /** Spendable USDC (human units). */
  usdcBalance: number;
  /** USDC reserved by in-flight orders (undocumented field, measured live). */
  usdcReserved: number;
  /** Total portfolio value in USDC, as the provider's decimal string. */
  totalBalanceUsdc: string;
  /** The account's Indexify-embedded Solana wallet address. */
  walletAddress: string;
}

export interface IndexifyHoldings {
  stack_id: number;
  total_usdc: number;
  total_invested: number;
  total_cost_basis: number;
  amounts: readonly unknown[];
  pnl: {
    profit_loss?: number | null;
    realized_pnl?: number | null;
    unrealized_pnl?: number | null;
    profit_loss_percent?: number | null;
    unrealized_pnl_percent?: number | null;
  };
}

// ── Orders / history ───────────────────────────────────────────────

export interface IndexifyOrderSummary {
  order_id: string;
  stack_id?: number | null;
  type?: string | null;
  status: IndexifyOrderStatus | string;
  created_at?: string | null;
  parent_order_id?: string | null;
  retry_attempt?: number | null;
  partial_completion_action?: string | null;
  stack_name?: string | null;
}

export interface IndexifyPagination {
  offset?: number;
  limit?: number;
  total_count?: number;
  has_more?: boolean;
  page?: number;
  total_pages?: number;
}

export interface IndexifyOrdersPage {
  orders: readonly IndexifyOrderSummary[];
  pagination?: IndexifyPagination;
}

/** `orders.php?action=details` — order plus its on-chain transactions. */
export interface IndexifyOrderDetails {
  order: {
    order_id: string;
    status: string;
    type?: string | null;
    created_at?: string | null;
    partial_completion_action?: string | null;
  };
  transactions: readonly { order_id?: string; success?: boolean; txn_hash?: string | null }[];
  transaction_count?: number;
}

/** `orders.php?action=partial_details` — what filled and what failed. */
export interface IndexifyPartialDetails {
  order_id: string;
  order_info?: Record<string, unknown>;
  stack_info?: { id?: number; stack_name?: string; slug?: string };
  successful_tokens: readonly Record<string, unknown>[];
  failed_tokens: readonly Record<string, unknown>[];
  summary?: {
    total_tokens_in_stack?: number;
    successful_token_count?: number;
    failed_token_count?: number;
    success_rate?: number;
  };
  available_actions?: { acknowledge?: boolean; retry?: boolean; sell_all?: boolean };
}

export interface IndexifyHistoryRow {
  order_id: string;
  stack_id?: number | null;
  transaction_type?: string | null;
  status?: string | null;
  usdc_amount?: number | null;
  sell_percentage?: number | null;
  creator_fee?: number | null;
  platform_fee?: number | null;
  created_at?: string | null;
  transaction_hash?: string | null;
  asset?: { type?: string; name?: string; slug?: string | null; symbol?: string | null } | null;
}

export interface IndexifyHistoryPage {
  transactions: readonly IndexifyHistoryRow[];
  pagination?: IndexifyPagination;
}

export interface IndexifyHistorySummary {
  summary: Record<string, number | undefined>;
}

export interface IndexifyHistoryParams {
  limit: number;
  offset: number;
  status?: IndexifyOrderStatus;
  stackId?: number;
}

// ── Fees ───────────────────────────────────────────────────────────

export interface IndexifyFeeCalculation {
  fee_display?: string | null;
  estimated_blockchain_fees_saved?: string | null;
  total_fee_display?: string | null;
}

export interface IndexifyFeeBounds {
  min: number;
  max: number;
  default: number;
}

// ── Mutations ──────────────────────────────────────────────────────

export interface IndexifySwapParams {
  stackId: number;
  /** buy: USDC to spend (human units). sell: percent of holdings 1–100. */
  amount: number;
  cue: "fromUSDC" | "toUSDC";
}

export interface IndexifySwapResult {
  order_id: string;
}

export interface IndexifyRetryResult {
  order_id: string;
  stack_id?: number;
  parent_order_id?: string;
  retry_attempt?: number;
  status?: string;
}

export interface IndexifyCreateStackParams {
  stackName: string;
  /** Map of token mint address → integer percent weight; must sum to 100. */
  stackTokenInfo: Readonly<Record<string, number>>;
  creatorFee: number;
  description: string;
  category: IndexifyCategory;
  socialLinks: Readonly<Record<string, string>>;
  showCreatorHoldings?: boolean;
}

export interface IndexifyCreateStackResult {
  success: boolean;
  stack_id: number;
}
