/**
 * Raw base-unit → human amount, for DISPLAY surfaces only.
 *
 * `rules/90-vex-project.md`: "Raw amounts must travel with the decimals needed
 * to read them" — `"1047061"` is 1.05 at 6 decimals and 0.00105 at 9. Four
 * copies of this conversion had grown across the protocol handlers and the
 * transactions repo; this is their single owner, so a correction lands once.
 *
 * It NEVER throws and NEVER guesses: a missing raw amount, missing decimals or
 * a malformed value yields `null`, because on a display path a missing amount
 * is safer than a wrong one. Callers that prefer a different degradation (the
 * raw passthrough, `undefined`, `0`) apply it at their own call site — the
 * per-protocol degradation is the caller's contract, not this owner's.
 *
 * DISPLAY ONLY. The machine fields (`amountRaw`, `routeSummary.amountOut`,
 * `input_amount`, …) keep their raw values verbatim; a humanized figure travels
 * ALONGSIDE them in the human layer, never in place of them.
 */

import { formatUnits } from "viem";

export function formatRawAmount(
  raw: string | bigint | null | undefined,
  decimals: number | null | undefined,
): string | null {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try {
    return formatUnits(BigInt(raw), decimals);
  } catch {
    return null;
  }
}

/** Both native display units below are 9 decimals from their base unit. */
const NATIVE_SUBUNIT_DECIMALS = 9;

/**
 * Wei as GWEI, for gas PRICES only.
 *
 * A gas price is the one launch figure whose bare integer reads as a plausible
 * gwei number: `22518000` wei is 0.0225 gwei, and an agent that reads it as
 * 22.5 is off by a thousand on the number it prices a transaction from. Gas
 * UNITS (`gasEstimate`, `gasLimitWithHeadroom`) are unitless counts and must
 * never be passed here.
 */
export function formatWeiAsGwei(wei: string | bigint | null | undefined): string | null {
  return formatRawAmount(wei, NATIVE_SUBUNIT_DECIMALS);
}

/** Lamports as SOL. Same reason: a bare lamport figure is unreadable as a price. */
export function formatLamportsAsSol(lamports: string | bigint | number | null | undefined): string | null {
  if (typeof lamports === "number") {
    return Number.isSafeInteger(lamports) ? formatRawAmount(BigInt(lamports), NATIVE_SUBUNIT_DECIMALS) : null;
  }
  return formatRawAmount(lamports, NATIVE_SUBUNIT_DECIMALS);
}

// ── Agent-facing balance rows ───────────────────────────────────

/**
 * Upper bound on token decimals, from MetaMask's own token guard
 * (`TokensController.ts:1069-1073`). No real token exceeds it, and a provider
 * that reports more is reporting a value we cannot convert from.
 */
export const MAX_TOKEN_DECIMALS = 36;

/**
 * Strict decimals guard, used BEFORE any conversion.
 *
 * `Number.isInteger` is the primitive that matters: it is the only one of the
 * usual checks that rejects `Infinity`, which `!Number.isNaN(v)` accepts and
 * which then poisons every downstream scale. `0` is a LEGITIMATE value, so
 * callers must default with `??` and never `||`.
 */
export function isTokenDecimals(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_TOKEN_DECIMALS
  );
}

/** Why a row's human amount could not be derived. Named, never a bare null. */
export type UnprojectableBalanceReason =
  | "balance_raw_missing"
  | "balance_raw_not_an_integer"
  | "decimals_invalid";

/**
 * The derived half of an agent-visible balance row.
 *
 * `balance` is the FULL-PRECISION human amount as a STRING. There is
 * deliberately no rounded sibling: a rounded field is a field the model can
 * size a trade from, and sizing belongs to `balanceRaw` plus `decimals`.
 *
 * `valueUsd` is an explicitly DISPLAY-GRADE estimate. The provider price is a
 * float, so this figure is not authoritative and never gates a spend.
 */
export interface BalanceProjection {
  readonly balance: string | null;
  readonly valueUsd: string | null;
  readonly priceUnavailable?: true;
  readonly unprojectableReason?: UnprojectableBalanceReason;
}

/** An exact base-10 integer, which is the only raw amount we will convert. */
const EXACT_INTEGER = /^[+-]?\d+$/;

/**
 * USD estimate precision. Sub-dollar values keep more places so dust does not
 * render as a flat `0`; this is a DISPLAY figure and is documented as such in
 * the tool descriptions that carry it.
 */
const USD_ESTIMATE_DECIMALS_BELOW_ONE = 12;
const USD_ESTIMATE_DECIMALS = 8;

/** `toFixed` switches to exponent notation at and above this magnitude. */
const TO_FIXED_EXPONENT_THRESHOLD = 1e21;

function formatUsdEstimate(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= TO_FIXED_EXPONENT_THRESHOLD) return BigInt(Math.round(value)).toString();
  const fixed = value.toFixed(
    magnitude < 1 ? USD_ESTIMATE_DECIMALS_BELOW_ONE : USD_ESTIMATE_DECIMALS,
  );
  const trimmed = fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

/** A usable USD price feed: a finite, non-negative number. `0` IS a feed. */
function readPriceUsd(price: string | number | null | undefined): number | null {
  if (price === null || price === undefined) return null;
  if (typeof price === "number") return Number.isFinite(price) && price >= 0 ? price : null;
  const trimmed = price.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Derive the agent-visible half of one balance row.
 *
 * This is the ONE place a raw base-unit balance becomes a human amount for a
 * model to read. It exists because a model handed a bare 16-digit integer and
 * told to divide it will eventually divide it wrong: a real session read
 * `9873301706589007` at 18 decimals as 9.87 WETH instead of 0.009873 and sized
 * a trade against the difference, in the same reasoning block in which it
 * divided two other 22-digit values correctly. The fix is to stop asking.
 *
 * FAIL-OPEN ON THE ROW, FAIL-CLOSED ON THE NUMBER: a row we cannot convert
 * keeps its identity, its `balanceRaw` and a NAMED `unprojectableReason`, and
 * reports `balance: null`. It is never dropped (that would read as "you hold
 * none of it") and its decimals are never guessed at 18.
 *
 * A missing price gives `valueUsd: null` plus `priceUnavailable: true`, NEVER
 * `valueUsd: 0`: zero as "I do not know" is a one-way door, and both wallet
 * references have shipped that bug.
 */
export function projectBalanceRow(
  balanceRaw: string | bigint | number | null | undefined,
  decimals: unknown,
  priceUsd: string | number | null | undefined,
): BalanceProjection {
  const price = readPriceUsd(priceUsd);
  const priceFlag = price === null ? ({ priceUnavailable: true } as const) : {};

  const unprojectable = (reason: UnprojectableBalanceReason): BalanceProjection => ({
    balance: null,
    valueUsd: null,
    ...priceFlag,
    unprojectableReason: reason,
  });

  if (balanceRaw === null || balanceRaw === undefined) return unprojectable("balance_raw_missing");

  let raw: bigint;
  if (typeof balanceRaw === "bigint") {
    raw = balanceRaw;
  } else if (typeof balanceRaw === "number") {
    // A provider that could only give a float has already lost the low digits;
    // reconstructing them would be a guess (C1.3).
    if (!Number.isSafeInteger(balanceRaw)) return unprojectable("balance_raw_not_an_integer");
    raw = BigInt(balanceRaw);
  } else {
    const trimmed = balanceRaw.trim();
    if (trimmed === "") return unprojectable("balance_raw_missing");
    if (!EXACT_INTEGER.test(trimmed)) return unprojectable("balance_raw_not_an_integer");
    raw = BigInt(trimmed);
  }

  if (!isTokenDecimals(decimals)) return unprojectable("decimals_invalid");

  const balance = formatRawAmount(raw, decimals);
  if (balance === null) return unprojectable("balance_raw_not_an_integer");

  if (price === null) return { balance, valueUsd: null, priceUnavailable: true };
  return { balance, valueUsd: formatUsdEstimate(Number(balance) * price) };
}
