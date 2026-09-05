/**
 * Indexify REST API client (api.indexify.finance).
 *
 * The provider is `?action=`-routed PHP: most operations are POST with a JSON
 * body and the operation named in the query string; transaction history is GET.
 * Authenticated calls carry the account's `ix_` key in `X-API-KEY`, read from
 * `INDEXIFY_API_KEY` PER CALL (never cached on the client, never logged, never
 * placed in an error). Public reads (`auth: false`) send no key at all, so a
 * discovery call can never leak the credential to a logging proxy needlessly.
 *
 * THIS IS A CUSTODIAL VENUE. `swap` executes a real trade server-side against
 * the account's Indexify-embedded wallet and returns only an order id — there
 * is no transaction to build, simulate, or sign on our side. The client
 * therefore wraps ONLY the actions the exposure policy in `constants.ts`
 * allows; `export_key`, `withdraw_usdc`, `delete_account` and every profile /
 * social / notification write have NO method here, so no handler can be
 * miswired into calling them.
 *
 * Live-measured quirks handled structurally:
 *  - `trending` requires `limit` AND `offset` together → both are always sent.
 *  - `search.php` 415s without `Content-Type: application/json` → always set.
 *  - Rate limit is a 10 rps leaky bucket with burst 100 → agent call rates
 *    never approach it, so no client-side throttle; 429/503 map to a typed,
 *    retryable error instead.
 */

import { loadConfig } from "../../config/store.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { fetchWithTimeout } from "../../utils/http.js";
import {
  INDEXIFY_API_KEY_ENV,
  INDEXIFY_API_KEY_HEADER,
  INDEXIFY_ENDPOINTS,
  INDEXIFY_HISTORY_LIMIT_CAP,
  INDEXIFY_LIST_LIMIT_CAP,
  INDEXIFY_MAX_STACK_TOKENS,
  INDEXIFY_WEIGHT_SUM,
} from "./constants.js";
import { mapIndexifyHttpError, mapIndexifyTransportError } from "./errors.js";
import type {
  IndexifyCreateStackParams,
  IndexifyCreateStackResult,
  IndexifyEditAllocationResult,
  IndexifyTokenRegistration,
  IndexifyTradability,
  IndexifyVersionHistory,
  IndexifyFeeBounds,
  IndexifyFeeCalculation,
  IndexifyHistoryPage,
  IndexifyHistoryParams,
  IndexifyHistorySummary,
  IndexifyHoldings,
  IndexifyLeaderboardParams,
  IndexifyLeaderboardRow,
  IndexifyOrderDetails,
  IndexifyOrdersPage,
  IndexifyPartialDetails,
  IndexifyPortfolio,
  IndexifyProfileMetrics,
  IndexifyPublicProfile,
  IndexifyRetryResult,
  IndexifySearchRow,
  IndexifyStack,
  IndexifyStackFetchParams,
  IndexifyStackListParams,
  IndexifySwapParams,
  IndexifySwapResult,
  IndexifyTokenRow,
} from "./types.js";
import {
  validateCreateStack,
  validateDescriptionCheck,
  validateEditAllocation,
  validateTradingInfo,
  validateVersionHistory,
  validateFeeBounds,
  validateFeeCalculation,
  validateHistoryPage,
  validateHistorySummary,
  validateHoldings,
  validateLeaderboard,
  validateMinBuy,
  validateNameCheck,
  validateOrderDetails,
  validateOrdersPage,
  validatePaginatedStacks,
  validatePartialDetails,
  validateProfileMetrics,
  validatePublicProfile,
  validateRetryResult,
  validateSearchRows,
  validateStackArray,
  validateSwapResult,
  validateTokenRows,
  validateTotalBalance,
  validateUsdcBalance,
  validateWalletAddress,
} from "./validation.js";

/** Per-call options; `signal` is the turn's Operator-Stop, composed with the timeout. */
export interface IndexifyRequestOptions {
  readonly signal?: AbortSignal | undefined;
}

interface SendOptions extends IndexifyRequestOptions {
  /**
   * Attach the API key. `true` requires it (account/mutating calls) and
   * refuses before any network when absent; `false` never sends it (public
   * reads must not leak the credential needlessly); `"if-present"` attaches
   * it when configured and otherwise sends nothing — for routes the docs call
   * optional-auth but the live API sometimes 401s keyless (`stack_info
   * action=fetch`, measured 2026-08-26), so the venue's own refusal stays the
   * truthful answer for keyless installs.
   */
  readonly auth: boolean | "if-present";
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  /** Extra query params beside `action`. */
  readonly query?: Record<string, string | number | undefined>;
}

/** True iff the environment carries an Indexify API key. Gates tool discovery too. */
export function hasIndexifyApiKey(): boolean {
  return Boolean(process.env[INDEXIFY_API_KEY_ENV]?.trim());
}

function clampLimit(limit: number, cap: number): number {
  return Math.max(1, Math.min(cap, Math.floor(limit)));
}

export class IndexifyClient {
  constructor(private readonly baseUrl: string) {}

  private buildUrl(path: string, action?: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    if (action !== undefined) url.searchParams.set("action", action);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async send(path: string, action: string | undefined, options: SendOptions): Promise<unknown> {
    const url = this.buildUrl(path, action, options.query);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.auth === true) {
      const key = process.env[INDEXIFY_API_KEY_ENV]?.trim();
      if (!key) {
        throw new VexError(
          ErrorCodes.INDEXIFY_AUTH_REQUIRED,
          `${INDEXIFY_API_KEY_ENV} is not set`,
          `This Indexify action needs ${INDEXIFY_API_KEY_ENV} in the environment.`,
        );
      }
      headers[INDEXIFY_API_KEY_HEADER] = key;
    } else if (options.auth === "if-present") {
      const key = process.env[INDEXIFY_API_KEY_ENV]?.trim();
      if (key) headers[INDEXIFY_API_KEY_HEADER] = key;
    }
    try {
      const method = options.method ?? "POST";
      const response = await fetchWithTimeout(url, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const text = await response.text();
      if (!response.ok) {
        mapIndexifyHttpError(response.status, text);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new VexError(
          ErrorCodes.INDEXIFY_INVALID_RESPONSE,
          "Indexify returned a non-JSON body on an ok status",
          "The Indexify API returned an unexpected response shape.",
        );
      }
    } catch (err) {
      mapIndexifyTransportError(err);
    }
  }

  // ── Stacks (public; optional auth enriches nothing we project) ────

  /**
   * Browse stacks. `feed` picks the provider endpoint filling the same row
   * shape: `all` → `paginated_list` (sortable, filterable), `trending` →
   * the provider's own trending ranking, `official` → Indexify-curated stacks.
   */
  async listStacks(params: IndexifyStackListParams, options: IndexifyRequestOptions = {}): Promise<IndexifyStack[]> {
    const limit = clampLimit(params.limit, INDEXIFY_LIST_LIMIT_CAP);
    const offset = Math.max(0, Math.floor(params.offset));
    if (params.feed === "trending" || params.feed === "official") {
      const raw = await this.send(INDEXIFY_ENDPOINTS.stackInfo, params.feed, {
        ...options, auth: false,
        body: {
          // Measured: `trending` 400s unless BOTH limit and offset are present.
          limit, offset,
          ...(params.minMarketCapUsd !== undefined ? { mcap_min: params.minMarketCapUsd } : {}),
          ...(params.maxMarketCapUsd !== undefined ? { mcap_max: params.maxMarketCapUsd } : {}),
          ...(params.usernames?.length ? { usernames: params.usernames } : {}),
        },
      });
      return validateStackArray(raw);
    }
    const raw = await this.send(INDEXIFY_ENDPOINTS.stackInfo, "paginated_list", {
      ...options, auth: false,
      body: {
        limit, offset,
        ...(params.sort !== undefined ? { sort: params.sort } : {}),
        ...(params.order !== undefined ? { order: params.order } : {}),
        ...(params.minMarketCapUsd !== undefined ? { mcap_min: params.minMarketCapUsd } : {}),
        ...(params.maxMarketCapUsd !== undefined ? { mcap_max: params.maxMarketCapUsd } : {}),
        ...(params.usernames?.length ? { usernames: params.usernames } : {}),
      },
    });
    return validatePaginatedStacks(raw);
  }

  /**
   * Fetch ONE stack by slug or numeric id, with TVL. Empty array = not found.
   * Docs call this optional-auth; live it 401s keyless (measured 2026-08-26),
   * so the key is attached when configured and the venue answers for itself.
   */
  async fetchStack(params: IndexifyStackFetchParams, options: IndexifyRequestOptions = {}): Promise<IndexifyStack | null> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.stackInfo, "fetch", {
      ...options, auth: "if-present",
      body: {
        ...(params.slug !== undefined ? { slugs: [params.slug] } : {}),
        ...(params.stackId !== undefined ? { stackIds: [params.stackId] } : {}),
        limit: 1, offset: 0, tvl: true,
      },
    });
    const rows = validateStackArray(raw);
    return rows[0] ?? null;
  }

  /** Free-text stack-name search (public, `search.php` simple mode). */
  async searchStacks(query: string, options: IndexifyRequestOptions = {}): Promise<IndexifySearchRow[]> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.search, undefined, {
      ...options, auth: false, body: { query },
    });
    return validateSearchRows(raw);
  }

  /** Investor count for one stack (public). */
  async stackInvestors(stackId: number, options: IndexifyRequestOptions = {}): Promise<number> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.stackInfo, "investors", {
      ...options, auth: false, body: { stack_id: stackId },
    });
    const count = (raw as { investor_count?: unknown })?.investor_count;
    return typeof count === "number" ? count : 0;
  }

  // ── Tokens (public) ───────────────────────────────────────────────

  /** Search Indexify's own tradable-token catalogue by name/symbol. */
  async searchTokens(query: string, options: IndexifyRequestOptions = {}): Promise<IndexifyTokenRow[]> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.tokenInfo, "search", {
      ...options, auth: false, body: { name: query },
    });
    return validateTokenRows(raw);
  }

  // ── Creators (public) ────────────────────────────────────────────

  async leaderboard(params: IndexifyLeaderboardParams, options: IndexifyRequestOptions = {}): Promise<IndexifyLeaderboardRow[]> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.userInfo, "leaderboard", {
      ...options, auth: false, method: "GET",
      query: {
        period: params.period,
        sort_by: params.sortBy,
        limit: clampLimit(params.limit, INDEXIFY_LIST_LIMIT_CAP),
        offset: Math.max(0, Math.floor(params.offset)),
      },
    });
    return validateLeaderboard(raw);
  }

  async publicProfile(username: string, options: IndexifyRequestOptions = {}): Promise<IndexifyPublicProfile> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.userInfo, "public_profile", {
      ...options, auth: false, body: { username },
    });
    return validatePublicProfile(raw);
  }

  async profileMetrics(username: string, options: IndexifyRequestOptions = {}): Promise<IndexifyProfileMetrics> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.userInfo, "public_profile_metrics", {
      ...options, auth: false, body: { username },
    });
    return validateProfileMetrics(raw);
  }

  // ── Account (auth) ───────────────────────────────────────────────

  /**
   * The account's balances and embedded wallet address, in one read.
   * NOTE: per-mint token balances are NOT available — the documented
   * `txn.php?action=balance` answers "Invalid action" live.
   */
  async portfolio(options: IndexifyRequestOptions = {}): Promise<IndexifyPortfolio> {
    const [usdc, total, pubkey] = await Promise.all([
      this.send(INDEXIFY_ENDPOINTS.txn, "usdc_balance", { ...options, auth: true }),
      this.send(INDEXIFY_ENDPOINTS.txn, "total_balance", { ...options, auth: true }),
      this.send(INDEXIFY_ENDPOINTS.txn, "address", { ...options, auth: true }),
    ]);
    const { balance, reserved } = validateUsdcBalance(usdc);
    return {
      usdcBalance: balance,
      usdcReserved: reserved,
      totalBalanceUsdc: validateTotalBalance(total),
      walletAddress: validateWalletAddress(pubkey),
    };
  }

  /** The account's holdings and PnL inside ONE stack (auth). */
  async stackHoldings(stackId: number, options: IndexifyRequestOptions = {}): Promise<IndexifyHoldings> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.stackInfo, "user_stack_holdings", {
      ...options, auth: true, body: { stack_id: stackId },
    });
    return validateHoldings(raw);
  }

  // ── Orders / history (auth) ──────────────────────────────────────

  async listOrders(limit: number, offset: number, options: IndexifyRequestOptions = {}): Promise<IndexifyOrdersPage> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.userOrders, undefined, {
      ...options, auth: true,
      query: { limit: clampLimit(limit, INDEXIFY_HISTORY_LIMIT_CAP), offset: Math.max(0, Math.floor(offset)) },
    });
    return validateOrdersPage(raw);
  }

  async orderDetails(orderId: string, options: IndexifyRequestOptions = {}): Promise<IndexifyOrderDetails> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.orders, "details", {
      ...options, auth: true, body: { order_id: orderId },
    });
    return validateOrderDetails(raw);
  }

  async partialDetails(orderId: string, options: IndexifyRequestOptions = {}): Promise<IndexifyPartialDetails> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.orders, "partial_details", {
      ...options, auth: true, body: { order_id: orderId },
    });
    return validatePartialDetails(raw);
  }

  async history(params: IndexifyHistoryParams, options: IndexifyRequestOptions = {}): Promise<IndexifyHistoryPage> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.transactionHistory, "list", {
      ...options, auth: true, method: "GET",
      query: {
        limit: clampLimit(params.limit, INDEXIFY_HISTORY_LIMIT_CAP),
        offset: Math.max(0, Math.floor(params.offset)),
        ...(params.status !== undefined ? { status: params.status } : {}),
        ...(params.stackId !== undefined ? { stack_id: params.stackId } : {}),
      },
    });
    return validateHistoryPage(raw);
  }

  async historySummary(options: IndexifyRequestOptions = {}): Promise<IndexifyHistorySummary> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.transactionHistory, "summary", {
      ...options, auth: true, method: "GET",
    });
    return validateHistorySummary(raw);
  }

  // ── Fees (public) ────────────────────────────────────────────────

  async feeCalculate(amountUsdc: number, stackId: number, options: IndexifyRequestOptions = {}): Promise<IndexifyFeeCalculation> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.fee, "calculate", {
      ...options, auth: false, body: { amount: amountUsdc, stack_id: stackId },
    });
    return validateFeeCalculation(raw);
  }

  async minBuy(options: IndexifyRequestOptions = {}): Promise<number> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.fee, "min_buy", { ...options, auth: false });
    return validateMinBuy(raw);
  }

  async creatorFeeBounds(options: IndexifyRequestOptions = {}): Promise<IndexifyFeeBounds> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.fee, "creator_fee_bounds", { ...options, auth: false });
    return validateFeeBounds(raw);
  }

  // ── Mutations (auth) — the ONLY spending/writing surface ─────────

  /**
   * Execute a stack trade SERVER-SIDE. Buys spend `amount` USDC; sells sell
   * `amount` PERCENT of holdings (1–100). The trade begins the moment this
   * returns an order id — there is no signing step and no cancellation.
   */
  async swap(params: IndexifySwapParams, options: IndexifyRequestOptions = {}): Promise<IndexifySwapResult> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.txn, "swap", {
      ...options, auth: true,
      body: { stack_id: params.stackId, amount: params.amount, cue: params.cue },
    });
    return validateSwapResult(raw);
  }

  /** Accept a PARTIAL order as-is. */
  async acknowledgeOrder(orderId: string, options: IndexifyRequestOptions = {}): Promise<unknown> {
    return this.send(INDEXIFY_ENDPOINTS.orders, "acknowledge", {
      ...options, auth: true, body: { order_id: orderId },
    });
  }

  /** Retry the failed tokens of a PARTIAL order (account-default slippage). */
  async retryOrder(orderId: string, options: IndexifyRequestOptions = {}): Promise<IndexifyRetryResult> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.orders, "retry", {
      ...options, auth: true, body: { order_id: orderId },
    });
    return validateRetryResult(raw);
  }

  /** Sell every token a PARTIAL order did manage to buy. */
  async sellAllPartial(orderId: string, options: IndexifyRequestOptions = {}): Promise<unknown> {
    return this.send(INDEXIFY_ENDPOINTS.orders, "sell_all", {
      ...options, auth: true, body: { order_id: orderId },
    });
  }

  /** Validate a proposed stack name (public). */
  async checkStackName(name: string, options: IndexifyRequestOptions = {}): Promise<"OK" | "TAKEN" | "BADWORD" | "INVALID"> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.stackInfo, "check_name", {
      ...options, auth: false, body: { name },
    });
    return validateNameCheck(raw);
  }

  /** Validate a proposed stack description (public). */
  async checkStackDescription(description: string, options: IndexifyRequestOptions = {}): Promise<"OK" | "BADWORD" | "INVALID"> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.stackInfo, "check_description", {
      ...options, auth: false, body: { description },
    });
    return validateDescriptionCheck(raw);
  }

  // ── Allocation sync (Z500 workflow surface — NOT agent tools) ────
  //
  // These four exist for the Z500 allocation-sync workflow
  // (sync/z500-allocation-sync). They are deliberately NOT exposed as agent
  // tools: editing a live stack's allocation is a creator operation the
  // exposure policy keeps away from the model; the workflow is code with a
  // pinned stack id, not a model choosing arguments. Per the workflow spec,
  // this client still wraps NO trading or rebalance endpoint — there is no
  // `txn.php?action=rebalance` method here to miswire.

  /** The stack's allocation version history (auth). */
  async versionHistory(stackId: number, options: IndexifyRequestOptions = {}): Promise<IndexifyVersionHistory> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.stackInfo, "version_history", {
      ...options, auth: true, body: { stack_id: stackId },
    });
    return validateVersionHistory(raw);
  }

  /**
   * Support + tradability verdict for ONE mint. A 404 answers
   * `{found: false}` — for an eligibility scan, "Indexify does not know this
   * token" is a verdict, not a failure.
   */
  async tradability(mintAddress: string, options: IndexifyRequestOptions = {}): Promise<IndexifyTradability> {
    try {
      const raw = await this.send(INDEXIFY_ENDPOINTS.tokenTrading, "get_trading_info", {
        ...options, auth: false, body: { token_address: mintAddress },
      });
      return { found: true, ...validateTradingInfo(raw) };
    } catch (err) {
      if (err instanceof VexError && err.code === ErrorCodes.INDEXIFY_NOT_FOUND) {
        return { found: false };
      }
      throw err;
    }
  }

  /**
   * Register a token into the venue's catalogue via
   * `token_info.php?action=new` — the Indexify team's prescribed way to get
   * Z500 coins "into the system" (2026-09-02). The venue enforces its own
   * $10k minimum market cap LIVE and resolves the pool itself, so callers
   * never pre-judge eligibility. Expected refusals come back as verdicts
   * (see IndexifyTokenRegistration); outages still throw.
   */
  async registerToken(tokenAddress: string, options: IndexifyRequestOptions = {}): Promise<IndexifyTokenRegistration> {
    try {
      await this.send(INDEXIFY_ENDPOINTS.tokenInfo, "new", {
        ...options, auth: true, body: { token_address: tokenAddress },
      });
      return { outcome: "registered" };
    } catch (err) {
      if (err instanceof VexError && err.code === ErrorCodes.INDEXIFY_INVALID_REQUEST) {
        if (/already exists/i.test(err.message)) return { outcome: "already_registered" };
        return { outcome: "rejected", reason: err.message };
      }
      if (err instanceof VexError && err.code === ErrorCodes.INDEXIFY_NOT_FOUND) {
        return { outcome: "rejected", reason: "the venue's data sources cannot resolve this mint" };
      }
      throw err;
    }
  }

  /**
   * Replace ONE stack's allocation via `stack_info.php?action=edit_allocation`
   * (auth; creator-only server-side). Weights are validated locally first —
   * integers summing to exactly 100, 1-12 tokens — so a malformed allocation
   * is refused before any request exists.
   */
  async editAllocation(
    stackId: number,
    allocations: Readonly<Record<string, number>>,
    creatorNote: string,
    options: IndexifyRequestOptions = {},
  ): Promise<IndexifyEditAllocationResult> {
    const entries = Object.entries(allocations);
    if (entries.length < 1 || entries.length > INDEXIFY_MAX_STACK_TOKENS) {
      throw new VexError(
        ErrorCodes.INDEXIFY_INVALID_REQUEST,
        `editAllocation: ${entries.length} tokens (allowed 1-${INDEXIFY_MAX_STACK_TOKENS})`,
        "The allocation holds an unsupported number of tokens.",
      );
    }
    let sum = 0;
    for (const [, weight] of entries) {
      if (!Number.isInteger(weight) || weight < 1 || weight > 99) {
        throw new VexError(
          ErrorCodes.INDEXIFY_INVALID_REQUEST,
          "editAllocation: weights must be integers 1-99",
          "An allocation weight is not a whole percent.",
        );
      }
      sum += weight;
    }
    if (sum !== INDEXIFY_WEIGHT_SUM) {
      throw new VexError(
        ErrorCodes.INDEXIFY_INVALID_REQUEST,
        `editAllocation: weights sum to ${sum}, expected ${INDEXIFY_WEIGHT_SUM}`,
        "The allocation weights do not sum to 100.",
      );
    }
    const raw = await this.send(INDEXIFY_ENDPOINTS.stackInfo, "edit_allocation", {
      ...options, auth: true,
      body: { stack_id: stackId, stackTokenInfo: allocations, creator_note: creatorNote },
    });
    return validateEditAllocation(raw);
  }

  /** Create a stack under the linked account. Free (no funds move), public forever. */
  async createStack(params: IndexifyCreateStackParams, options: IndexifyRequestOptions = {}): Promise<IndexifyCreateStackResult> {
    const raw = await this.send(INDEXIFY_ENDPOINTS.stackInfo, "create", {
      ...options, auth: true,
      body: {
        stackName: params.stackName,
        stackTokenInfo: params.stackTokenInfo,
        creatorFee: params.creatorFee,
        description: params.description,
        category: params.category,
        socialLinks: params.socialLinks,
        ...(params.showCreatorHoldings !== undefined ? { showCreatorHoldings: params.showCreatorHoldings } : {}),
      },
    });
    return validateCreateStack(raw);
  }
}

// ── Singleton ──────────────────────────────────────────────────────

let cachedClient: IndexifyClient | null = null;
let cachedBaseUrl: string | null = null;

/** Shared client, rebuilt only when the configured base URL changes. */
export function getIndexifyClient(): IndexifyClient {
  const baseUrl = loadConfig().services.indexifyApiUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) {
    return cachedClient;
  }
  cachedClient = new IndexifyClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}
