/**
 * Zod response validators for the Indexify API.
 *
 * Same tolerant-reader split as the pools.fun validators (rule 90): IDENTITY is
 * strict — a row without a numeric stack id, a slug, or a plausible order id
 * throws INDEXIFY_INVALID_RESPONSE naming the path — while DISPLAY fields
 * (prices, changes, descriptions) coerce missing/null/non-finite to `null` and
 * never take a page of rows down. The provider publishes docs but no schema
 * guarantee, and live drift is already measured (three defects on 2026-08-26),
 * so tolerance on display fields is load-bearing, not politeness.
 *
 * `.loose()` on row objects: the wire rows carry dozens of extra fields
 * (measured: 44 keys on one stack row) that handlers project away; stripping
 * them here would force a re-measure every time the provider adds one.
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../errors.js";
import type {
  IndexifyCreateStackResult,
  IndexifyEditAllocationResult,
  IndexifyVersionHistory,
  IndexifyFeeBounds,
  IndexifyFeeCalculation,
  IndexifyHistoryPage,
  IndexifyHistorySummary,
  IndexifyHoldings,
  IndexifyLeaderboardRow,
  IndexifyOrderDetails,
  IndexifyOrdersPage,
  IndexifyPartialDetails,
  IndexifyProfileMetrics,
  IndexifyPublicProfile,
  IndexifySearchRow,
  IndexifyStack,
  IndexifySwapResult,
  IndexifyRetryResult,
  IndexifyTokenRow,
} from "./types.js";

/** Parse or throw INDEXIFY_INVALID_RESPONSE naming the first broken path. */
export function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path.join(".") || "<root>";
  const message = issue?.message ?? "unknown";
  throw new VexError(
    ErrorCodes.INDEXIFY_INVALID_RESPONSE,
    `Invalid Indexify response at ${path}: ${message}`,
    "The Indexify API returned an unexpected response shape.",
  );
}

// ── Primitives ─────────────────────────────────────────────────────

/** Tolerant string: absent/null → null. */
const displayString = z.string().nullish().transform((v) => v ?? null);

/** Tolerant number: absent/null/non-finite → null. */
const displayNumber = z
  .number()
  .nullish()
  .transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));

/** Tolerant boolean that the provider sometimes spells 0/1. */
const displayBool = z
  .union([z.boolean(), z.number()])
  .nullish()
  .transform((v) => (v === null || v === undefined ? undefined : Boolean(v)));

/** Solana mint/account address: base58, 32–44 chars. Identity — strict. */
const solanaAddress = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, { error: "expected a Solana base58 address" });

// ── Stacks ─────────────────────────────────────────────────────────

const stackToken = z
  .object({
    address: solanaAddress,
    symbol: z.string(),
    name: z.string(),
    decimals: z.number().int().optional(),
    price: displayNumber,
    image_url: displayString,
    is_verified: displayBool,
  })
  .loose();

const stackRow = z
  .object({
    id: z.number().int(),
    stack_name: z.string(),
    slug: z.string().min(1),
    description: displayString,
    category: displayString,
    creator_fee: displayNumber,
    price: displayNumber,
    weighted_market_cap: displayNumber,
    market_volume_24h: displayNumber,
    platform_volume_total: displayNumber,
    tvl: displayNumber,
    change4H: displayNumber,
    change1D: displayNumber,
    change1W: displayNumber,
    change1M: displayNumber,
    changeAll: displayNumber,
    is_company_stack: displayBool,
    is_verified: displayBool,
    archived: displayBool,
    is_closed: displayBool,
    time_p: displayNumber,
    current_allocation_version: displayNumber,
    token_weights: z.array(z.string()).nullish(),
    tokens: z.array(stackToken).optional(),
    user: z.object({ username: displayString }).loose().nullish(),
    user_is_holding: displayBool,
    user_is_creator: displayBool,
  })
  .loose();

const stackArray = z.array(stackRow);

/** `paginated_list` wraps rows in `{data, pagination}`; the other feeds return bare arrays. */
const paginatedStacks = z.object({ data: stackArray }).loose();

export function validateStackArray(raw: unknown): IndexifyStack[] {
  return parseOrThrow(stackArray, raw) as IndexifyStack[];
}

export function validatePaginatedStacks(raw: unknown): IndexifyStack[] {
  return parseOrThrow(paginatedStacks, raw).data as IndexifyStack[];
}

// ── Search / tokens ────────────────────────────────────────────────

const searchRow = z
  .object({
    stack_name: z.string(),
    stack_id: z.number().int(),
    slug: z.string().min(1),
    description_truncated: displayString,
  })
  .loose();

export function validateSearchRows(raw: unknown): IndexifySearchRow[] {
  return parseOrThrow(z.array(searchRow), raw);
}

const tokenRow = z
  .object({
    name: z.string(),
    address: solanaAddress,
    symbol: z.string(),
    icon: displayString,
    is_verified: displayBool,
  })
  .loose();

export function validateTokenRows(raw: unknown): IndexifyTokenRow[] {
  return parseOrThrow(z.array(tokenRow), raw);
}

// ── Creators ───────────────────────────────────────────────────────

const leaderboardRow = z
  .object({
    username: z.string().min(1),
    rank: z.number().int().optional(),
    points: displayNumber,
    combined_pnl: displayNumber,
    stacks_created: displayNumber,
    stack_trades: displayNumber,
    follower_count: displayNumber,
  })
  .loose();

const leaderboardPage = z.object({ creators: z.array(leaderboardRow) }).loose();

export function validateLeaderboard(raw: unknown): IndexifyLeaderboardRow[] {
  return parseOrThrow(leaderboardPage, raw).creators as IndexifyLeaderboardRow[];
}

const publicProfile = z
  .object({
    username: z.string().min(1),
    bio: displayString,
    // Docs say string; the wire serves a unix-seconds NUMBER (measured live).
    created_at: z
      .union([z.string(), z.number()])
      .nullish()
      .transform((v) => (v === null || v === undefined ? null : String(v))),
    twitter: displayString,
    telegram: displayString,
  })
  .loose();

export function validatePublicProfile(raw: unknown): IndexifyPublicProfile {
  return parseOrThrow(publicProfile, raw) as IndexifyPublicProfile;
}

const profileMetrics = z
  .object({
    best_stack_ath: displayNumber,
    hit_rate: displayNumber,
    combined_pnl: displayNumber,
    followers: displayNumber,
    stack_count: displayNumber,
    points: displayNumber,
  })
  .loose();

export function validateProfileMetrics(raw: unknown): IndexifyProfileMetrics {
  return parseOrThrow(profileMetrics, raw) as IndexifyProfileMetrics;
}

// ── Account ────────────────────────────────────────────────────────

const usdcBalance = z.object({ balance: z.number(), reserved: z.number().optional() }).loose();
const totalBalance = z.object({ total_balance: z.union([z.string(), z.number()]) }).loose();
const walletAddress = z.object({ pubkey: solanaAddress }).loose();

export function validateUsdcBalance(raw: unknown): { balance: number; reserved: number } {
  const parsed = parseOrThrow(usdcBalance, raw);
  return { balance: parsed.balance, reserved: parsed.reserved ?? 0 };
}

export function validateTotalBalance(raw: unknown): string {
  return String(parseOrThrow(totalBalance, raw).total_balance);
}

export function validateWalletAddress(raw: unknown): string {
  return parseOrThrow(walletAddress, raw).pubkey;
}

const holdings = z
  .object({
    stack_id: z.number().int(),
    total_usdc: z.number(),
    total_invested: z.number(),
    total_cost_basis: z.number(),
    amounts: z.array(z.unknown()),
    pnl: z
      .object({
        profit_loss: displayNumber,
        realized_pnl: displayNumber,
        unrealized_pnl: displayNumber,
        profit_loss_percent: displayNumber,
        unrealized_pnl_percent: displayNumber,
      })
      .loose(),
  })
  .loose();

export function validateHoldings(raw: unknown): IndexifyHoldings {
  return parseOrThrow(holdings, raw) as IndexifyHoldings;
}

// ── Orders / history ───────────────────────────────────────────────

const pagination = z
  .object({
    offset: z.number().optional(),
    limit: z.number().optional(),
    total_count: z.number().optional(),
    has_more: z.boolean().optional(),
    page: z.number().optional(),
    total_pages: z.number().optional(),
  })
  .loose();

const orderSummary = z
  .object({
    order_id: z.string().min(1),
    stack_id: displayNumber,
    type: displayString,
    status: z.string(),
    created_at: displayString,
    parent_order_id: displayString,
    retry_attempt: displayNumber,
    partial_completion_action: displayString,
    stack_name: displayString,
  })
  .loose();

const ordersPage = z.object({ orders: z.array(orderSummary), pagination: pagination.optional() }).loose();

export function validateOrdersPage(raw: unknown): IndexifyOrdersPage {
  return parseOrThrow(ordersPage, raw) as IndexifyOrdersPage;
}

const orderDetails = z
  .object({
    order: z
      .object({
        order_id: z.string().min(1),
        status: z.string(),
        type: displayString,
        created_at: displayString,
        partial_completion_action: displayString,
      })
      .loose(),
    transactions: z.array(
      z.object({ order_id: z.string().optional(), success: z.boolean().optional(), txn_hash: displayString }).loose(),
    ),
    transaction_count: z.number().optional(),
  })
  .loose();

export function validateOrderDetails(raw: unknown): IndexifyOrderDetails {
  return parseOrThrow(orderDetails, raw) as IndexifyOrderDetails;
}

const partialDetails = z
  .object({
    order_id: z.string().min(1),
    order_info: z.record(z.string(), z.unknown()).optional(),
    stack_info: z
      .object({ id: z.number().optional(), stack_name: z.string().optional(), slug: z.string().optional() })
      .loose()
      .optional(),
    successful_tokens: z.array(z.record(z.string(), z.unknown())),
    failed_tokens: z.array(z.record(z.string(), z.unknown())),
    summary: z
      .object({
        total_tokens_in_stack: z.number().optional(),
        successful_token_count: z.number().optional(),
        failed_token_count: z.number().optional(),
        success_rate: z.number().optional(),
      })
      .loose()
      .optional(),
    available_actions: z
      .object({
        acknowledge: z.boolean().optional(),
        retry: z.boolean().optional(),
        sell_all: z.boolean().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export function validatePartialDetails(raw: unknown): IndexifyPartialDetails {
  return parseOrThrow(partialDetails, raw) as IndexifyPartialDetails;
}

const historyRow = z
  .object({
    order_id: z.string().min(1),
    stack_id: displayNumber,
    transaction_type: displayString,
    status: displayString,
    usdc_amount: displayNumber,
    sell_percentage: displayNumber,
    creator_fee: displayNumber,
    platform_fee: displayNumber,
    created_at: displayString,
    transaction_hash: displayString,
    asset: z
      .object({
        type: z.string().optional(),
        name: z.string().optional(),
        slug: displayString,
        symbol: displayString,
      })
      .loose()
      .nullish(),
  })
  .loose();

const historyPage = z.object({ transactions: z.array(historyRow), pagination: pagination.optional() }).loose();

export function validateHistoryPage(raw: unknown): IndexifyHistoryPage {
  return parseOrThrow(historyPage, raw) as IndexifyHistoryPage;
}

const historySummary = z.object({ summary: z.record(z.string(), z.number().optional()) }).loose();

export function validateHistorySummary(raw: unknown): IndexifyHistorySummary {
  return parseOrThrow(historySummary, raw) as IndexifyHistorySummary;
}

// ── Fees ───────────────────────────────────────────────────────────

const feeCalculation = z
  .object({
    fee_display: displayString,
    estimated_blockchain_fees_saved: displayString,
    total_fee_display: displayString,
  })
  .loose();

export function validateFeeCalculation(raw: unknown): IndexifyFeeCalculation {
  return parseOrThrow(feeCalculation, raw) as IndexifyFeeCalculation;
}

const minBuy = z.object({ min_buy: z.number() }).loose();

/**
 * `min_buy` in HUMAN USDC. The docs claim micro-USDC, but the live value is `5`
 * beside a documented $5 minimum — served human, another docs-vs-wire defect.
 */
export function validateMinBuy(raw: unknown): number {
  return parseOrThrow(minBuy, raw).min_buy;
}

const feeBounds = z.object({ min: z.number(), max: z.number(), default: z.number() }).loose();

export function validateFeeBounds(raw: unknown): IndexifyFeeBounds {
  return parseOrThrow(feeBounds, raw) as IndexifyFeeBounds;
}

// ── Mutations ──────────────────────────────────────────────────────

const swapResult = z.object({ order_id: z.string().min(1) }).loose();

export function validateSwapResult(raw: unknown): IndexifySwapResult {
  return parseOrThrow(swapResult, raw);
}

const retryResult = z
  .object({
    order_id: z.string().min(1),
    stack_id: z.number().optional(),
    parent_order_id: z.string().optional(),
    retry_attempt: z.number().optional(),
    status: z.string().optional(),
  })
  .loose();

export function validateRetryResult(raw: unknown): IndexifyRetryResult {
  return parseOrThrow(retryResult, raw);
}

const nameCheck = z.object({ status: z.enum(["OK", "TAKEN", "BADWORD", "INVALID"]) }).loose();

export function validateNameCheck(raw: unknown): "OK" | "TAKEN" | "BADWORD" | "INVALID" {
  return parseOrThrow(nameCheck, raw).status;
}

const descriptionCheck = z.object({ status: z.enum(["OK", "BADWORD", "INVALID"]) }).loose();

export function validateDescriptionCheck(raw: unknown): "OK" | "BADWORD" | "INVALID" {
  return parseOrThrow(descriptionCheck, raw).status;
}

const createStack = z.object({ success: z.boolean(), stack_id: z.number().int() }).loose();

export function validateCreateStack(raw: unknown): IndexifyCreateStackResult {
  return parseOrThrow(createStack, raw);
}

// ── Allocation sync (Z500 workflow surface) ────────────────────────

const versionAllocation = z
  .object({
    address: solanaAddress,
    // Weight arrives as a NUMBER here (measured live on version_history),
    // unlike the stack row's parallel string array — both are integers.
    weight: z.number(),
    symbol: displayString,
    name: displayString,
  })
  .loose();

const allocationVersion = z
  .object({
    version: z.number().int(),
    is_current: z.boolean().optional(),
    created_at: z.union([z.string(), z.number()]).nullish().transform((v) => v ?? null),
    creator_note: displayString,
    allocation: z.array(versionAllocation),
  })
  .loose();

const versionHistory = z
  .object({
    stack_id: z.number().int(),
    current_version: z.number().int(),
    versions: z.array(allocationVersion),
  })
  .loose();

export function validateVersionHistory(raw: unknown): IndexifyVersionHistory {
  return parseOrThrow(versionHistory, raw) as IndexifyVersionHistory;
}

const tradingInfo = z
  .object({
    trading_enabled: z.boolean(),
    token: z
      .object({
        archived: z.union([z.boolean(), z.number()]).nullish(),
        symbol: displayString,
      })
      .loose()
      .nullish(),
  })
  .loose();

export function validateTradingInfo(raw: unknown): { tradingEnabled: boolean; archived: boolean; symbol: string | null } {
  const parsed = parseOrThrow(tradingInfo, raw);
  return {
    tradingEnabled: parsed.trading_enabled,
    archived: Boolean(parsed.token?.archived),
    symbol: parsed.token?.symbol ?? null,
  };
}

const editAllocation = z
  .object({
    success: z.boolean(),
    stack_id: z.number().int(),
    version: z.number().int(),
    message: displayString,
  })
  .loose();

export function validateEditAllocation(raw: unknown): IndexifyEditAllocationResult {
  return parseOrThrow(editAllocation, raw) as IndexifyEditAllocationResult;
}
