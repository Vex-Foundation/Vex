import type { LighterTradingAccount } from "@shared/schemas/lighter-trading.js";

export type LighterPositionRow = LighterTradingAccount["positions"][number];
export type LighterOpenOrderRow = LighterTradingAccount["openOrders"][number];
export type PositionCloseStage = "preparing" | "approval" | "checking" | "resting" | "uncertain";
export type OrderCancelStage = "preparing" | "approval" | "checking" | "uncertain";

function finite(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface PositionMetrics {
  /** Live mark for the active market; otherwise the snapshot's notional over size. */
  readonly mark: number | null;
  /** Collateral the position holds: Lighter's allocation when isolated, else notional × IMF. */
  readonly margin: number | null;
  /** Position leverage as `10000 / IMF`, null when the row carried no terms. */
  readonly leverage: number | null;
  /** Unrealized PnL over margin, as a fraction. */
  readonly roe: number | null;
}

export function positionMetrics(position: LighterPositionRow, liveMark: number | null): PositionMetrics {
  const size = finite(position.size);
  const value = finite(position.value);
  const mark = liveMark ?? (size !== null && size > 0 && value !== null ? value / size : null);
  // Lighter allocates margin only to isolated positions. A cross row reports
  // `allocated_margin` 0, which read as "0.00 margin" and hid the ROE, so a
  // cross position's margin is its notional times its fraction.
  const allocatedValue = finite(position.allocatedMargin);
  const allocated = position.marginMode !== "cross" && allocatedValue !== null && allocatedValue > 0
    ? allocatedValue
    : null;
  const imf = position.initialMarginFraction;
  const margin = allocated ?? (value !== null && imf !== null && imf > 0 ? (value * imf) / 10_000 : null);
  const pnl = finite(position.unrealizedPnl);
  return {
    mark,
    margin,
    leverage: imf !== null && imf > 0 ? 10_000 / imf : null,
    roe: pnl !== null && margin !== null && margin > 0 ? pnl / margin : null,
  };
}

/** Portions the positions table can close; 1 is the whole position. */
export const CLOSE_PORTIONS = [1, 0.75, 0.5, 0.25] as const;
export type ClosePortion = (typeof CLOSE_PORTIONS)[number];

/**
 * A portion of a position's size, floored to the market's size decimals so
 * the order is one the book accepts. Integer math on the decimal string keeps
 * 0.00051 × 0.75 exact where floats would not.
 */
export function portionOfSize(size: string, portion: ClosePortion, sizeDecimals: number): string {
  const [whole, fraction = ""] = size.split(".");
  const units = BigInt(`${whole}${fraction.padEnd(sizeDecimals, "0").slice(0, sizeDecimals)}`);
  const scaled = (units * BigInt(Math.round(portion * 100))) / 100n;
  const digits = scaled.toString().padStart(sizeDecimals + 1, "0");
  const head = digits.slice(0, digits.length - sizeDecimals);
  const tail = digits.slice(digits.length - sizeDecimals).replace(/0+$/, "");
  return tail === "" ? head : `${head}.${tail}`;
}

export interface PositionProtection {
  readonly stopLoss: LighterOpenOrderRow | null;
  readonly takeProfit: LighterOpenOrderRow | null;
}

/**
 * The resting reduce-only trigger orders that guard a position: same market,
 * closing side. Lighter's type string names the leg when it can; otherwise the
 * trigger's side of the entry price decides.
 */
export function positionProtection(position: LighterPositionRow, orders: readonly LighterOpenOrderRow[]): PositionProtection {
  const closeSide = position.side === "long" ? "sell" : "buy";
  const entry = finite(position.entryPrice);
  let stopLoss: LighterOpenOrderRow | null = null;
  let takeProfit: LighterOpenOrderRow | null = null;
  for (const order of orders) {
    if (order.marketId !== position.marketId || order.side !== closeSide || order.reduceOnly !== true || order.triggerPrice === null) continue;
    const type = order.type?.toLowerCase() ?? "";
    const trigger = finite(order.triggerPrice);
    const isStop = type.includes("stop") ? true
      : type.includes("take") ? false
        : entry !== null && trigger !== null ? (position.side === "long" ? trigger < entry : trigger > entry)
          : null;
    if (isStop === true) stopLoss ??= order;
    else if (isStop === false) takeProfit ??= order;
  }
  return { stopLoss, takeProfit };
}

/** Share of collateral the account has committed, 0..1; null when unreadable. */
export function marginUsage(summary: LighterTradingAccount["summary"]): number | null {
  const collateral = finite(summary?.collateral ?? null);
  const available = finite(summary?.availableBalance ?? null);
  if (collateral === null || available === null || collateral <= 0) return null;
  return Math.min(1, Math.max(0, (collateral - available) / collateral));
}

export interface AccountRisk {
  /** Collateral plus unrealized PnL: what closing everything at mark would leave. */
  readonly equity: number | null;
  readonly available: number | null;
  readonly unrealizedPnl: number | null;
  /** Collateral the open positions hold, `collateral − available`. */
  readonly marginUsed: number | null;
  /** Unrealized PnL over the margin holding it, as a fraction. */
  readonly roe: number | null;
  readonly usage: number | null;
}

/** The account-level numbers a perp desk keeps in view; null where the read had none. */
export function accountRisk(summary: LighterTradingAccount["summary"]): AccountRisk {
  const collateral = finite(summary?.collateral ?? null);
  const available = finite(summary?.availableBalance ?? null);
  const unrealizedPnl = finite(summary?.unrealizedPnl ?? null);
  const marginUsed = collateral !== null && available !== null ? Math.max(0, collateral - available) : null;
  return {
    equity: collateral === null ? null : collateral + (unrealizedPnl ?? 0),
    available,
    unrealizedPnl,
    marginUsed,
    roe: unrealizedPnl !== null && marginUsed !== null && marginUsed > 0 ? unrealizedPnl / marginUsed : null,
    usage: marginUsage(summary),
  };
}
