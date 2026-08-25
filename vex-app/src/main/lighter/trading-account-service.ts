import type { LighterEnvironment } from "@tools/lighter/constants.js";
import { getLighterClient, type LighterClient } from "@tools/lighter/client.js";
import type {
  LighterAccount,
  LighterAccountAsset,
  LighterAccountOrder,
  LighterAccountPosition,
} from "@tools/lighter/types.js";
import type {
  LighterTradingAccount,
  LighterTradingAsset,
  LighterTradingOpenOrder,
  LighterTradingPosition,
} from "@shared/schemas/lighter-trading.js";
import { resolveLighterReadOnlyAccountAuth } from "@vex-agent/tools/protocols/lighter/read-account-auth.js";
import { listUnlockedLighterTradingCredentialScopes } from "../secrets/lighter-trading-credential.js";
import { readLighterTradingMarketList } from "./trading-panel-service.js";
import { log } from "../logger/index.js";

const MAX_ROWS = 200;
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const UNSIGNED_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Renderer-safe subset of the trading client used by the account panel. */
export interface LighterTradingAccountClient {
  getAccount: LighterClient["getAccount"];
  getAccountActiveOrders: LighterClient["getAccountActiveOrders"];
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
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
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
  };
}

function projectOrder(
  raw: LighterAccountOrder,
  symbolFor: (marketId: number) => string,
): LighterTradingOpenOrder | null {
  const orderId = typeof raw.order_id === "string" ? raw.order_id.trim() : "";
  if (orderId.length === 0) return null;
  const marketId = raw.market_index;
  const side = raw.is_ask === undefined
    ? raw.side === "sell" || raw.side === "ask"
      ? "sell"
      : raw.side === "buy" || raw.side === "bid"
        ? "buy"
        : null
    : raw.is_ask ? "sell" : "buy";
  if (side === null) return null;
  const type = typeof raw.type === "string" && raw.type.trim().length > 0 ? raw.type : null;
  const status = typeof raw.status === "string" && raw.status.trim().length > 0 ? raw.status : null;
  return {
    orderId,
    marketId,
    symbol: symbolFor(marketId),
    side,
    type,
    price: cleanUnsigned(raw.price),
    size: cleanUnsigned(raw.initial_base_amount),
    remaining: cleanUnsigned(raw.remaining_base_amount),
    status,
    createdAt: nonNegativeInt(raw.created_at) ?? nonNegativeInt(raw.timestamp),
  };
}

function projectAsset(raw: LighterAccountAsset): LighterTradingAsset | null {
  const balance = cleanUnsigned(raw.balance);
  const locked = cleanUnsigned(raw.locked_balance);
  const marginBalance = cleanUnsigned(raw.margin_balance);
  // Surface any asset the account actually holds — spot balance, locked, or
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
): Promise<(marketId: number) => string> {
  try {
    const markets = await readLighterTradingMarketList(environment);
    const byId = new Map(markets.markets.map((market) => [market.marketId, market.symbol]));
    return (marketId) => byId.get(marketId) ?? `#${marketId}`;
  } catch {
    return (marketId) => `#${marketId}`;
  }
}

function unavailable(
  environment: LighterEnvironment,
  now: () => number,
): LighterTradingAccount {
  return {
    environment,
    retrievedAt: now(),
    status: "unavailable",
    accountIndex: null,
    openOrdersAvailable: false,
    summary: null,
    assets: [],
    positions: [],
    openOrders: [],
  };
}

/**
 * Reads the authenticated Light it up account panel. The owning account is
 * resolved from the unlocked trading scope — the renderer never supplies an
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
  readonly openOrdersAvailable: boolean;
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
  const assets = (input.account?.assets ?? [])
    .map(projectAsset)
    .filter((row): row is LighterTradingAsset => row !== null)
    .slice(0, MAX_ROWS);
  const openOrders = input.openOrdersAvailable
    ? input.orders
        .map((row) => projectOrder(row, input.symbolFor))
        .filter((row): row is LighterTradingOpenOrder => row !== null)
        .slice(0, MAX_ROWS)
    : [];

  const unrealizedPnl = positions.reduce<DecimalParts | null>((sum, position) => {
    if (position.unrealizedPnl === null) return sum;
    const value = decimalParts(position.unrealizedPnl);
    return value === null ? sum : addDecimalParts(sum, value);
  }, null);

  return {
    environment: input.environment,
    retrievedAt: input.now(),
    status: "ready",
    accountIndex: input.accountIndex,
    openOrdersAvailable: input.openOrdersAvailable,
    summary: {
      collateral: cleanDecimal(input.account?.collateral),
      availableBalance: cleanDecimal(input.account?.available_balance),
      unrealizedPnl: unrealizedPnl === null ? null : formatDecimal(unrealizedPnl),
    },
    assets,
    positions,
    openOrders,
  };
}

export async function readLighterTradingAccount(
  environment: LighterEnvironment,
  client: LighterTradingAccountClient = getLighterClient(),
  now: () => number = Date.now,
): Promise<LighterTradingAccount> {
  const scopes = listUnlockedLighterTradingCredentialScopes(environment);
  // Multiple API keys for one account are equivalent for this read-only
  // projection. Multiple distinct accounts are not: the renderer supplies no
  // account identity, so main must fail closed instead of choosing by sort
  // order and displaying an arbitrary account.
  const accountIndex = resolveUniqueLighterAccountIndex(scopes);
  if (accountIndex === null) return unavailable(environment, now);

  const symbolFor = await symbolResolver(environment);
  const accountResponse = await client.getAccount(environment, {
    by: "index",
    value: accountIndex,
  });
  const account = findOwningLighterAccount(accountResponse.accounts, accountIndex);
  if (account === null) {
    throw new Error("Lighter did not return the credential-bound account.");
  }

  let orders: readonly LighterAccountOrder[] = [];
  let openOrdersAvailable = false;
  const auth = await resolveLighterReadOnlyAccountAuth(environment, accountIndex);
  if (auth !== null) {
    try {
      const ordersResponse = await client.getAccountActiveOrders(
        environment,
        { accountIndex },
        auth,
      );
      orders = ordersResponse.orders;
      openOrdersAvailable = true;
    } catch {
      // Provider errors may echo request context. Keep this secret-adjacent
      // auth failure diagnostic bounded and never attach the raw cause.
      log.warn("[lighter-trading] active orders read failed", { environment, accountIndex });
    }
  }

  return projectLighterTradingAccount({
    environment,
    accountIndex,
    account,
    orders,
    openOrdersAvailable,
    symbolFor,
    now,
  });
}
