import {
  LIGHTER_API_KEY_INDEX_ALL,
  LIGHTER_CACHE_TTL_MS,
  LIGHTER_ENDPOINT_PATHS,
  LIGHTER_ENDPOINTS,
  type LighterEnvironment,
} from "@tools/lighter/constants.js";
import {
  getLighterClient,
  type LighterClient,
  type LighterPrivilegedAccountAuth,
} from "@tools/lighter/client.js";
import {
  buildLighterOrderPreview,
  type LighterOrderPreview,
} from "@tools/lighter/order-preview.js";
import {
  LIGHTER_TRADING_API_KEY_INDEX_MAX,
  LIGHTER_TRADING_API_KEY_INDEX_MIN,
} from "@tools/lighter/trading-credentials.js";
import type { LighterMarket, LighterMarketDetail } from "@tools/lighter/types.js";
import { ErrorCodes, VexError } from "../../../../../errors.js";
import logger from "@utils/logger.js";
import type { ProtocolHandler } from "../../types.js";
import { fail, ok } from "../../handler-helpers.js";
import { resolveSelectedAddressForRead } from "@vex-agent/tools/internal/wallet/resolve.js";
import {
  LIGHTER_DEPOSIT_MIN_USDC,
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
} from "@tools/lighter/wallet-funding/constants.js";
import { decimalToBaseUnits } from "@tools/lighter/wallet-funding/onboarding-plan.js";
import { buildLighterOnboardingReaders } from "@tools/lighter/wallet-funding/onboarding-readers.js";
import { resolveLighterOnboardingStatus } from "@tools/lighter/wallet-funding/onboarding-status.js";
import * as lighterOrderPreviewsRepo from "@vex-agent/db/repos/lighter-order-previews.js";
import { describeFailureForAgent, describeFailureForLog } from "../../runtime/errors.js";
import {
  defaultLighterOrderRepairDeps,
  repairLighterOrderIntent,
  repairUnresolvedLighterOrders,
} from "../order-repair.js";
import {
  LIGHTER_AGENT_CANDLE_OUTPUT_MAX,
  LIGHTER_AGENT_ACCOUNT_POSITION_MAX,
  LIGHTER_AGENT_ACCOUNT_ROW_MAX,
  readAccountOrderLimit,
  readApiKeyIndex,
  readApiKeyLimit,
  readAccountLookup,
  readCountBack,
  readEnvironment,
  readLighterOrderPreviewParams,
  readMarketFilter,
  readMarketId,
  readMarketListLimit,
  readMarketListPage,
  readOptionalAccountIndex,
  readRequiredAccountIndex,
  readOrderBookLimit,
  readRecentTradesLimit,
  readResolution,
  readSetTimestampToEnd,
  readTimestamp,
} from "../params.js";
import {
  projectCandles,
  projectAccountResponse,
  projectApiKeys,
  projectAccountOrders,
  projectMarket,
  projectMarketDetails,
  projectOrderBook,
  projectPositions,
  projectRecentTrades,
  projectSystem,
  sortMarketsForDisplay,
  takePage,
} from "../projectors.js";
import {
  listLighterTradingCredentialScopes,
  resolveDefaultLighterTradingCredentialScope,
  resolveSavedLighterTradingCredentialScope,
} from "../trading-credential-scope.js";
import { resolveLighterReadOnlyAccountAuth } from "../read-account-auth.js";
import { getConfiguredLighterKeyRegistrationExecutor } from "../key-registration-execution.js";
import {
  readLighterManagedTradingReadiness,
  type LighterManagedTradingReadiness,
} from "../managed-trading-readiness.js";

// Resolves the account index and, when one can be derived from the saved trading
// key, a short-lived read-only auth token for an authenticated account read.
// When a token is derived, the read must target that exact account (the client
// rejects a privileged token whose account index does not match), so the
// resolved index is returned alongside it. When no token is derived, the
// caller's request — which may be undefined — is preserved unchanged so the
// client still falls back to a separately configured read-only token exactly as
// before.
async function resolveAuthenticatedAccountRead(
  environment: LighterEnvironment,
  requestedAccountIndex: number | undefined,
): Promise<{
  readonly accountIndex: number | undefined;
  readonly privilegedAuth: LighterPrivilegedAccountAuth | undefined;
}> {
  const targetAccount =
    requestedAccountIndex
    ?? resolveDefaultLighterTradingCredentialScope(environment)?.accountIndex;
  if (targetAccount === undefined) {
    return { accountIndex: requestedAccountIndex, privilegedAuth: undefined };
  }
  const privilegedAuth =
    (await resolveLighterReadOnlyAccountAuth(environment, targetAccount)) ?? undefined;
  return {
    accountIndex:
      privilegedAuth === undefined ? requestedAccountIndex : privilegedAuth.accountIndex,
    privilegedAuth,
  };
}

function failureDetail(toolId: string, err: unknown): string {
  logger.warn("lighter.handler.error", {
    toolId,
    code: err instanceof VexError ? err.code : "UNEXPECTED",
    error: describeFailureForLog(err),
  });
  return describeFailureForAgent(err);
}

function readOnlyAccountProvenance(
  environment: LighterEnvironment,
  toolId: string,
  endpointPaths: readonly string[],
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source: "live_lighter_read_only_account_api",
    provenance: {
      source: "live_lighter_read_only_account_api",
      provider: "lighter",
      dataPlane: "provider_read_only_auth_rest",
      toolId,
      environment,
      restBaseUrl: LIGHTER_ENDPOINTS[environment].restBaseUrl,
      endpointPaths,
      retrievedAt: new Date().toISOString(),
      cacheStatus: "fresh_no_cache",
      maxDataAgeMs: 0,
      authenticated: true,
      credentialCapability: "read_only_account_data",
      independentOnchainVerification: false,
      ...details,
    },
  };
}

function liveProvenance(
  environment: LighterEnvironment,
  toolId: string,
  endpointPaths: readonly string[],
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source: "live_lighter_public_api",
    provenance: {
      source: "live_lighter_public_api",
      provider: "lighter",
      dataPlane: "provider_public_rest",
      toolId,
      environment,
      restBaseUrl: LIGHTER_ENDPOINTS[environment].restBaseUrl,
      endpointPaths,
      retrievedAt: new Date().toISOString(),
      cacheStatus: "fresh_or_short_cache",
      maxDataAgeMs: LIGHTER_CACHE_TTL_MS,
      independentOnchainVerification: false,
      ...details,
    },
  };
}

function compactDisplay(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

function formatUsd(value: string | null): string {
  if (value === null) return "unknown";
  const compact = compactDisplay(value);
  const number = Number(compact);
  return Number.isFinite(number)
    ? `$${number.toLocaleString("en-US", { maximumFractionDigits: 6 })}`
    : `$${compact}`;
}

function formatAsset(value: string, symbol: string): string {
  return `${compactDisplay(value)} ${symbol}`;
}

function labelTimeInForce(value: string): string {
  if (value === "good-till-time") return "Good-till-time";
  if (value === "immediate-or-cancel") return "Immediate-or-cancel";
  if (value === "post-only") return "Post-only";
  return value;
}

function previewSummary(
  orderPreview: LighterOrderPreview,
): {
  readonly title: string;
  readonly columns: readonly ["Parameter", "Value", "Notes"];
  readonly rows: readonly {
    readonly parameter: string;
    readonly value: string;
    readonly notes: string;
  }[];
  readonly safety: readonly string[];
} {
  const preview = orderPreview.preview;
  const baseSymbol = preview.symbol.split("-")[0] ?? preview.symbol;
  const orderExpiry = preview.timeInForce === "good-till-time"
    ? new Date(Number(orderPreview.identity.expiryMs))
    : null;
  const price = formatUsd(preview.price.display);
  const quote = formatUsd(preview.quoteNotional.display);
  const bestBid = formatUsd(preview.marketData.bestBid);
  const bestAsk = formatUsd(preview.marketData.bestAsk);
  const minimums =
    `${formatAsset(preview.minimumChecks.minBaseAmountDisplay, baseSymbol)} base minimum; `
    + `${formatUsd(preview.minimumChecks.minQuoteAmountDisplay)} quote minimum`;
  const marketNote = preview.marketData.priceComparison === "crossing_or_taker"
    ? "The limit price is marketable against the current book if submitted."
    : preview.marketData.priceComparison === "resting"
      ? "This price would rest on the book unless the market moves to it."
      : "Book comparison is unavailable from the current snapshot.";
  const position = preview.positionContext.verified
    ? `${preview.positionContext.positionSide}${preview.positionContext.marketPosition ? ` ${preview.positionContext.marketPosition}` : ""}`
    : "Not verified";
  return {
    title: `Preview of your Lighter ${preview.environment.toUpperCase()} ${preview.orderType}-${preview.side} order`,
    columns: ["Parameter", "Value", "Notes"],
    rows: [
      {
        parameter: "Side",
        value: preview.side.toUpperCase(),
        notes: `${preview.orderType}-${preview.side} order`,
      },
      {
        parameter: "Market",
        value: `${preview.symbol} market #${preview.marketIndex}`,
        notes: "Resolved from live Lighter market data",
      },
      {
        parameter: "Amount",
        value: formatAsset(preview.baseAmount.display, baseSymbol),
        notes: `Passes minimum: ${formatAsset(preview.minimumChecks.minBaseAmountDisplay, baseSymbol)}`,
      },
      {
        parameter: "Limit price",
        value: `${price} per ${baseSymbol}`,
        notes: marketNote,
      },
      {
        parameter: "Quote notional",
        value: quote,
        notes: `${formatAsset(preview.baseAmount.display, baseSymbol)} x ${price}`,
      },
      {
        parameter: "Time-in-force",
        value: labelTimeInForce(preview.timeInForce),
        notes: orderExpiry ? `Expires ${orderExpiry.toISOString()}` : "Provider default expiry",
      },
      {
        parameter: "Market snapshot",
        value: `Bid ${bestBid} / Ask ${bestAsk}`,
        notes: preview.marketData.referencePrice === null
          ? "Reference price unavailable"
          : `Reference ${formatUsd(preview.marketData.referencePrice)}`,
      },
      {
        parameter: "Minimum checks",
        value: "Passed",
        notes: minimums,
      },
      {
        parameter: "Position context",
        value: position,
        notes: preview.reduceOnly ? "Reduce-only was requested" : "No reduce-only constraint",
      },
    ],
    safety: [
      "Read-only preview. No order was signed, submitted, broadcast, or placed.",
      "Approval preparation is a separate step and still does not mean live submission.",
    ],
  };
}

function findMarketDetail(
  response: {
    readonly order_book_details: readonly LighterMarketDetail[];
    readonly spot_order_book_details: readonly LighterMarketDetail[];
  },
  marketId: number,
): LighterMarketDetail | null {
  return [
    ...response.order_book_details,
    ...response.spot_order_book_details,
  ].find((detail) => detail.market_id === marketId) ?? null;
}

function normalizeMarketSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/^\$/, "");
}

function marketSymbolScore(market: LighterMarket, wanted: string): number {
  const symbol = normalizeMarketSymbol(market.symbol);
  if (symbol === wanted) return 0;
  if (symbol === `${wanted}-USD`) return 1;
  if (symbol === `${wanted}/USD`) return 2;
  if (symbol.split(/[-/]/)[0] === wanted) return 3;
  return Number.POSITIVE_INFINITY;
}

async function resolvePreviewMarketId(
  client: LighterClient,
  environment: LighterEnvironment,
  params: { readonly marketId?: number; readonly marketSymbol?: string },
): Promise<number> {
  if (params.marketId !== undefined) return params.marketId;
  if (params.marketSymbol === undefined) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter order preview needs a market symbol or market id.",
      "Say the asset symbol, for example ETH.",
    );
  }

  const wanted = normalizeMarketSymbol(params.marketSymbol);
  const markets = await client.getMarkets(environment, { filter: "all" });
  const selected = markets.order_books
    .map((market) => ({ market, score: marketSymbolScore(market, wanted) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => {
      const activeDiff =
        (left.market.status === "active" ? 0 : 1) - (right.market.status === "active" ? 0 : 1);
      if (activeDiff !== 0) return activeDiff;
      if (left.score !== right.score) return left.score - right.score;
      return left.market.market_id - right.market.market_id;
    })[0]?.market;
  if (!selected) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `No live Lighter ${environment} market found for ${wanted}.`,
      "Use a listed Lighter market symbol, for example ETH.",
    );
  }
  return selected.market_id;
}

function resolvePreviewAccountIndex(
  environment: LighterEnvironment,
  requestedAccountIndex?: number,
): number {
  if (requestedAccountIndex !== undefined) return requestedAccountIndex;
  const scopes = listLighterTradingCredentialScopes(environment);
  // Ambiguity is about which *account* to trade, not how many keys are saved.
  // Several api-key-index entries can be registered to a single L2 account; any
  // of them signs for that account, so multiple keys on one account is not
  // ambiguous. Refuse only when the saved keys span more than one account.
  const distinctAccounts = [...new Set(scopes.map((scope) => scope.accountIndex))];
  if (distinctAccounts.length > 1) {
    const accounts = distinctAccounts.join(", ");
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Multiple Lighter ${environment} trading accounts are configured (accounts ${accounts}); Vex will not guess which one to trade with.`,
      "Ask the user which Lighter account they intend to trade from only because multiple accounts are configured; do not ask them to choose an API-key index.",
    );
  }
  const savedScope = scopes[0] ?? resolveDefaultLighterTradingCredentialScope(environment);
  if (!savedScope) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Managed Lighter trading access is not ready for ${environment}.`,
      "Start or continue managed Lighter onboarding for the selected wallet. Vex will generate, register, and store the trading credential locally; do not ask the user to paste a key or choose an index.",
    );
  }
  return savedScope.accountIndex;
}

async function resolvePreviewApiKeyIndex(
  client: LighterClient,
  environment: LighterEnvironment,
  accountIndex: number,
  requestedApiKeyIndex: number | null | undefined,
): Promise<{
  readonly apiKeyIndex: number | null;
  readonly apiKeyLookupStatus: "caller_supplied" | "saved_vault_scope" | "resolved" | "not_found" | "unavailable";
}> {
  if (requestedApiKeyIndex !== null && requestedApiKeyIndex !== undefined) {
    return {
      apiKeyIndex: requestedApiKeyIndex,
      apiKeyLookupStatus: "caller_supplied",
    };
  }
  const savedScope = resolveSavedLighterTradingCredentialScope(environment, accountIndex);
  if (savedScope !== null) {
    return {
      apiKeyIndex: savedScope.apiKeyIndex,
      apiKeyLookupStatus: "saved_vault_scope",
    };
  }
  try {
    const response = await client.getApiKeys(environment, {
      accountIndex,
      apiKeyIndex: LIGHTER_API_KEY_INDEX_ALL,
    });
    const selected = response.api_keys
      .filter((key) =>
        key.api_key_index >= LIGHTER_TRADING_API_KEY_INDEX_MIN
        && key.api_key_index <= LIGHTER_TRADING_API_KEY_INDEX_MAX)
      .sort((left, right) => left.api_key_index - right.api_key_index)[0];
    return {
      apiKeyIndex: selected?.api_key_index ?? null,
      apiKeyLookupStatus: selected ? "resolved" : "not_found",
    };
  } catch (err) {
    logger.warn("lighter.order.preview.api_key_lookup_unavailable", {
      environment,
      accountIndex,
      error: describeFailureForLog(err),
    });
    return {
      apiKeyIndex: null,
      apiKeyLookupStatus: "unavailable",
    };
  }
}

function managedReadinessRecoveryLeg(
  readiness: LighterManagedTradingReadiness,
): { readonly kind: string; readonly reason: string } {
  if (readiness.reason === "active_managed_credential_missing") {
    return {
      kind: "register_trading_key",
      reason: "Create and register locally encrypted Vex trading access before any order can be signed.",
    };
  }
  if (
    readiness.reason === "nonce_not_synchronized"
    || readiness.reason === "nonce_not_reservable"
  ) {
    return {
      kind: "reconcile_order_state",
      reason: "Reconcile unresolved local order and nonce evidence before preparing another order or key registration.",
    };
  }
  return {
    kind: "reconcile_trading_access",
    reason: "Reconcile the existing managed credential from durable vault and exact provider evidence; do not register a replacement key.",
  };
}

export const LIGHTER_READ_HANDLERS: Record<string, ProtocolHandler> = {
  "lighter.account.onboarding.status": async (params, context) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    if (environment.value !== "core") {
      return fail("Lighter wallet-funded onboarding is available on Core only in this release.");
    }

    // Wallet address: an explicit override, else the session's selected EVM
    // wallet resolved address-only (never decrypts a key).
    let walletAddress: string;
    const provided = params.walletAddress;
    if (provided !== undefined) {
      if (typeof provided !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(provided)) {
        return fail("walletAddress must be a 0x-prefixed 20-byte EVM address.");
      }
      walletAddress = provided;
    } else {
      try {
        walletAddress = resolveSelectedAddressForRead(
          context.walletResolution,
          context.walletPolicy,
          "eip155",
        );
      } catch (err) {
        return fail(describeFailureForAgent(err));
      }
    }

    // When no trade size is known, use the venue's activation minimum so a new
    // or unfunded account still produces a funding leg. The assistant then asks
    // the user only for their desired deposit amount, never internal indexes.
    let requiredCollateralUnits = decimalToBaseUnits(
      LIGHTER_DEPOSIT_MIN_USDC,
      LIGHTER_SETTLEMENT_ASSET_DECIMALS,
    );
    const requiredCollateral = params.amountIn;
    const depositAmountProvided = requiredCollateral !== undefined;
    if (requiredCollateral !== undefined) {
      if (typeof requiredCollateral !== "string") {
        return fail("amountIn must be a decimal USDC string, for example \"11\".");
      }
      try {
        requiredCollateralUnits = decimalToBaseUnits(requiredCollateral, LIGHTER_SETTLEMENT_ASSET_DECIMALS);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }

    try {
      const status = await resolveLighterOnboardingStatus(buildLighterOnboardingReaders(), {
        environment: environment.value,
        walletAddress,
        requiredCollateralUnits,
      });
      const managedTradingReadiness = status.accountIndex === null
        ? null
        : await readLighterManagedTradingReadiness(environment.value, status.accountIndex);
      const managedTradingAccessActive = status.tradingKeyRegistered
        && managedTradingReadiness?.ready === true;
      const readinessRecoveryLeg = managedTradingReadiness?.ready === false
        ? managedReadinessRecoveryLeg(managedTradingReadiness)
        : null;
      const plan = !managedTradingAccessActive
        && !status.plan.legs.some((leg) => leg.kind === "register_trading_key")
        ? {
            ...status.plan,
            ready: false,
            legs: [
              ...status.plan.legs,
              readinessRecoveryLeg ?? {
                kind: "register_trading_key",
                reason: "Create and register locally encrypted Vex trading access before any order can be signed.",
              },
            ],
          }
        : status.plan;
      const needsFunding = BigInt(status.accountCollateralUnits) < requiredCollateralUnits;
      const userGuidance = plan.ready && managedTradingAccessActive
        ? "The selected wallet's Lighter account is funded and its locally encrypted Vex trading access is active. Tell the user they are ready to trade; do not expose account or API-key indexes unless they ask for technical details."
        : managedTradingReadiness?.reason === "nonce_not_reservable"
          ? "Run lighter.order.status without an intent id to reconcile every unresolved local order and nonce reservation for Core. Do not prepare a key registration or another order until the nonce is reservable."
          : readinessRecoveryLeg?.kind === "reconcile_trading_access"
            ? "Reconcile the existing managed trading-access lifecycle from durable and provider evidence. Do not prepare or register a replacement key while readiness verification is unresolved."
        : !depositAmountProvided && needsFunding
          ? `Ask exactly one setup question: \"How much USDC do you want to deposit? Lighter's minimum is ${LIGHTER_DEPOSIT_MIN_USDC} USDC.\" Then prepare the deposit in the current chat. If an earlier no-broadcast setup attempt exists, the prepare path retires it safely and creates a new approval here; never ask the user to reopen an old chat, say retry, or provide an intent, account, API-key index, nonce, fingerprint, or key.`
          : "Continue only the required managed onboarding legs for the selected wallet. Vex resolves the account, slot, nonce, and encrypted credential internally. Keep each state-changing action approval-gated and do not tell the user they are ready until status proves both funding and active trading access.";
      return ok({
        ...liveProvenance(
          environment.value,
          "lighter.account.onboarding.status",
          [LIGHTER_ENDPOINT_PATHS.account, LIGHTER_ENDPOINT_PATHS.apiKeys],
          { walletAddress, authenticated: false },
        ),
        ...status,
        tradingKeyRegistered: managedTradingAccessActive,
        managedTradingAccessActive,
        managedTradingReadiness,
        plan,
        depositAmountProvided,
        userGuidance,
      });
    } catch (err) {
      return fail(
        `Lighter onboarding status unavailable (${failureDetail("lighter.account.onboarding.status", err)})`,
      );
    }
  },

  "lighter.system": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);

    try {
      const client = getLighterClient();
      const [status, systemConfig] = await Promise.all([
        client.getStatus(environment.value),
        client.getSystemConfig(environment.value),
      ]);
      return ok({
        ...liveProvenance(environment.value, "lighter.system", [
          LIGHTER_ENDPOINT_PATHS.status,
          LIGHTER_ENDPOINT_PATHS.systemConfig,
        ]),
        environment: environment.value,
        ...projectSystem(status, systemConfig),
      });
    } catch (err) {
      return fail(`Lighter system read unavailable (${failureDetail("lighter.system", err)})`);
    }
  },

  "lighter.markets": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const marketId = readMarketId(params, false);
    if (!marketId.ok) return fail(marketId.reason);
    const filter = readMarketFilter(params);
    if (!filter.ok) return fail(filter.reason);
    const limit = readMarketListLimit(params);
    if (!limit.ok) return fail(limit.reason);
    const page = readMarketListPage(params);
    if (!page.ok) return fail(page.reason);

    try {
      const response = await getLighterClient().getMarkets(environment.value, {
        ...(marketId.value === undefined ? {} : { marketId: marketId.value }),
        ...(filter.value === undefined ? {} : { filter: filter.value }),
      });
      const projected = sortMarketsForDisplay(response.order_books).map(projectMarket);
      const window = takePage(projected, page.value, limit.value);
      if (window.total > 0 && page.value > window.lastPage) {
        return fail(
          `Lighter markets page ${page.value} is past the last page (${window.lastPage}) for ${window.total} matching markets. Request page ${window.lastPage} or lower.`,
        );
      }
      return ok({
        ...liveProvenance(environment.value, "lighter.markets", [
          LIGHTER_ENDPOINT_PATHS.orderBooks,
        ], {
          marketId: marketId.value ?? null,
          filter: filter.value ?? null,
          outputLimit: limit.value,
          page: page.value,
          lastPage: window.lastPage,
          sortOrder: "active_first_market_id_ascending",
        }),
        environment: environment.value,
        marketId: marketId.value ?? null,
        filter: filter.value ?? null,
        page: page.value,
        lastPage: window.lastPage,
        nextPage: window.hasMore ? page.value + 1 : null,
        sorting: {
          markets: "active_first_market_id_ascending",
        },
        count: window.count,
        totalProviderRows: window.total,
        truncated: window.truncated,
        truncationNote: window.truncated
          ? `Showing page ${page.value} (${window.count} rows) from ${window.total} markets after active-first, market-id ascending ordering.${window.hasMore ? ` Request page ${page.value + 1} to continue.` : " No later page remains."}`
          : null,
        markets: window.rows,
      });
    } catch (err) {
      return fail(`Lighter markets unavailable (${failureDetail("lighter.markets", err)})`);
    }
  },

  "lighter.market.get": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const marketId = readMarketId(params, true);
    if (!marketId.ok) return fail(marketId.reason);
    const filter = readMarketFilter(params);
    if (!filter.ok) return fail(filter.reason);

    try {
      const response = await getLighterClient().getMarketDetails(environment.value, {
        marketId: marketId.value!,
        ...(filter.value === undefined ? {} : { filter: filter.value }),
      });
      const details = projectMarketDetails(response);
      const exact = details.filter((detail) => detail.marketId === marketId.value);
      if (exact.length === 0) {
        return fail(`No Lighter market detail found for marketId ${marketId.value} on ${environment.value}.`);
      }
      return ok({
        ...liveProvenance(environment.value, "lighter.market.get", [
          LIGHTER_ENDPOINT_PATHS.orderBookDetails,
        ], {
          marketId: marketId.value,
          filter: filter.value ?? null,
        }),
        environment: environment.value,
        marketId: marketId.value,
        filter: filter.value ?? null,
        count: exact.length,
        details: exact,
        responseRules: [
          "Render baseAssetId and quoteAssetId as numeric provider identifiers only. Never infer or append asset symbols from the market symbol.",
          "Describe minBaseAmount and minQuoteAmount as live provider minimum metadata. For an actionable Vex preview, calculate an amount that passes both conservative preview thresholds.",
        ],
      });
    } catch (err) {
      return fail(`Lighter market detail unavailable (${failureDetail("lighter.market.get", err)})`);
    }
  },

  "lighter.account.get": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const lookup = readAccountLookup(params);
    if (!lookup.ok) return fail(lookup.reason);

    try {
      const response = await getLighterClient().getAccount(environment.value, {
        by: lookup.value.by,
        value: lookup.value.value,
        activeOnly: lookup.value.activeOnly,
      });
      return ok({
        ...liveProvenance(environment.value, "lighter.account.get", [
          LIGHTER_ENDPOINT_PATHS.account,
        ], {
          accountIndex: lookup.value.accountIndex,
          l1Address: lookup.value.l1Address,
          accountLookupSource: lookup.value.by,
          authenticated: false,
          outputAccountLimit: LIGHTER_AGENT_ACCOUNT_ROW_MAX,
          outputPositionLimit: LIGHTER_AGENT_ACCOUNT_POSITION_MAX,
        }),
        environment: environment.value,
        accountIndex: lookup.value.accountIndex,
        l1Address: lookup.value.l1Address,
        activeOnly: lookup.value.activeOnly ?? null,
        ...projectAccountResponse(
          response,
          LIGHTER_AGENT_ACCOUNT_ROW_MAX,
          LIGHTER_AGENT_ACCOUNT_POSITION_MAX,
        ),
      });
    } catch (err) {
      return fail(`Lighter account read unavailable (${failureDetail("lighter.account.get", err)})`);
    }
  },

  "lighter.positions": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const lookup = readAccountLookup(params);
    if (!lookup.ok) return fail(lookup.reason);

    try {
      const response = await getLighterClient().getAccount(environment.value, {
        by: lookup.value.by,
        value: lookup.value.value,
        activeOnly: lookup.value.activeOnly,
      });
      return ok({
        ...liveProvenance(environment.value, "lighter.positions", [
          LIGHTER_ENDPOINT_PATHS.account,
        ], {
          accountIndex: lookup.value.accountIndex,
          l1Address: lookup.value.l1Address,
          accountLookupSource: lookup.value.by,
          authenticated: false,
          outputAccountLimit: LIGHTER_AGENT_ACCOUNT_ROW_MAX,
          outputPositionLimit: LIGHTER_AGENT_ACCOUNT_POSITION_MAX,
        }),
        environment: environment.value,
        accountIndex: lookup.value.accountIndex,
        l1Address: lookup.value.l1Address,
        activeOnly: lookup.value.activeOnly ?? null,
        ...projectPositions(
          response,
          LIGHTER_AGENT_ACCOUNT_ROW_MAX,
          LIGHTER_AGENT_ACCOUNT_POSITION_MAX,
        ),
      });
    } catch (err) {
      return fail(`Lighter positions read unavailable (${failureDetail("lighter.positions", err)})`);
    }
  },

  "lighter.openOrders": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const accountIndex = readOptionalAccountIndex(params);
    if (!accountIndex.ok) return fail(accountIndex.reason);
    const marketId = readMarketId(params, false);
    if (!marketId.ok) return fail(marketId.reason);
    const filter = readMarketFilter(params);
    if (!filter.ok) return fail(filter.reason);
    const limit = readAccountOrderLimit(params);
    if (!limit.ok) return fail(limit.reason);

    try {
      const auth = await resolveAuthenticatedAccountRead(environment.value, accountIndex.value);
      const response = await getLighterClient().getAccountActiveOrders(environment.value, {
        ...(auth.accountIndex === undefined ? {} : { accountIndex: auth.accountIndex }),
        ...(marketId.value === undefined ? {} : { marketId: marketId.value }),
        ...(filter.value === undefined ? {} : { marketType: filter.value }),
      }, auth.privilegedAuth);
      return ok({
        ...readOnlyAccountProvenance(environment.value, "lighter.openOrders", [
          LIGHTER_ENDPOINT_PATHS.accountActiveOrders,
        ], {
          accountIndex: auth.accountIndex ?? null,
          accountIndexSource: accountIndex.value === undefined ? "credential" : "caller",
          marketId: marketId.value ?? null,
          filter: filter.value ?? null,
          outputLimit: limit.value,
        }),
        environment: environment.value,
        accountIndex: auth.accountIndex ?? null,
        accountIndexSource: accountIndex.value === undefined ? "credential" : "caller",
        marketId: marketId.value ?? null,
        filter: filter.value ?? null,
        limit: limit.value,
        ...projectAccountOrders(response, limit.value),
      });
    } catch (err) {
      return fail(`Lighter open orders unavailable (${failureDetail("lighter.openOrders", err)})`);
    }
  },

  "lighter.orderHistory": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const accountIndex = readOptionalAccountIndex(params);
    if (!accountIndex.ok) return fail(accountIndex.reason);
    const marketId = readMarketId(params, false);
    if (!marketId.ok) return fail(marketId.reason);
    const filter = readMarketFilter(params);
    if (!filter.ok) return fail(filter.reason);
    const limit = readAccountOrderLimit(params);
    if (!limit.ok) return fail(limit.reason);

    try {
      const auth = await resolveAuthenticatedAccountRead(environment.value, accountIndex.value);
      const response = await getLighterClient().getAccountInactiveOrders(environment.value, {
        ...(auth.accountIndex === undefined ? {} : { accountIndex: auth.accountIndex }),
        ...(marketId.value === undefined ? {} : { marketId: marketId.value }),
        ...(filter.value === undefined ? {} : { marketType: filter.value }),
        limit: limit.value,
      }, auth.privilegedAuth);
      return ok({
        ...readOnlyAccountProvenance(environment.value, "lighter.orderHistory", [
          LIGHTER_ENDPOINT_PATHS.accountInactiveOrders,
        ], {
          accountIndex: auth.accountIndex ?? null,
          accountIndexSource: accountIndex.value === undefined ? "credential" : "caller",
          marketId: marketId.value ?? null,
          filter: filter.value ?? null,
          outputLimit: limit.value,
        }),
        environment: environment.value,
        accountIndex: auth.accountIndex ?? null,
        accountIndexSource: accountIndex.value === undefined ? "credential" : "caller",
        marketId: marketId.value ?? null,
        filter: filter.value ?? null,
        limit: limit.value,
        ...projectAccountOrders(response, limit.value),
      });
    } catch (err) {
      return fail(`Lighter order history unavailable (${failureDetail("lighter.orderHistory", err)})`);
    }
  },

  "lighter.trades": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const accountIndex = readOptionalAccountIndex(params);
    if (!accountIndex.ok) return fail(accountIndex.reason);
    const limit = readAccountOrderLimit(params);
    if (!limit.ok) return fail(limit.reason);

    try {
      const auth = await resolveAuthenticatedAccountRead(environment.value, accountIndex.value);
      const response = await getLighterClient().getAccountTrades(environment.value, {
        ...(auth.accountIndex === undefined ? {} : { accountIndex: auth.accountIndex }),
        limit: limit.value,
        sortBy: "timestamp",
      }, auth.privilegedAuth);
      return ok({
        ...readOnlyAccountProvenance(environment.value, "lighter.trades", [
          LIGHTER_ENDPOINT_PATHS.trades,
        ], {
          accountIndex: auth.accountIndex ?? null,
          accountIndexSource: accountIndex.value === undefined ? "credential" : "caller",
          outputLimit: limit.value,
        }),
        environment: environment.value,
        accountIndex: auth.accountIndex ?? null,
        accountIndexSource: accountIndex.value === undefined ? "credential" : "caller",
        limit: limit.value,
        ...projectRecentTrades(response, limit.value),
      });
    } catch (err) {
      return fail(`Lighter account trades unavailable (${failureDetail("lighter.trades", err)})`);
    }
  },

  "lighter.apiKeys.inspect": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const accountIndex = readRequiredAccountIndex(params);
    if (!accountIndex.ok) return fail(accountIndex.reason);
    const apiKeyIndex = readApiKeyIndex(params);
    if (!apiKeyIndex.ok) return fail(apiKeyIndex.reason);
    const limit = readApiKeyLimit(params);
    if (!limit.ok) return fail(limit.reason);

    try {
      const response = await getLighterClient().getApiKeys(environment.value, {
        accountIndex: accountIndex.value,
        ...(apiKeyIndex.value === undefined ? {} : { apiKeyIndex: apiKeyIndex.value }),
      });
      return ok({
        ...liveProvenance(environment.value, "lighter.apiKeys.inspect", [
          LIGHTER_ENDPOINT_PATHS.apiKeys,
        ], {
          accountIndex: accountIndex.value,
          apiKeyIndex: apiKeyIndex.value ?? null,
          authenticated: false,
          outputLimit: limit.value,
        }),
        environment: environment.value,
        accountIndex: accountIndex.value,
        apiKeyIndex: apiKeyIndex.value ?? null,
        limit: limit.value,
        ...projectApiKeys(response, limit.value),
      });
    } catch (err) {
      return fail(`Lighter API-key metadata unavailable (${failureDetail("lighter.apiKeys.inspect", err)})`);
    }
  },

  "lighter.order.preview": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Lighter order preview requires a host session id.");
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const nowMs = Date.now();
    const previewParams = readLighterOrderPreviewParams(params, nowMs);
    if (!previewParams.ok) return fail(previewParams.reason);

    try {
      const client = getLighterClient();
      const accountIndex = resolvePreviewAccountIndex(
        environment.value,
        previewParams.value.accountIndex,
      );
      const [marketId, apiKeyResolution] = await Promise.all([
        resolvePreviewMarketId(client, environment.value, previewParams.value),
        resolvePreviewApiKeyIndex(
          client,
          environment.value,
          accountIndex,
          previewParams.value.apiKeyIndex,
        ),
      ]);
      const { apiKeyIndex, apiKeyLookupStatus } = apiKeyResolution;
      const [marketDetails, orderBook, account] = await Promise.all([
        client.getMarketDetails(environment.value, {
          marketId,
          filter: "all",
        }),
        client.getOrderBookOrders(environment.value, {
          marketId,
          limit: 10,
        }),
        client.getAccount(environment.value, {
          by: "index",
          value: accountIndex,
          activeOnly: true,
        }),
      ]);
      const market = findMarketDetail(marketDetails, marketId);
      if (!market) {
        return fail(
          `No live Lighter market detail found for marketId ${marketId} on ${environment.value}.`,
        );
      }
      const source = liveProvenance(environment.value, "lighter.order.preview", [
        ...(previewParams.value.marketId === undefined ? [LIGHTER_ENDPOINT_PATHS.orderBooks] : []),
        ...(previewParams.value.apiKeyIndex === null ? [LIGHTER_ENDPOINT_PATHS.apiKeys] : []),
        LIGHTER_ENDPOINT_PATHS.orderBookDetails,
        LIGHTER_ENDPOINT_PATHS.orderBookOrders,
        LIGHTER_ENDPOINT_PATHS.account,
      ], {
        marketId,
        marketSymbol: previewParams.value.marketSymbol ?? null,
        accountIndex,
        apiKeyIndex,
        apiKeyLookupStatus,
        authenticated: false,
        persistedPreview: true,
      });
      const preview = buildLighterOrderPreview({
        sessionId,
        environment: environment.value,
        accountIndex,
        apiKeyIndex,
        marketId,
        side: previewParams.value.side,
        baseAmount: previewParams.value.baseAmount,
        price: previewParams.value.price,
        orderType: previewParams.value.orderType,
        timeInForce: previewParams.value.timeInForce,
        reduceOnly: previewParams.value.reduceOnly,
        orderExpiry: previewParams.value.orderExpiry,
        clientOrderIndexPolicy: previewParams.value.clientOrderIndexPolicy,
        nowMs,
      }, {
        market,
        orderBook,
        account,
      });
      await lighterOrderPreviewsRepo.create({
        preview,
        liveSourceJson: source.provenance as Record<string, unknown>,
      });
      const approvalReady = apiKeyIndex !== null;
      return ok({
        ...source,
        status: "preview_ready",
        environment: environment.value,
        previewId: preview.previewId,
        matchHash: preview.matchHash,
        expiresAt: preview.expiresAt,
        previewSummary: previewSummary(preview),
        preview: preview.preview,
        approvalReady,
        nextStep: approvalReady
          ? "prepare_for_approval"
          : "connect_trading_api_key_before_approval",
        nextToolId: approvalReady ? "lighter.order.create.prepare" : null,
        responseRules: [
          "Describe this as a live-data-backed read-only preview, not as a simulation.",
          "Render previewSummary as a Markdown table using its columns and rows. Do not use bullets for the main preview unless the user asks for a shorter summary.",
          "Do not render raw preview internals such as integer, decimals, display wrappers, booleans, or JSON object fragments unless the user explicitly asks for technical details.",
          "Do not emit raw HTML such as <br>; use Markdown bullets or sentences.",
          "Do not say the order can be placed, executed, submitted, or broadcast directly from this preview.",
          approvalReady
            ? "Tell the user they can continue with the Prepare trade approval button in the host UI. Do not mention internal tool names."
            : "If the user wants to continue, start or continue managed Lighter onboarding for the selected wallet. Vex generates and stores the credential locally; never ask the user to paste a key, visit Settings, or choose an account/API-key index.",
        ],
        userGuidance: approvalReady
          ? "This is a live-data-backed preview only. Do not describe it as placed, submitted, broadcast, simulated, or ready for execution. Tell the user they can continue with the Prepare trade approval button in the host UI; do not mention internal tool names."
          : "This is a live-data-backed read-only preview only, not a simulation. Do not describe it as placed, submitted, broadcast, or ready for execution. Tell the user Vex must finish managed Lighter setup first, then continue onboarding without asking them to paste a key or provide technical identifiers.",
        safety:
          "No signer, API private key, signature, sendTx, order placement, cancellation, deposit, withdrawal, or transfer path ran.",
      });
    } catch (err) {
      return fail(`Lighter order preview unavailable (${failureDetail("lighter.order.preview", err)})`);
    }
  },

  "lighter.orderbook": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const marketId = readMarketId(params, true);
    if (!marketId.ok) return fail(marketId.reason);
    const limit = readOrderBookLimit(params);
    if (!limit.ok) return fail(limit.reason);

    try {
      const response = await getLighterClient().getOrderBookOrders(environment.value, {
        marketId: marketId.value!,
        limit: limit.value,
      });
      return ok({
        ...liveProvenance(environment.value, "lighter.orderbook", [
          LIGHTER_ENDPOINT_PATHS.orderBookOrders,
        ], {
          marketId: marketId.value,
          outputLimit: limit.value,
        }),
        environment: environment.value,
        marketId: marketId.value,
        limit: limit.value,
        ...projectOrderBook(response, limit.value),
        responseRules: [
          "Prefer orderExpiryIso when displaying an order expiry. If raw orderExpiry is shown, label it explicitly as epoch milliseconds.",
          "Do not infer asset names from numeric market, owner-account, or order identifiers.",
        ],
      });
    } catch (err) {
      return fail(`Lighter order book unavailable (${failureDetail("lighter.orderbook", err)})`);
    }
  },

  "lighter.recentTrades": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const marketId = readMarketId(params, true);
    if (!marketId.ok) return fail(marketId.reason);
    const limit = readRecentTradesLimit(params);
    if (!limit.ok) return fail(limit.reason);

    try {
      const response = await getLighterClient().getRecentTrades(environment.value, {
        marketId: marketId.value!,
        limit: limit.value,
      });
      return ok({
        ...liveProvenance(environment.value, "lighter.recentTrades", [
          LIGHTER_ENDPOINT_PATHS.recentTrades,
        ], {
          marketId: marketId.value,
          outputLimit: limit.value,
        }),
        environment: environment.value,
        marketId: marketId.value,
        limit: limit.value,
        ...projectRecentTrades(response, limit.value),
      });
    } catch (err) {
      return fail(`Lighter recent trades unavailable (${failureDetail("lighter.recentTrades", err)})`);
    }
  },

  "lighter.candles": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const marketId = readMarketId(params, true);
    if (!marketId.ok) return fail(marketId.reason);
    const resolution = readResolution(params);
    if (!resolution.ok) return fail(resolution.reason);
    const startTimestamp = readTimestamp(params, "startTimestamp");
    if (!startTimestamp.ok) return fail(startTimestamp.reason);
    const endTimestamp = readTimestamp(params, "endTimestamp");
    if (!endTimestamp.ok) return fail(endTimestamp.reason);
    if (endTimestamp.value <= startTimestamp.value) {
      return fail("endTimestamp must be greater than startTimestamp.");
    }
    const countBack = readCountBack(params);
    if (!countBack.ok) return fail(countBack.reason);
    const setTimestampToEnd = readSetTimestampToEnd(params);

    try {
      const response = await getLighterClient().getCandles(environment.value, {
        marketId: marketId.value!,
        resolution: resolution.value,
        startTimestamp: startTimestamp.value,
        endTimestamp: endTimestamp.value,
        ...(countBack.value === undefined ? {} : { countBack: countBack.value }),
        ...(setTimestampToEnd === undefined ? {} : { setTimestampToEnd }),
      });
      return ok({
        ...liveProvenance(environment.value, "lighter.candles", [
          LIGHTER_ENDPOINT_PATHS.candles,
        ], {
          marketId: marketId.value,
          resolution: resolution.value,
          startTimestamp: startTimestamp.value,
          endTimestamp: endTimestamp.value,
          countBack: countBack.value ?? null,
        }),
        environment: environment.value,
        marketId: marketId.value,
        requestedWindow: {
          startTimestamp: startTimestamp.value,
          endTimestamp: endTimestamp.value,
        },
        countBack: countBack.value ?? null,
        outputLimit: LIGHTER_AGENT_CANDLE_OUTPUT_MAX,
        ...projectCandles(response, LIGHTER_AGENT_CANDLE_OUTPUT_MAX),
      });
    } catch (err) {
      return fail(`Lighter candles unavailable (${failureDetail("lighter.candles", err)})`);
    }
  },

  "lighter.key.register.status": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Lighter key-registration status requires a host session id.");
    const intentId = typeof params.intentId === "string" ? params.intentId.trim() : "";
    if (intentId.length === 0) return fail("Missing required: intentId.");
    const executor = getConfiguredLighterKeyRegistrationExecutor();
    if (executor === null) {
      return fail("The privileged Lighter key-registration reconciliation boundary is unavailable.");
    }
    try {
      return ok(await executor.reconcile({
        sessionId,
        intentId,
        walletResolution: context.walletResolution,
        walletPolicy: context.walletPolicy,
        abortSignal: context.abortSignal,
      }));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },

  "lighter.order.status": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const intentIdRaw = params.intentId;
    const intentId =
      typeof intentIdRaw === "string" && intentIdRaw.trim().length > 0
        ? intentIdRaw.trim()
        : null;

    try {
      const deps = defaultLighterOrderRepairDeps();
      let reports;
      if (intentId !== null) {
        const intent = await deps.intents.findByIntentIdAnySession(intentId);
        if (intent === null) {
          return fail(`No Lighter order execution intent ${intentId} exists locally.`);
        }
        reports = [await repairLighterOrderIntent(intent, deps)];
      } else {
        reports = await repairUnresolvedLighterOrders(
          { environment: environment.value, limit: 10 },
          deps,
        );
      }

      const unresolved = reports.filter(
        (report) =>
          report.resolution === "awaiting_provider" || report.resolution === "degraded",
      ).length;
      return ok({
        source: "vex_lighter_local_order_repair",
        environment: environment.value,
        checkedIntents: reports.length,
        stillUnresolved: unresolved,
        reports,
        riskNotes: [
          "Repair updates local order records from provider evidence and provable nonce facts only; it never signs, submits, or retries an order.",
          "Never resubmit an order whose report says awaiting_provider; wait for the stated deadline and run this again.",
        ],
        message:
          reports.length === 0
            ? `No unresolved Lighter order intents exist for ${environment.value}.`
            : `Checked ${reports.length} Lighter order intent(s); ${unresolved} still unresolved.`,
      });
    } catch (err) {
      return fail(`Lighter order status unavailable (${failureDetail("lighter.order.status", err)})`);
    }
  },
};
