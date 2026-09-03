/**
 * Jupiter Lend Borrow position HEALTH - current LTV, distance to liquidation,
 * and the provider's liquidation flag (Agent Scan Phase 3, W4).
 *
 * WHY THIS EXISTS, AND WHY IT IS ATTACHED TO A READ. Until this module, the
 * only LTV/health computation in the tree was
 * `./borrow-risk-preview.ts`, wired into the restricted-mode APPROVAL preview
 * (`../runtime/gates.ts`). An approval preview does not exist in a `full`
 * autonomous session: the agent opened and adjusted leveraged positions with
 * no LTV and no health number anywhere in reach. The owner's ruling
 * (2026-07-25) was DISCLOSE, DO NOT BLOCK - no gate may refuse a leveraged
 * operation for want of a health number. The consequence is the reason this
 * file is written the way it is: **with no gate, this output IS the safety
 * control**, so an uncomputable number must surface as an explicitly NAMED
 * state that an agent cannot mistake for "safe", and never as an absent field
 * or a plausible-looking fabrication.
 *
 * UNITS. Every input here is provider-scaled and none of the scales agree:
 *   - `collateralRaw`/`debtRaw` are raw ATOMIC units of their OWN leg's token
 *     (`JupiterLendBorrowVault.supplyToken.decimals` /
 *     `.borrowToken.decimals`). The two legs routinely differ - a 6-decimal
 *     stable against a 9-decimal WSOL - and reading one with the other's
 *     decimals is a thousandfold error, which is why this module never takes
 *     a single "decimals" argument.
 *   - `liquidationThresholdRaw` is the provider's raw/10 percent scale
 *     ("850" = 85.0%), documented for `collateralFactor` and INFERRED for
 *     `liquidationThreshold` - see `./borrow-projector.ts`'s scale caveat.
 *     That inference is disclosed in the read's own guidance text; it is not
 *     silently treated as fact.
 *   - `*PriceUsd` are the provider's own decimal-string quotes carried on the
 *     vault row. Untrusted text: parsed strictly and rejected unless finite
 *     and strictly positive, because a "0" price is far likelier to be a
 *     provider glitch than a genuinely worthless collateral token, and
 *     valuing collateral at zero would invent a liquidation.
 *
 * MONEY MATH. Exact amounts (the debt total) are bigint string arithmetic and
 * never `Number`. The ONLY floating-point step is the USD/LTV estimate, and
 * it backs off entirely (named `unknown`, not a rounded guess) when an amount
 * has more digits than a `Number` can carry without drift.
 */

/** Amounts with more digits than this are not converted to `Number` - the estimate degrades to a named unknown rather than risk float drift. Mirrors `./borrow-risk-preview.ts`'s identical guard. */
const MAX_SAFE_ESTIMATE_DIGITS = 15;

/** `collateralFactor`/`liquidationThreshold`: raw/10 = percent (one implied decimal digit). */
const LTV_PERCENT_DECIMALS = 1;

/** The sentence every non-computable state must end with. An agent that reads "unknown" as "fine" is the failure mode this module exists to prevent. */
const NOT_SAFE = "This is NOT a statement that this position is safe.";

// ── Liquidation flag ─────────────────────────────────────────────

/**
 * Three-state on purpose. The provider's `isLiquidated` is documented on the
 * position row but was never captured in a non-empty recorded fixture (the
 * only live recording is `[]` - see
 * `src/__tests__/solana/fixtures/lend-borrow/README.md`), so its presence on a
 * real row is not proven. A missing flag collapsed to `false` would tell an
 * autonomous agent a liquidated position is healthy.
 */
export type JupiterLendBorrowLiquidationStatus = "liquidated" | "not_liquidated" | "unknown";

export function readLiquidationStatus(
  isLiquidated: boolean | null | undefined,
): JupiterLendBorrowLiquidationStatus {
  if (isLiquidated === true) return "liquidated";
  if (isLiquidated === false) return "not_liquidated";
  return "unknown";
}

// ── Provider scale parsing (string math only) ────────────────────

/** An unsigned base-10 integer string - the wire convention for every raw amount and threshold on this shelf. */
const UNSIGNED_DIGITS = /^\d+$/;

/** An unsigned decimal (optionally exponential) price string, as the provider writes it. */
const UNSIGNED_DECIMAL = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+(?=\d)/, "");
}

/**
 * Format a raw/10-scaled digit string as an exact percent string by pure
 * decimal-point shifting - no `parseFloat`, no division, so no precision can
 * be invented or lost. `null` for a malformed value: read endpoints are
 * validated permissively, so a bad value degrades to "unknown", never a
 * fabricated percent.
 *
 * Single owner for this scale: `./borrow-projector.ts` (vault + position
 * reads) and `./borrow-risk-preview.ts` (approval preview) both import it,
 * replacing the two hand-copied implementations they carried before.
 */
export function formatTenthsAsPercent(raw: string): string | null {
  const match = /^(-?)(\d+)$/.exec(raw);
  if (!match) return null;
  const sign = match[1] ?? "";
  const digits = match[2];
  if (digits === undefined) return null;
  const padded = digits.padStart(LTV_PERCENT_DECIMALS + 1, "0");
  const wholePart = stripLeadingZeros(padded.slice(0, -LTV_PERCENT_DECIMALS));
  const fractionPart = padded.slice(-LTV_PERCENT_DECIMALS);
  return `${sign}${wholePart}.${fractionPart}%`;
}

/** The same raw/10 scale as a `number`, for the distance-to-liquidation subtraction. `null` for a malformed value. */
export function parseTenthsAsPercentNumber(raw: string): number | null {
  if (!UNSIGNED_DIGITS.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed / 10 ** LTV_PERCENT_DECIMALS : null;
}

/**
 * True total debt = principal + accrued-interest dust. `dustBorrow` is
 * ADDITIONAL to `borrow`, not a component already inside it (see
 * `@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/types.js`), so a
 * reader that shows only `borrow` understates what is owed. Bigint math: a
 * u64 amount exceeds `Number.MAX_SAFE_INTEGER`. `null` for a malformed input
 * - a bad row degrades the one position, it never throws out of the read.
 */
export function sumRawDebt(borrowRaw: string, dustBorrowRaw: string): string | null {
  if (!UNSIGNED_DIGITS.test(borrowRaw) || !UNSIGNED_DIGITS.test(dustBorrowRaw)) return null;
  return (BigInt(borrowRaw) + BigInt(dustBorrowRaw)).toString();
}

// ── Risk ─────────────────────────────────────────────────────────

/**
 * A discriminated union, not an object with nullable numbers: an autonomous
 * agent must be able to branch on ONE field to tell "the numbers below are
 * usable" from "the numbers could not be computed".
 */
export type JupiterLendBorrowPositionRisk =
  | {
      readonly status: "computed";
      /** Collateral valued at the vault's own point-in-time provider price. `"<0.01"` when a real amount is smaller than a cent - never rounded to a bare `"0.00"`. */
      readonly collateralUsd: string;
      /** Total debt (principal + dust) at the vault's own provider price, same convention. */
      readonly debtUsd: string;
      /** debtUsd / collateralUsd, e.g. `"50.00%"`. Compare against the vault's `maxLtvPercent` (borrow ceiling) and `liquidationThresholdPercent`. */
      readonly currentLtvPercent: string;
      /** `liquidationThresholdPercent - currentLtvPercent`, in percentage POINTS (not a percentage of anything). NEGATIVE means the position is already at or past the threshold. */
      readonly ltvPercentagePointsToLiquidation: string;
    }
  | {
      /** Debt is owed against ZERO recorded collateral: the ratio is undefined and unbounded, so it is reported as its own state rather than as a number or as "unknown". */
      readonly status: "undercollateralized";
      readonly collateralUsd: string;
      readonly debtUsd: string;
      readonly note: string;
    }
  | {
      /** The risk numbers could NOT be computed. `reason` always says what is missing and what the agent can do about it. */
      readonly status: "unknown";
      readonly reason: string;
    };

export interface BorrowPositionRiskInput {
  /** For the reason text only - never used in arithmetic. */
  readonly vaultId: string;
  /** Raw atomic units of the COLLATERAL token. */
  readonly collateralRaw: string;
  readonly collateralDecimals: number;
  /** Provider decimal-string USD quote for the collateral token. */
  readonly collateralPriceUsd: string;
  /** Raw atomic units of the DEBT token - principal plus dust (see `sumRawDebt`). */
  readonly debtRaw: string;
  readonly debtDecimals: number;
  readonly debtPriceUsd: string;
  /** Provider raw/10 percent scale (`"850"` = 85.0%). */
  readonly liquidationThresholdRaw: string;
}

/**
 * The ONLY constructor for the `"unknown"` state, so the "unknown is not
 * safe" sentence cannot be forgotten at one of the call sites. Exported for
 * `./borrow-projector.ts`, which reaches the same state for reasons this
 * module cannot see (the vault list failed to load, or the position's vault
 * is missing from it).
 */
export function unknownBorrowPositionRisk(reason: string): JupiterLendBorrowPositionRisk {
  return { status: "unknown", reason: `${reason} ${NOT_SAFE}` };
}

const unknown = unknownBorrowPositionRisk;

/** Provider price text → a usable positive number, or `null`. Untrusted input: strict pattern, then finite + strictly positive. */
function parsePositivePrice(price: string): number | null {
  if (!UNSIGNED_DECIMAL.test(price)) return null;
  const parsed = Number(price);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Raw atomic amount → `bigint`, or `null` for anything that is not an unsigned digit string. */
function parseRawAmount(raw: string): bigint | null {
  return UNSIGNED_DIGITS.test(raw) ? BigInt(raw) : null;
}

/**
 * `10 ** decimals` - the divisor that turns a raw atomic amount into token
 * units - or `null` when the provider's `decimals` cannot produce a usable one.
 *
 * `decimals` reaches here as a plain JSON number off a provider row whose only
 * contract is a compile-time `interface`
 * (`jupiter-lend/borrow-api/types.ts`), so it is untrusted like the prices
 * beside it. Checking the DIVISOR rather than the decimals value keeps one rule
 * instead of a decimals-range policy, and catches the case a result-only check
 * cannot: `10 ** 400` is `Infinity`, so every amount divided by it becomes a
 * FINITE `0` - a real position reported as empty at 0.00% LTV, which is a
 * fabrication an agent would read as "borrow more". The other direction,
 * `10 ** -400 === 0`, divides by zero into `Infinity`.
 */
function tokenUnitDivisor(decimals: number): number | null {
  const divisor = 10 ** decimals;
  return Number.isFinite(divisor) && divisor > 0 ? divisor : null;
}

/**
 * USD estimate for display. `"<0.01"` rather than `"0.00"` for a real but
 * sub-cent value: `"0.00"` would assert the position holds nothing, which is
 * the kind of claim `rules/90-vex-project.md` forbids ("never claim more than
 * the evidence supports").
 */
function formatUsdEstimate(value: number): string {
  if (value === 0) return "0.00";
  if (value < 0.01) return "<0.01";
  return value.toFixed(2);
}

/**
 * Current LTV and distance to liquidation for ONE position, or a named state
 * explaining why neither could be produced. Pure: every provider read the
 * inputs came from happens in the caller.
 */
export function computeBorrowPositionRisk(input: BorrowPositionRiskInput): JupiterLendBorrowPositionRisk {
  const collateralRaw = parseRawAmount(input.collateralRaw);
  const debtRaw = parseRawAmount(input.debtRaw);
  if (collateralRaw === null || debtRaw === null) {
    return unknown(
      `Vault ${input.vaultId} position amounts were not readable as raw atomic integers, so no LTV could be computed.`,
    );
  }

  // Checked BEFORE the price lookups so an enormous position degrades for the
  // reason that actually applies to it.
  if (
    input.collateralRaw.length > MAX_SAFE_ESTIMATE_DIGITS
    || input.debtRaw.length > MAX_SAFE_ESTIMATE_DIGITS
  ) {
    return unknown(
      `This position's collateral or debt is too large to value in floating point without precision loss, so no LTV `
      + `was computed. Compare the raw amounts against the vault's maxLtvPercent / liquidationThresholdPercent yourself.`,
    );
  }

  const liquidationThreshold = parseTenthsAsPercentNumber(input.liquidationThresholdRaw);
  if (liquidationThreshold === null) {
    return unknown(
      `Vault ${input.vaultId} reported an unreadable liquidation threshold, so the distance to liquidation is unknown `
      + `and the LTV below it would be uninterpretable.`,
    );
  }

  const collateralPrice = parsePositivePrice(input.collateralPriceUsd);
  if (collateralPrice === null) {
    return unknown(
      `Vault ${input.vaultId} reported no usable USD price for its collateral token, so no LTV could be computed. `
      + `Re-read solana__lend_borrow_vaults_list for a fresher price.`,
    );
  }
  const debtPrice = parsePositivePrice(input.debtPriceUsd);
  if (debtPrice === null) {
    return unknown(
      `Vault ${input.vaultId} reported no usable USD price for its debt token, so no LTV could be computed. `
      + `Re-read solana__lend_borrow_vaults_list for a fresher price.`,
    );
  }

  const collateralDivisor = tokenUnitDivisor(input.collateralDecimals);
  const debtDivisor = tokenUnitDivisor(input.debtDecimals);
  if (collateralDivisor === null || debtDivisor === null) {
    return unknown(
      `Vault ${input.vaultId} reported token decimals that cannot scale its raw amounts (collateral `
      + `${input.collateralDecimals}, debt ${input.debtDecimals}), so no LTV could be computed and the raw amounts `
      + `cannot be read as token quantities either. Re-read solana__lend_borrow_vaults_list for a usable vault row.`,
    );
  }

  const collateralUsd = (Number(collateralRaw) / collateralDivisor) * collateralPrice;
  const debtUsd = (Number(debtRaw) / debtDivisor) * debtPrice;
  // THE RESULT, not just the inputs. Every input above is individually finite
  // and still the product can overflow - a 15-digit amount against a divisor of
  // `1e-323` is `Infinity`. Reaching `"computed"` with a non-finite value emits
  // `"NaN"`/`"Infinity"` through `toFixed`, under the exact discriminant that
  // tells an autonomous agent the number is usable.
  if (!Number.isFinite(collateralUsd) || !Number.isFinite(debtUsd)) {
    return unknown(
      `Vault ${input.vaultId}'s collateral or debt valuation overflowed to a number this reader cannot represent, `
      + `so no LTV could be computed. Compare the raw amounts against the vault's maxLtvPercent / `
      + `liquidationThresholdPercent yourself, or re-read solana__lend_borrow_vaults_list for fresher prices and decimals.`,
    );
  }

  if (collateralUsd <= 0 && debtUsd > 0) {
    return {
      status: "undercollateralized",
      collateralUsd: formatUsdEstimate(collateralUsd),
      debtUsd: formatUsdEstimate(debtUsd),
      note:
        "Debt is owed against zero recorded collateral, so LTV is undefined and unbounded - it cannot be compared "
        + "against maxLtvPercent or liquidationThresholdPercent. Treat this position as already past liquidation: "
        + "repay it (repayAll) or inspect it on-chain before any operation that increases debt.",
    };
  }

  // Both zero: an empty position. 0% LTV is the true answer, not an unknown.
  const ltvPercent = collateralUsd > 0 ? (debtUsd / collateralUsd) * 100 : 0;
  // The QUOTIENT can overflow where neither operand did: a denormal collateral
  // valuation under an ordinary debt divides to `Infinity`. `Infinity.toFixed(2)`
  // is the string `"Infinity"`, and `"Infinity%"` under `status: "computed"` is
  // a liquidation risk presented as a usable measurement.
  if (!Number.isFinite(ltvPercent)) {
    return unknown(
      `Vault ${input.vaultId}'s debt-to-collateral ratio overflowed to a number this reader cannot represent - the `
      + `collateral valuation is too small relative to the debt to express as a percentage - so no LTV was `
      + `computed. Treat this position as at least severely overleveraged: repay it or add collateral before any `
      + `operation that increases debt or reduces collateral.`,
    );
  }
  // `liquidationThreshold` and `ltvPercent` are both finite and non-negative
  // here, so their difference cannot overflow - no further guard is reachable.
  return {
    status: "computed",
    collateralUsd: formatUsdEstimate(collateralUsd),
    debtUsd: formatUsdEstimate(debtUsd),
    currentLtvPercent: `${ltvPercent.toFixed(2)}%`,
    ltvPercentagePointsToLiquidation: (liquidationThreshold - ltvPercent).toFixed(2),
  };
}
