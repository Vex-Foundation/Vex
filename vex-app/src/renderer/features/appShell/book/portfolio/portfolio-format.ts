/**
 * The Portfolio page's figure words (docs/design/R3-MINIMAL.md section 9.1).
 *
 * A page has room the old side panel did not, so money reads in full ("$12,345.67",
 * never "$12.3K"), every figure in JetBrains Mono at the call site. A value
 * the read does not carry says "Not available", the same word the web app
 * uses; it is never a zero, a dash or a sample figure.
 */

import { formatClock, formatTokenPriceUsd } from "../../../../lib/format.js";

/** What a figure the read does not carry says, on every money page. */
export const NOT_AVAILABLE = "Not available";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** A finite number, or null for anything a figure cannot honestly show. */
function finite(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null
    : value;
}

/** `$12,345.67`; null when the read carries no figure. */
export function usdFigure(value: number | null | undefined): string | null {
  const v = finite(value);
  return v === null ? null : USD.format(v);
}

/** `+$9.00` / `-$4.10` / `$0.00`; null when the read carries no figure. */
export function usdDeltaFigure(value: number | null | undefined): string | null {
  const v = finite(value);
  if (v === null) return null;
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return `${sign}${USD.format(Math.abs(v))}`;
}

/**
 * A token's unit price as the valuation used it: its USD value over its
 * quantity. Null when either is missing or the quantity is not positive, so a
 * row without a valuation never shows a price.
 */
export function unitPriceUsd(
  balanceUsd: number | null | undefined,
  amount: number | null | undefined,
): number | null {
  const value = finite(balanceUsd);
  const quantity = finite(amount);
  if (value === null || quantity === null || quantity <= 0) return null;
  return value / quantity;
}

/**
 * A unit price: `$2,598.09` from one dollar up, the adaptive small-price form
 * below it (`$0.0005430`); null when there is no price.
 */
export function priceFigure(value: number | null | undefined): string | null {
  const v = finite(value);
  if (v === null) return null;
  return Math.abs(v) >= 1 ? USD.format(v) : formatTokenPriceUsd(v);
}

/** Local HH:MM for an epoch in ms (a query's own fetch time); null when unknown. */
export function clockFromMs(ms: number | null | undefined): string | null {
  const v = finite(ms);
  if (v === null || v <= 0) return null;
  return formatClock(new Date(v).toISOString());
}
