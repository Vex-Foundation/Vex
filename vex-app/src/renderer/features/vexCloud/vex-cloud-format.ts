/**
 * Vex Cloud figures for display, from the raw values main hands over.
 *
 * Integer arithmetic only (rule 90: never floating point for token amounts):
 * a balance is wei as a decimal string with its 18 decimals, the USD figure
 * is integer micro-USD. Both round DOWN, so the screen never shows more than
 * the account holds. A missing value is `null` and the caller writes
 * "Not available"; nothing here invents a number.
 */

import type { VexCloudAmount, VexCloudRate } from "@shared/schemas/vex-cloud.js";
import { parseRateX18, weiToMicroUsdFloor } from "@shared/vex-cloud-money.js";

/** The words a missing figure reads as (ELEMENTS law 7). */
export const NOT_AVAILABLE = "Not available";

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * `1234567891234567891234` wei -> `1,234.56 VEX` (two decimals, rounded down).
 * A positive amount under 0.01 reads `less than 0.01 VEX`, never `0.00`.
 */
export function formatVexAmount(amount: VexCloudAmount): string {
  const wei = BigInt(amount.wei);
  const unit = 10n ** BigInt(amount.decimals);
  const hundredths = (wei * 100n) / unit;
  if (wei > 0n && hundredths === 0n) return `less than 0.01 ${amount.symbol}`;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, "0");
  return `${groupThousands(whole.toString())}.${fraction} ${amount.symbol}`;
}

/** Integer micro-USD -> `$12.34` (rounded down), or `null` when there is no estimate. */
export function formatUsdEstimate(usdMicro: string | null): string | null {
  if (usdMicro === null) return null;
  const micro = BigInt(usdMicro);
  const cents = micro / 10_000n;
  if (micro > 0n && cents === 0n) return "less than $0.01";
  const dollars = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `$${groupThousands(dollars.toString())}.${fraction}`;
}

/** How old the rate behind the USD estimate is, in words, or `null` when there is no rate. */
export function formatRateAge(rate: VexCloudRate): string | null {
  if (!rate.available) return null;
  const seconds = rate.ageSeconds;
  if (seconds < 60) return `rate ${seconds} s old`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `rate ${minutes} min old`;
  const hours = Math.floor(minutes / 60);
  return `rate ${hours} h old`;
}

/** Pico-USD (10^-12 USD) per VEX: one VEX is 10^18 wei, 10^24 wei is 10^6 VEX. */
const WEI_PER_MEGA_VEX = 10n ** 24n;
/** Significant digits the rate line keeps, rounded down. */
const RATE_DIGITS = 4;

/**
 * What one VEX is worth at the backend's rate, for the line under the
 * balances: `$0.0018` (four significant digits, rounded DOWN, so the rate
 * is never stated above the backend's), or `null` without a usable rate.
 * Integer arithmetic only.
 */
export function formatUsdPerVex(rate: VexCloudRate): string | null {
  if (!rate.available) return null;
  const rateX18 = parseRateX18(rate.vexWeiPerMicroUsd);
  if (rateX18 === null) return null;
  // micro-USD for 10^6 VEX is pico-USD for one VEX.
  const pico = weiToMicroUsdFloor(WEI_PER_MEGA_VEX, rateX18);
  if (pico === 0n) return "less than $0.000000000001";
  const digits = pico.toString();
  const kept = digits.length <= RATE_DIGITS ? digits : digits.slice(0, RATE_DIGITS).padEnd(digits.length, "0");
  const padded = kept.padStart(13, "0");
  const whole = padded.slice(0, padded.length - 12).replace(/^0+(?=[0-9])/, "");
  const fraction = padded.slice(padded.length - 12).replace(/0+$/, "");
  return fraction.length === 0 ? `$${groupThousands(whole)}` : `$${groupThousands(whole)}.${fraction}`;
}

/** `1234` -> `1,234`: token counts in notices. */
export function formatTokenCount(count: number): string {
  return groupThousands(Math.trunc(count).toString());
}
