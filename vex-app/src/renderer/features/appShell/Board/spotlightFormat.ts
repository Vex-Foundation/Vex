/**
 * SPOTLIGHT FORMATTERS - every decision the spotlight makes about words and
 * figures, as pure functions.
 *
 * WHY THEY ARE HERE AND NOT IN THE COMPONENT. Three of them are decisions
 * about honesty rather than about layout - what a lock share may be called,
 * what a buy/sell split is when nobody traded, and which part of the model's
 * assessment may stand under a safety chip - and a decision of that kind
 * belongs somewhere a table test can drive it directly. The component then
 * has no branch of its own to get wrong.
 *
 * MONEY THAT ARRIVES AS TEXT STAYS TEXT. The provider's decimal strings are
 * handed to `boardFormat`'s existing formatters untouched; the only numbers
 * parsed here are ones the PROVIDER itself computed as doubles (a USD volume,
 * a percentage it derived), which the details and spotlight contracts type as
 * `number` precisely so nobody re-derives them from strings.
 */

import type {
  BoardLiquidityLocks,
  BoardPercent,
} from "@shared/schemas/board-details.js";
import type { BoardMomentumRow } from "@shared/schemas/board-spotlight.js";
import { BOARD_EMPTY } from "./boardFormat.js";

/* ------------------------------------------------------------------ */
/* Liquidity lock                                                      */
/* ------------------------------------------------------------------ */

/**
 * What the Liquidity Locked medallion may say.
 *
 * Three arms, and the middle one is the whole reason this is a union. A lock
 * share whose SCALE the provider could not establish might be 89 percent or
 * 0.89 percent, and those are different worlds; it renders as words, never as
 * a number, and never as a filled bar (probe C3, A11 row 9).
 */
export type SpotlightLockView =
  | { readonly kind: "locked"; readonly text: string; readonly fillPct: number }
  | { readonly kind: "unverified"; readonly text: string }
  | { readonly kind: "unavailable"; readonly text: string };

/** The copy of each designed absence. Frozen beside the rule that shows it. */
export const LOCK_UNVERIFIED_TEXT = "n/a - unverified";
export const LOCK_NOT_COVERED_TEXT = "No lock index on this chain";
export const LOCK_NONE_REPORTED_TEXT = "No lock reported";

/**
 * Render `liquidityLocks.lockedPct` and NOTHING else as the lock share.
 *
 * `quickintel.lpBurnedPct` is a different field on a different provider and is
 * never substituted for this one (A5, kept in its original sense by C2).
 *
 * THE TAG IS PART OF THE FIGURE, not decoration. On both chains that answered
 * the probe, the only lock row was tagged `Burned` and `lockedPct` was exactly
 * that burn, so the reader is shown "Locked 99.99% - Burned": dropping burn
 * rows would report zero percent locked for a pool whose LP is permanently
 * gone, which is the more dangerous of the two readings.
 */
export function lockView(locks: BoardLiquidityLocks | null): SpotlightLockView {
  if (locks === null) {
    return { kind: "unavailable", text: LOCK_NOT_COVERED_TEXT };
  }
  const share = locks.lockedPct;
  if (share === null) {
    return { kind: "unavailable", text: LOCK_NONE_REPORTED_TEXT };
  }
  if (share.unit === "unverified" || share.normalizedPct === null) {
    return { kind: "unverified", text: LOCK_UNVERIFIED_TEXT };
  }
  const pct = share.normalizedPct;
  if (!Number.isFinite(pct)) {
    return { kind: "unverified", text: LOCK_UNVERIFIED_TEXT };
  }
  const tags = lockTags(locks);
  const head = `Locked ${formatPercentValue(pct)}%`;
  return {
    kind: "locked",
    text: tags.length === 0 ? head : `${head} - ${tags.join(", ")}`,
    fillPct: Math.max(0, Math.min(100, pct)),
  };
}

/** The distinct provider tags on this pool's lock rows, in provider order. */
export function lockTags(locks: BoardLiquidityLocks): readonly string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const row of locks.rows) {
    const tag = row.tag === null ? "" : row.tag.trim();
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

/**
 * A percent as the reader sees it: at most two decimals, no trailing zeros.
 *
 * `99.99` stays `99.99`, `89.0` becomes `89`, `0.004` becomes `0` - which is
 * why this is DISPLAY only and never feeds a decision.
 */
export function formatPercentValue(pct: number): string {
  if (!Number.isFinite(pct)) return BOARD_EMPTY;
  const rounded = Math.round(pct * 100) / 100;
  return String(rounded);
}

/** A `{raw, normalizedPct, unit}` percent as one display string. */
export function formatBoardPercentUnit(percent: BoardPercent | null): string {
  if (percent === null) return BOARD_EMPTY;
  if (percent.unit === "unverified" || percent.normalizedPct === null) {
    return LOCK_UNVERIFIED_TEXT;
  }
  return `${formatPercentValue(percent.normalizedPct)}%`;
}

/* ------------------------------------------------------------------ */
/* Buy / sell                                                          */
/* ------------------------------------------------------------------ */

export type SpotlightBuySellView =
  | {
      readonly kind: "split";
      readonly buys: number;
      readonly sells: number;
      readonly buyPct: number;
      readonly sellPct: number;
    }
  | { readonly kind: "unavailable"; readonly text: string };

export const BUY_SELL_UNAVAILABLE_TEXT = "No trades reported in this window";

/**
 * The 62 / 38 bar, from the pair row's own trade counts.
 *
 * THE TWO HALVES ALWAYS SUM TO 100. `sellPct` is derived by subtraction
 * rather than rounded independently, because two independently rounded halves
 * produce "62% / 39%" often enough that a reader would eventually see it, and
 * a split that does not add up reads as a bug in the figures rather than in
 * the rounding.
 *
 * A window with no trades is an ABSENCE, not a zero: "0% / 0%" would claim
 * the provider measured a market with no buyers, and a pair minutes old has
 * simply not been asked about yet.
 */
export function buySellView(
  buys: number | null,
  sells: number | null,
): SpotlightBuySellView {
  const b = safeCount(buys);
  const s = safeCount(sells);
  const total = b + s;
  if (total <= 0) {
    return { kind: "unavailable", text: BUY_SELL_UNAVAILABLE_TEXT };
  }
  const buyPct = Math.round((b / total) * 100);
  return { kind: "split", buys: b, sells: s, buyPct, sellPct: 100 - buyPct };
}

function safeCount(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/* ------------------------------------------------------------------ */
/* The model's assessment                                              */
/* ------------------------------------------------------------------ */

/**
 * The FIRST fragment of the model's assessment, for the line under the safety
 * chip.
 *
 * The mockup carries one short muted sentence there and the assessment itself
 * is up to 600 characters of prose (A9), so the line takes the first fragment
 * of the middle-dot style the compose tool teaches. NOTHING IS HIDDEN BY
 * THIS: the whole assessment is rendered, unabridged, by the "VEX assessment"
 * section on the same screen, which is what makes taking a fragment here a
 * layout choice rather than a truncation (the fragment is a complete unit the
 * writer separated, and the rest is one scroll away on the same surface).
 *
 * Fragments are separated by the middle dot the tool teaches or by a line
 * break; a single-fragment assessment returns whole.
 */
export function analysisLead(analysis: string | null): string | null {
  if (analysis === null) return null;
  const trimmed = analysis.trim();
  if (trimmed === "") return null;
  const [first] = trimmed.split(/\s*[·\n]\s*/u);
  const lead = (first ?? "").trim();
  return lead === "" ? null : lead;
}

/** Every fragment of the assessment, in order, for the full section. */
export function analysisFragments(analysis: string | null): readonly string[] {
  if (analysis === null) return [];
  const trimmed = analysis.trim();
  if (trimmed === "") return [];
  return trimmed
    .split(/\s*[·\n]\s*/u)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/* ------------------------------------------------------------------ */
/* Momentum                                                            */
/* ------------------------------------------------------------------ */

export type SpotlightTrend = "up" | "down" | "flat" | "unknown";

export interface SpotlightMomentumView {
  readonly window: BoardMomentumRow["window"];
  /** The window as the reader reads it: `5m`, `1h`, `6h`, `24h`. */
  readonly label: string;
  /** Buyer pressure as a share of the two-sided volume, or the dash. */
  readonly buyShareText: string;
  readonly trend: SpotlightTrend;
  /** Volume per hour, so four windows sit on one axis. */
  readonly rateText: string;
  /**
   * Whether this window's hourly rate runs above or below the 24h baseline -
   * the only form in which "is the move accelerating" is a fact rather than
   * an impression.
   */
  readonly acceleration: "faster" | "slower" | "even" | "unknown";
}

const WINDOW_LABELS: Readonly<Record<BoardMomentumRow["window"], string>> = {
  m5: "5m",
  h1: "1h",
  h6: "6h",
  h24: "24h",
};

export function momentumView(
  row: BoardMomentumRow,
  baselineRatePerHour: number | null,
): SpotlightMomentumView {
  const share = row.buySharePct;
  const trend: SpotlightTrend =
    share === null ? "unknown" : share > 50 ? "up" : share < 50 ? "down" : "flat";
  const rate = row.volumeUsdPerHour;
  const acceleration =
    rate === null || baselineRatePerHour === null || baselineRatePerHour <= 0
      ? "unknown"
      : rate > baselineRatePerHour * 1.1
        ? "faster"
        : rate < baselineRatePerHour * 0.9
          ? "slower"
          : "even";
  return {
    window: row.window,
    label: WINDOW_LABELS[row.window],
    buyShareText: share === null ? BOARD_EMPTY : `${formatPercentValue(share)}%`,
    trend,
    rateText: rate === null ? BOARD_EMPTY : `${formatUsdNumber(rate)}/h`,
    acceleration,
  };
}

/** The 24h window's hourly rate, which every other window is read against. */
export function momentumBaseline(
  rows: readonly BoardMomentumRow[],
): number | null {
  return rows.find((row) => row.window === "h24")?.volumeUsdPerHour ?? null;
}

/* ------------------------------------------------------------------ */
/* Numbers the provider computed as doubles                            */
/* ------------------------------------------------------------------ */

/**
 * A USD figure the PROVIDER computed, formatted compactly.
 *
 * Separate from `formatBoardUsdCompact`, which takes the provider's decimal
 * STRINGS and must never see a float. These values arrive as doubles by
 * contract (the provider derived them itself), so rounding them into strings
 * first would invent a precision it never had.
 */
export function formatUsdNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return BOARD_EMPTY;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${sign}$${trim(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}$${trim(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${trim(abs / 1_000)}K`;
  return `${sign}$${trim(abs)}`;
}

/** A signed USD figure, so a net flow reads as in or out at a glance. */
export function formatSignedUsdNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return BOARD_EMPTY;
  const body = formatUsdNumber(Math.abs(value));
  if (value > 0) return `+${body}`;
  if (value < 0) return `-${body}`;
  return body;
}

function trim(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

/** A wallet count, a trade count: an integer with thousands separators. */
export function formatWholeCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return BOARD_EMPTY;
  return Math.round(value).toLocaleString("en-US");
}

/* ------------------------------------------------------------------ */
/* The tape                                                            */
/* ------------------------------------------------------------------ */

/** A trade's clock, to the second and explicitly UTC. */
export function formatTapeClock(timestampMs: number | null): string {
  if (timestampMs === null || !Number.isFinite(timestampMs)) return BOARD_EMPTY;
  const at = new Date(timestampMs);
  if (Number.isNaN(at.getTime())) return BOARD_EMPTY;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
}

/** The word for a trade side, including the two that are not trades. */
export function tapeSideLabel(side: string | null): string {
  if (side === "buy") return "Buy";
  if (side === "sell") return "Sell";
  if (side === "add") return "Add LP";
  if (side === "remove") return "Remove LP";
  return "Unknown";
}
