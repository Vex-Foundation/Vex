/**
 * Agent Scan field display — the honest readers that turn one
 * `AgentScanEntry` field into the exact text a row prints.
 *
 * The rules this file enforces, all of them contract obligations documented on
 * `shared/schemas/agent-scan-feed.ts`:
 *
 *  - RENDER `displayAmount`, never `amountHuman`/`executedAmount*`. Which of
 *    the stored amounts a row may honestly show for its lifecycle status is
 *    decided ONCE, in main (`agent-activity-amount.ts`, contract C20). The
 *    renderer showing a confirmed row's requested echo would present a quote
 *    as settlement, which is the exact class of defect that discipline exists
 *    to prevent. `null` means show nothing — never a fabricated figure.
 *  - `usdEst` is ALWAYS a quote-time estimate. There is no settlement-time USD
 *    repricing anywhere in this feed, so even a CONFIRMED row's USD is an
 *    estimate and must carry the explicit `~ … est.` marker.
 *  - `amountBasis === "estimated"` marks the leg amounts themselves as quoted,
 *    so they get the same `~` treatment the token-history feed uses (R14).
 *  - `displaySymbol` is MAIN-RESOLVED (it is what annotates an EVM native leg
 *    as `NATIVE (ETH)`). The renderer prints it and never derives a native
 *    ticker itself — it has no chain registry and must not grow one.
 */

import type {
  AgentScanEntry,
  AgentScanTokenLeg,
} from "@shared/schemas/agent-scan-feed.js";
import { formatClock, formatUsd, truncateAddress } from "../../../../lib/format.js";
import { amountDisplay } from "../../../../lib/token-leg-display.js";

/**
 * The leg's display label: the main-resolved `displaySymbol` first (it alone
 * carries the native annotation), then the sanitized stored symbol, then a
 * truncated address. Never the raw address in full, never a derived ticker.
 */
export function legSymbolText(leg: AgentScanTokenLeg): string {
  if (leg.displaySymbol !== null && leg.displaySymbol.length > 0) {
    return leg.displaySymbol;
  }
  if (leg.symbol !== null && leg.symbol.length > 0) return leg.symbol;
  return leg.address !== null ? truncateAddress(leg.address) : "-";
}

/**
 * The leg's renderable quantity, or null when the honest answer is "show
 * nothing". `displayAmount` has already passed main's status-aware C20 gate,
 * so it is trusted human units here — including a whole number with no
 * decimal point (contract C27).
 */
export function legAmountText(leg: AgentScanTokenLeg): string | null {
  if (leg.displayAmount === null) return null;
  return amountDisplay(leg.displayAmount, true);
}

/** True when this row's shown amounts are QUOTED, not independently verified. */
export function isEstimatedBasis(entry: AgentScanEntry): boolean {
  return entry.amountBasis === "estimated";
}

/**
 * The row's primary USD figure. Output leads, input is the fallback; ALWAYS
 * rendered with the `~ … est.` marker because this feed carries no
 * settlement-time USD at all. `null` when unpriced — never a fabricated $0.00.
 */
export function primaryUsdEstText(entry: AgentScanEntry): string | null {
  const raw = entry.output.usdEst ?? entry.input.usdEst;
  if (raw === null) return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return null;
  return `~${formatUsd(parsed)} est.`;
}

/** A USD decimal string → `~$X est.`; null when absent/unparseable. */
export function usdEstText(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? `~${formatUsd(parsed)} est.` : null;
}

/**
 * Where the row executed. A bridge names its route (`base → arbitrum`) from
 * the resolved endpoints; everything else names its own chain. Empty when the
 * DTO carries no chain text at all — the row simply omits the segment.
 */
export function chainRouteText(entry: AgentScanEntry): string | null {
  const from = entry.fromChain?.slug ?? null;
  const to = entry.toChain?.slug ?? null;
  if (from !== null && to !== null && from.length > 0 && to.length > 0) {
    return `${from.toLowerCase()} → ${to.toLowerCase()}`;
  }
  const own = entry.chainSlug;
  return own !== null && own.length > 0 ? own.toLowerCase() : null;
}

/** HH:MM for the row's time cell; null for an unparseable timestamp. */
export function entryClockText(iso: string): string | null {
  return formatClock(iso);
}

/** Stable day bucket key (UTC-free local day) for the feed's date grouping. */
export function dayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** "Mon, Jul 20" — the day divider label. Falls back for unparseable input. */
export function dayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** "Jun 12 · 14:05" — used by the detail panel's last-checked line. */
export function timestampText(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const clock = formatClock(iso);
  return clock === null ? day : `${day} · ${clock}`;
}

/**
 * The Vex integrator fee actually recorded on the row, token-denominated.
 * `null` when the row records no fee, or when the fee carries no readable
 * amount — a fee line with no number would be worse than no line.
 */
export function vexFeeText(entry: AgentScanEntry): string | null {
  const fee = entry.vexFee;
  if (fee === null || fee.amountHuman === null) return null;
  const amount = amountDisplay(fee.amountHuman, true);
  if (amount === null) return null;
  return fee.tokenSymbol !== null && fee.tokenSymbol.length > 0
    ? `${amount} ${fee.tokenSymbol}`
    : amount;
}
