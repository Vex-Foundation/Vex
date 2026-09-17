import type { LighterEnvironment } from "@tools/lighter/constants.js";
import { getLighterClient, type LighterClient } from "@tools/lighter/client.js";
import {
  marginModeFromWire,
  positionInitialMarginFractionToProviderScale,
} from "@tools/lighter/margin-fraction.js";
import type {
  LighterAccount,
  LighterAccountAsset,
  LighterAccountOrder,
  LighterAccountPosition,
  LighterTrade,
} from "@tools/lighter/types.js";
import type {
  LighterTradingAccount,
  LighterTradingAccountUnavailableReason,
  LighterTradingAsset,
  LighterTradingFill,
  LighterTradingFills,
  LighterTradingOpenOrder,
  LighterTradingMarginTerm,
  LighterTradingPosition,
} from "@shared/schemas/lighter-trading.js";
import { isAbortError, throwIfAborted } from "../../../../src/utils/cancellation.js";
import { resolveLighterReadOnlyAccountAuth } from "@vex-agent/tools/protocols/lighter/read-account-auth.js";
import { listUnlockedLighterTradingCredentialScopes } from "../secrets/lighter-trading-credential.js";
import { requireUnlockedMasterPassword } from "../secrets/session.js";
import {
  LighterTradingReadError,
  readLighterTradingMarketList,
} from "./trading-panel-service.js";
import { log } from "../logger/index.js";

const MAX_ROWS = 200;
const LIGHTER_TRADING_FILLS_MAX = 100;
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const UNSIGNED_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Renderer-safe subset of the trading client used by the account panel. */
export interface LighterTradingAccountClient {
  getAccount: LighterClient["getAccount"];
  getAccountActiveOrders: LighterClient["getAccountActiveOrders"];
}

export interface LighterTradingFillsClient {
  getAccountTrades: LighterClient["getAccountTrades"];
}

function cleanDecimal(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return DECIMAL_PATTERN.test(trimmed) ? trimmed : null;
}

function cleanUnsigned(value: unknown): string | null {
  const decimal = cleanDecimal(value);
  return decimal !== null && UNSIGNED_DECIMAL_PATTERN.test(decimal) ? decimal : null;
}

function cleanMagnitude(value: unknown): string | null {
  const decimal = cleanDecimal(value);
  if (decimal === null) return null;
  if (UNSIGNED_DECIMAL_PATTERN.test(decimal)) return decimal;
  const magnitude = decimal.replace(/^-/, "");
  return UNSIGNED_DECIMAL_PATTERN.test(magnitude) ? magnitude : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cleanBoundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

interface DecimalParts {
  readonly integer: bigint;
  readonly scale: number;
}

function decimalParts(value: string): DecimalParts | null {
  if (!DECIMAL_PATTERN.test(value)) return null;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const magnitude = BigInt(`${whole}${fraction}`.replace(/^0+(?=\d)/, ""));
  return {
    integer: negative ? -magnitude : magnitude,
    scale: fraction.length,
  };
}

function formatDecimal(parts: DecimalParts): string {
  const negative = parts.integer < 0n;
  const magnitude = negative ? -parts.integer : parts.integer;
  if (parts.scale === 0) return `${negative ? "-" : ""}${magnitude}`;
  const raw = magnitude.toString().padStart(parts.scale + 1, "0");
  const whole = raw.slice(0, -parts.scale);
  const fraction = raw.slice(-parts.scale).replace(/0+$/, "");
  const normalized = fraction.length === 0 ? whole : `${whole}.${fraction}`;
  return `${negative && magnitude !== 0n ? "-" : ""}${normalized}`;
}

function addDecimalParts(left: DecimalParts | null, right: DecimalParts): DecimalParts {
  if (left === null) return right;
  const scale = Math.max(left.scale, right.scale);
  return {
    integer:
      left.integer * (10n ** BigInt(scale - left.scale))
      + right.integer * (10n ** BigInt(scale - right.scale)),
    scale,
  };
}

function subtractUnsignedDecimals(left: string, right: string): string | null {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  if (leftParts === null || rightParts === null) return null;
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const difference =
    leftParts.integer * (10n ** BigInt(scale - leftParts.scale))
    - rightParts.integer * (10n ** BigInt(scale - rightParts.scale));
  if (difference < 0n) return null;
  return formatDecimal({ integer: difference, scale });
}

function isNonZero(size: string | null): boolean {
  return size !== null && /[1-9]/.test(size);
}

function projectPosition(
  raw: LighterAccountPosition,
  symbolFor: (marketId: number) => string,
): LighterTradingPosition | null {
  const size = cleanMagnitude(raw.position);
  if (!isNonZero(size) || (raw.sign !== 1 && raw.sign !== -1)) return null;
  const marketId = raw.market_id;
  return {
    marketId,
    symbol: raw.symbol.trim().length > 0 ? raw.symbol : symbolFor(marketId),
    side: raw.sign > 0 ? "long" : "short",
    size: size ?? "0",
    entryPrice: cleanUnsigned(raw.avg_entry_price),
    value: cleanUnsigned(raw.position_value),
    unrealizedPnl: cleanDecimal(raw.unrealized_pnl),
    liquidationPrice: cleanUnsigned(raw.liquidation_price),
    initialMarginFraction: readOrNull(() =>
      positionInitialMarginFractionToProviderScale(raw.initial_margin_fraction)),
    marginMode: readOrNull(() => marginModeFromWire(raw.margin_mode)),
    allocatedMargin: cleanUnsigned(raw.allocated_margin),
  };
}

/**
 * The account's own margin terms for a market, from its position row whether
 * or not a position is open. A row whose fraction Vex cannot read is left out
 * rather than shown as a number it is not.
 */
function projectMarginTerm(raw: LighterAccountPosition): LighterTradingMarginTerm | null {
  const initialMarginFraction = readOrNull(() =>
    positionInitialMarginFractionToProviderScale(raw.initial_margin_fraction));
  if (initialMarginFraction === null) return null;
  return {
    marketId: raw.market_id,
    initialMarginFraction,
    marginMode: readOrNull(() => marginModeFromWire(raw.margin_mode)),
  };
}

/** A margin term Vex cannot read exactly is shown as unknown, not as a failed panel. */
function readOrNull<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function projectOrder(
  raw: LighterAccountOrder,
  accountIndex: number,
  symbolFor: (marketId: number) => string,
): LighterTradingOpenOrder | null {
  // The authenticated endpoint is account-scoped, but every returned row must
  // still bind to that exact account before crossing the main/renderer trust
  // boundary. Drop mismatches instead of displaying another account's order.
  if (raw.owner_account_index !== accountIndex) return null;
  const orderId = cleanBoundedText(raw.order_id, 128);
  if (orderId === null) return null;
  const marketId = raw.market_index;
  const side = raw.is_ask === undefined
    ? raw.side === "sell" || raw.side === "ask"
      ? "sell"
      : raw.side === "buy" || raw.side === "bid"
        ? "buy"
        : null
    : raw.is_ask ? "sell" : "buy";
  if (side === null) return null;
  const type = cleanBoundedText(raw.type, 32);
  const status = cleanBoundedText(raw.status, 32);
  return {
    orderId,
    // Never fall back to client_order_index: it is a JS number and may already
    // have lost precision before this projection runs.
    clientOrderId: cleanBoundedText(raw.client_order_id, 128),
    marketId,
    symbol: symbolFor(marketId),
    side,
    type,
    timeInForce: cleanBoundedText(raw.time_in_force, 32),
    reduceOnly: typeof raw.reduce_only === "boolean" ? raw.reduce_only : null,
    triggerPrice: cleanUnsigned(raw.trigger_price),
    triggerStatus: cleanBoundedText(raw.trigger_status, 32),
    triggeredAt: nonNegativeInt(raw.trigger_time),
    orderExpiry: nonNegativeInt(raw.order_expiry),
    price: cleanUnsigned(raw.price),
    size: cleanUnsigned(raw.initial_base_amount),
    filled: cleanUnsigned(raw.filled_base_amount),
    remaining: cleanUnsigned(raw.remaining_base_amount),
    status,
    createdAt: nonNegativeInt(raw.created_at) ?? nonNegativeInt(raw.timestamp),
  };
}

function projectAsset(raw: LighterAccountAsset): LighterTradingAsset | null {
  const balance = cleanUnsigned(raw.balance);
  const locked = cleanUnsigned(raw.locked_balance);
  const marginBalance = cleanUnsigned(raw.margin_balance);
  // Surface any asset the account actually holds - spot balance, locked, or
  // posted margin. USDG and other collateral tokens live here, not in the
  // single perp `collateral` field.
  const hasHolding = isNonZero(balance) || isNonZero(locked) || isNonZero(marginBalance);
  if (balance === null || !hasHolding) return null;
  let available: string | null = balance;
  if (locked !== null && isNonZero(locked)) {
    available = subtractUnsignedDecimals(balance, locked);
  }
  return {
    assetId: raw.asset_id,
    symbol: typeof raw.symbol === "string" && raw.symbol.trim().length > 0
      ? raw.symbol
      : `#${raw.asset_id}`,
    balance,
    available,
    marginMode: raw.margin_mode === "enabled" || raw.margin_mode === "disabled"
      ? raw.margin_mode
      : null,
  };
}

function accountIndexOf(account: LighterAccount): number | null {
  const value = account.index ?? account.account_index;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function findOwningLighterAccount(
  accounts: readonly LighterAccount[],
  accountIndex: number,
): LighterAccount | null {
  return accounts.find((row) => accountIndexOf(row) === accountIndex) ?? null;
}

export function resolveUniqueLighterAccountIndex(
  scopes: readonly { readonly accountIndex: number }[],
): number | null {
  const accountIndexes = new Set(scopes.map((scope) => scope.accountIndex));
  return accountIndexes.size === 1 ? [...accountIndexes][0]! : null;
}

async function symbolResolver(
  environment: LighterEnvironment,
  signal?: AbortSignal,
): Promise<(marketId: number) => string> {
  try {
    const markets = await readLighterTradingMarketList(
      environment,
      undefined,
      undefined,
      signal,
    );
    const byId = new Map(markets.markets.map((market) => [market.marketId, market.symbol]));
    return (marketId) => byId.get(marketId) ?? `#${marketId}`;
  } catch (cause) {
    // Symbols are decoration: a failed market list downgrades labels to
    // `#id`. An abort is not decoration, so it keeps propagating.
    throwIfAborted(signal);
    if (isAbortError(cause)) throw cause;
    return (marketId) => `#${marketId}`;
  }
}

function unavailable(
  environment: LighterEnvironment,
  now: () => number,
  reason: LighterTradingAccountUnavailableReason,
): LighterTradingAccount {
  return {
    environment,
    retrievedAt: now(),
    status: "unavailable",
    unavailableReason: reason,
    accountIndex: null,
    openOrdersAvailable: false,
    openOrdersTruncated: false,
    summary: null,
    assets: [],
    positions: [],
    marginTerms: [],
    openOrders: [],
  };
}

/**
 * Reads the authenticated Light it up account panel. The owning account is
 * resolved from the unlocked trading scope - the renderer never supplies an
 * account identity and never receives auth tokens. Positions and balances come
 * from the public account-index read; open orders use a short-lived read-only
 * auth derived in the main process. When no unlocked trading scope exists (no
 * onboarded account or a locked vault) it returns a real "unavailable" status,
 * never fabricated positions.
 */
export interface LighterTradingAccountProjectionInput {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly account: LighterAccount | null;
  readonly orders: readonly LighterAccountOrder[];
  readonly ordersNextCursor?: string;
  readonly openOrdersAvailable: boolean;
  readonly openOrdersUnavailableReason?: "no_read_auth" | "read_failed";
  readonly symbolFor: (marketId: number) => string;
  readonly now: () => number;
}

/**
 * Pure projection of a raw Lighter account and its active orders into the
 * renderer-safe DTO. Kept free of network, vault, and signer access so it can be
 * unit-tested directly; the live read wraps it with the real IO.
 */
export function projectLighterTradingAccount(
  input: LighterTradingAccountProjectionInput,
): LighterTradingAccount {
  const positions = (input.account?.positions ?? [])
    .map((row) => projectPosition(row, input.symbolFor))
    .filter((row): row is LighterTradingPosition => row !== null)
    .slice(0, MAX_ROWS);
  const marginTerms = (input.account?.positions ?? [])
    .map(projectMarginTerm)
    .filter((row): row is LighterTradingMarginTerm => row !== null)
    .slice(0, MAX_ROWS);
  const assets = (input.account?.assets ?? [])
    .map(projectAsset)
    .filter((row): row is LighterTradingAsset => row !== null)
    .slice(0, MAX_ROWS);
  const openOrders = input.openOrdersAvailable
    ? input.orders
        .map((row) => projectOrder(row, input.accountIndex, input.symbolFor))
        .filter((row): row is LighterTradingOpenOrder => row !== null)
        .slice(0, MAX_ROWS)
    : [];
  const openOrdersTruncated = input.openOrdersAvailable
    && (
      input.orders.length > MAX_ROWS
      || (
        typeof input.ordersNextCursor === "string"
        && input.ordersNextCursor.trim().length > 0
      )
    );

  const unrealizedPnl = positions.reduce<DecimalParts | null>((sum, position) => {
    if (position.unrealizedPnl === null) return sum;
    const value = decimalParts(position.unrealizedPnl);
    return value === null ? sum : addDecimalParts(sum, value);
  }, null);

  return {
    environment: input.environment,
    retrievedAt: input.now(),
    status: "ready",
    unavailableReason: null,
    accountIndex: input.accountIndex,
    openOrdersAvailable: input.openOrdersAvailable,
    ...(input.openOrdersAvailable || input.openOrdersUnavailableReason === undefined
      ? {}
      : { openOrdersUnavailableReason: input.openOrdersUnavailableReason }),
    openOrdersTruncated,
    summary: {
      collateral: cleanDecimal(input.account?.collateral),
      availableBalance: cleanDecimal(input.account?.available_balance),
      unrealizedPnl: unrealizedPnl === null ? null : formatDecimal(unrealizedPnl),
    },
    assets,
    positions,
    marginTerms,
    openOrders,
  };
}

export async function readLighterTradingAccount(
  environment: LighterEnvironment,
  client: LighterTradingAccountClient = getLighterClient(),
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<LighterTradingAccount> {
  throwIfAborted(signal);
  const scopes = listUnlockedLighterTradingCredentialScopes(environment);
  if (scopes.length === 0) {
    // The scope list is empty for two different reasons and the person needs
    // to be told which: a locked vault is one unlock away, while an
    // un-onboarded account needs a trading key. Reading the session's lock
    // state (never the password itself) is what separates them.
    return unavailable(
      environment,
      now,
      requireUnlockedMasterPassword().ok ? "not_onboarded" : "locked_vault",
    );
  }
  // Multiple API keys for one account are equivalent for this read-only
  // projection. Multiple distinct accounts are not: the renderer supplies no
  // account identity, so main must fail closed instead of choosing by sort
  // order and displaying an arbitrary account.
  const accountIndex = resolveUniqueLighterAccountIndex(scopes);
  if (accountIndex === null) return unavailable(environment, now, "ambiguous_account");

  const symbolFor = await symbolResolver(environment, signal);
  const accountResponse = await client.getAccount(environment, {
    by: "index",
    value: accountIndex,
  }, { signal });
  const account = findOwningLighterAccount(accountResponse.accounts, accountIndex);
  if (account === null) {
    // The provider answered without the account the local credential is bound
    // to. Nothing local can fix that, so it is a provider condition.
    throw new LighterTradingReadError("provider_unavailable");
  }

  let orders: readonly LighterAccountOrder[] = [];
  let ordersNextCursor: string | undefined;
  let openOrdersAvailable = false;
  let openOrdersUnavailableReason: "no_read_auth" | "read_failed" = "no_read_auth";
  const auth = await resolveLighterReadOnlyAccountAuth(environment, accountIndex);
  if (auth !== null) {
    try {
      const ordersResponse = await client.getAccountActiveOrders(
        environment,
        { accountIndex },
        auth,
        { signal },
      );
      orders = ordersResponse.orders;
      ordersNextCursor = ordersResponse.next_cursor;
      openOrdersAvailable = true;
    } catch (cause) {
      // A cancelled read is the caller's own event, not a degraded panel:
      // publishing an "open orders unavailable" snapshot for it would be a
      // lie. Everything else stays a bounded, cause-free warning because
      // provider errors may echo request context.
      throwIfAborted(signal);
      if (isAbortError(cause)) throw cause;
      log.warn("[lighter-trading] active orders read failed", { environment, accountIndex });
      openOrdersUnavailableReason = "read_failed";
    }
  }

  return projectLighterTradingAccount({
    environment,
    accountIndex,
    account,
    orders,
    ordersNextCursor,
    openOrdersAvailable,
    openOrdersUnavailableReason,
    symbolFor,
    now,
  });
}

/**
 * Which side of a trade the account was on, from the record's own party ids.
 * Null when it is on neither (a foreign row) or both (self-trade: no single
 * side to report).
 */
function fillSideForAccount(trade: LighterTrade, accountIndex: number): "buy" | "sell" | null {
  const isAsk = trade.ask_account_id === accountIndex;
  const isBid = trade.bid_account_id === accountIndex;
  if (isAsk === isBid) return null;
  return isAsk ? "sell" : "buy";
}

function projectLighterTradingFill(
  trade: LighterTrade,
  accountIndex: number,
  symbolFor: (marketId: number) => string,
): LighterTradingFill | null {
  const side = fillSideForAccount(trade, accountIndex);
  const size = cleanUnsigned(trade.size);
  const price = cleanUnsigned(trade.price);
  const tradeId = typeof trade.trade_id_str === "string" && trade.trade_id_str.length > 0
    ? trade.trade_id_str
    : Number.isSafeInteger(trade.trade_id) ? String(trade.trade_id) : null;
  if (
    side === null || size === null || price === null || tradeId === null
    || !Number.isSafeInteger(trade.market_id) || trade.market_id < 0
    || !Number.isSafeInteger(trade.timestamp) || trade.timestamp < 0
  ) return null;
  return {
    tradeId,
    marketId: trade.market_id,
    symbol: symbolFor(trade.market_id),
    side,
    // The ask is the maker exactly when `is_maker_ask`; the account is the ask when it sold.
    role: (side === "sell") === trade.is_maker_ask ? "maker" : "taker",
    type: typeof trade.type === "string" && trade.type.length > 0 ? trade.type : "trade",
    size,
    price,
    value: cleanUnsigned(trade.usd_amount),
    // Realized PnL for the account is on ITS side of the fill; the other
    // field is the counterparty's (see the LighterTrade descriptor).
    realizedPnl: cleanDecimal(side === "sell" ? trade.ask_account_pnl : trade.bid_account_pnl),
    timestamp: trade.timestamp,
  };
}

export function projectLighterTradingFills(input: {
  environment: LighterEnvironment;
  accountIndex: number;
  trades: readonly LighterTrade[];
  symbolFor: (marketId: number) => string;
  now: () => number;
}): LighterTradingFills {
  const fills: LighterTradingFill[] = [];
  for (const trade of input.trades) {
    const fill = projectLighterTradingFill(trade, input.accountIndex, input.symbolFor);
    if (fill !== null) fills.push(fill);
    if (fills.length === LIGHTER_TRADING_FILLS_MAX) break;
  }
  fills.sort((a, b) => b.timestamp - a.timestamp);
  return {
    environment: input.environment,
    retrievedAt: input.now(),
    accountIndex: input.accountIndex,
    available: true,
    fills,
  };
}

/**
 * The account's recent fills, projected renderer-safe. Same scope and
 * account resolution as the account read; the trades endpoint always needs
 * the derived read-only authorization, so no auth means `available: false`
 * rather than an error.
 */
export async function readLighterTradingFills(
  environment: LighterEnvironment,
  limit: number = 50,
  client: LighterTradingFillsClient = getLighterClient(),
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<LighterTradingFills> {
  throwIfAborted(signal);
  const unavailable = (accountIndex: number | null): LighterTradingFills => ({
    environment,
    retrievedAt: now(),
    accountIndex,
    available: false,
    fills: [],
  });
  const scopes = listUnlockedLighterTradingCredentialScopes(environment);
  if (scopes.length === 0) return unavailable(null);
  const accountIndex = resolveUniqueLighterAccountIndex(scopes);
  if (accountIndex === null) return unavailable(null);
  const auth = await resolveLighterReadOnlyAccountAuth(environment, accountIndex);
  if (auth === null) return unavailable(accountIndex);

  const symbolFor = await symbolResolver(environment, signal);
  const response = await client.getAccountTrades(
    environment,
    { accountIndex, limit, sortBy: "timestamp" },
    auth,
    { signal },
  );
  return projectLighterTradingFills({
    environment,
    accountIndex,
    trades: response.trades,
    symbolFor,
    now,
  });
}
