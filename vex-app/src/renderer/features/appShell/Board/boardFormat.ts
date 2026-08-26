/**
 * BOARD FORMATTING - decimal STRINGS in, display text out, no float anywhere.
 *
 * Board hydration carries every money figure as a decimal string precisely so
 * it survives a memecoin price like `0.0000000000001234567`. Handing such a
 * string to `Number()` to format it would throw that away at the last
 * possible moment, so these functions do their arithmetic on the digits
 * themselves: magnitude comes from counting characters, not from `log10`.
 *
 * Digits beyond the displayed precision are TRUNCATED toward zero rather than
 * rounded, so a rendered figure is never larger than the real one. The whole
 * value always remains available to the reader - every call site that shows a
 * shortened figure also carries the raw decimal string in a `title`.
 *
 * `renderer/lib/format.ts` keeps its number-based formatters for the market
 * rail, whose IPC schema is numeric. These are deliberately separate: the
 * inputs are different types with different precision guarantees, and merging
 * them would mean parsing a decimal string to reuse a numeric formatter.
 */

/** The dash a missing figure renders as. Never a fabricated zero. */
export const BOARD_EMPTY = "-";

interface DecimalParts {
  readonly negative: boolean;
  /** Integer digits, no sign, leading zeros stripped ("" means zero). */
  readonly int: string;
  /** Fractional digits, no dot. May be "". */
  readonly frac: string;
}

/**
 * Split a decimal string into sign / integer / fraction without parsing it.
 * Returns null for anything that is not a plain decimal numeral, which is the
 * fail-closed branch: an unparseable figure renders as the empty dash rather
 * than as a guess.
 */
export function parseDecimalString(value: string): DecimalParts | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) return null;
  const [, sign, rawInt, rawFrac] = match;
  if (rawInt === undefined) return null;
  return {
    negative: sign === "-",
    int: rawInt.replace(/^0+(?=\d)/, "").replace(/^0$/, ""),
    frac: rawFrac ?? "",
  };
}

/** Pad `frac` to at least `n` digits, then take the first `n`. */
function fracSlice(frac: string, n: number): string {
  return frac.padEnd(n, "0").slice(0, n);
}

/**
 * USD price from a decimal string.
 *
 * `>= 1` shows 2 decimals; `>= 0.01` shows 4; below that the precision grows
 * to keep four significant digits past the run of leading zeros, so
 * `0.00000000000012345` reads `$0.00000000000012` rather than `$0.00`. The
 * cap is 18 fractional digits, which is past every token decimal we serve.
 */
export function formatBoardPriceUsd(value: string | null): string {
  if (value === null) return BOARD_EMPTY;
  const parts = parseDecimalString(value);
  if (parts === null) return BOARD_EMPTY;
  const sign = parts.negative ? "-" : "";
  if (parts.int !== "") {
    return `${sign}$${parts.int}.${fracSlice(parts.frac, 2)}`;
  }
  const leadingZeros = /^0*/.exec(parts.frac)?.[0].length ?? 0;
  if (leadingZeros === 0 && parts.frac !== "") {
    return `${sign}$0.${fracSlice(parts.frac, 4)}`;
  }
  if (parts.frac === "" || /^0+$/.test(parts.frac)) return "$0.00";
  if (leadingZeros === 1) {
    return `${sign}$0.${fracSlice(parts.frac, 4)}`;
  }
  const digits = Math.min(18, leadingZeros + 4);
  return `${sign}$0.${fracSlice(parts.frac, digits)}`;
}

const MAGNITUDES: readonly (readonly [number, string])[] = [
  [10, "B"],
  [7, "M"],
  [4, "K"],
];

/**
 * Compact USD for liquidity and volume: `$75.2K`, `$1.4M`, `$2.3B`. The
 * magnitude comes from the COUNT of integer digits, so an amount far beyond
 * `Number.MAX_SAFE_INTEGER` still lands in the right bucket.
 */
export function formatBoardUsdCompact(value: string | null): string {
  if (value === null) return BOARD_EMPTY;
  const parts = parseDecimalString(value);
  if (parts === null) return BOARD_EMPTY;
  const sign = parts.negative ? "-" : "";
  const int = parts.int;
  if (int === "") {
    // Below one dollar: show cents rather than a misleading `$0`.
    return `${sign}$0.${fracSlice(parts.frac, 2)}`;
  }
  for (const [minDigits, suffix] of MAGNITUDES) {
    if (int.length >= minDigits) {
      const whole = int.slice(0, int.length - (minDigits - 1));
      const tenth = int.charAt(int.length - (minDigits - 1));
      return `${sign}$${whole}.${tenth}${suffix}`;
    }
  }
  return `${sign}$${int}.${fracSlice(parts.frac, 2)}`;
}

/** True when every digit of a parsed decimal is zero. */
function isZero(parts: DecimalParts): boolean {
  return parts.int === "" && /^0*$/.test(parts.frac);
}

/**
 * Signed percent change, from the SIGNED decimal string hydration carries.
 *
 * The sign is taken from the parsed string rather than from a comparison
 * against zero, so `-0.00004` reads as a negative move that rounds to
 * `-0.00%` instead of silently flipping to positive.
 */
export function formatBoardPercent(value: string | null): string {
  if (value === null) return BOARD_EMPTY;
  const parts = parseDecimalString(value);
  if (parts === null) return BOARD_EMPTY;
  if (isZero(parts)) return "0.00%";
  const sign = parts.negative ? "-" : "+";
  const whole = parts.int === "" ? "0" : parts.int;
  return `${sign}${whole}.${fracSlice(parts.frac, 2)}%`;
}

/** Direction of a price change, for the semantic status tone. */
export type BoardTrend = "up" | "down" | "flat";

export function boardTrend(value: string | null): BoardTrend {
  if (value === null) return "flat";
  const parts = parseDecimalString(value);
  if (parts === null || isZero(parts)) return "flat";
  return parts.negative ? "down" : "up";
}

/** Compact integer count for buy/sell tallies: `1.2K`, `354`. */
export function formatBoardCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return BOARD_EMPTY;
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${Math.trunc(value)}`;
}

/** Pair age as a coarse human span: `3d`, `7h`, `12m`, `new`. */
export function formatBoardAge(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return BOARD_EMPTY;
  }
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) return `${hours}h`;
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 1) return `${minutes}m`;
  return "new";
}

/**
 * Whether a board's market data has outlived its declared freshness window.
 *
 * A persisted board is a snapshot taken when the agent composed it, so this
 * is almost always true for a board read back out of the transcript. That is
 * the honest answer and the surface says so in words, not just in a dimmed
 * pixel.
 */
export function isBoardMarketDataStale(
  marketDataFetchedAt: number,
  staleAfterMs: number,
  now: number,
): boolean {
  return now - marketDataFetchedAt >= staleAfterMs;
}

/** Absolute clock for a board timestamp, e.g. `14:32`. Null when unusable. */
export function formatBoardClock(epochMs: number): string | null {
  if (!Number.isFinite(epochMs)) return null;
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
