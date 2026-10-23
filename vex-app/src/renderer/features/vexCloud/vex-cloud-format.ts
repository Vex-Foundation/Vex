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
import {
  parseRateX18,
  usdEstimateParts,
  VEX_DECIMALS,
  VEX_SYMBOL,
  weiToMicroUsdFloor,
  type UsdEstimateParts,
} from "@shared/vex-cloud-money.js";

/** The words a missing figure reads as (ELEMENTS law 7). */
export const NOT_AVAILABLE = "Not available";

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * THE display form of a VEX amount everywhere the Inference UI states one:
 * `1234567891234567891234` wei -> `1,234.56 VEX` (two decimals, rounded
 * down, so the screen never shows more than there is). A positive amount
 * under 0.01 reads `less than 0.01 VEX`, never `0.00`. Inputs and approval
 * cards show the exact amount instead (`formatVexExact`): there the user
 * consents to every digit.
 */
export function formatVexWei(wei: string | bigint): string {
  const raw = typeof wei === "bigint" ? wei : BigInt(wei);
  const hundredths = (raw * 100n) / 10n ** BigInt(VEX_DECIMALS);
  if (raw > 0n && hundredths === 0n) return `less than 0.01 ${VEX_SYMBOL}`;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, "0");
  return `${groupThousands(whole.toString())}.${fraction} ${VEX_SYMBOL}`;
}

/** A backend balance in its display form (the schema pins 18 decimals and VEX). */
export function formatVexAmount(amount: VexCloudAmount): string {
  return formatVexWei(amount.wei);
}

/**
 * The backend's micro-USD estimate as its words and figure (`about $12.34`,
 * `less than $0.01`, `$0.00`), or `null` when there is no estimate.
 */
export function usdEstimateOf(usdMicro: string | null): UsdEstimateParts | null {
  return usdMicro === null ? null : usdEstimateParts(BigInt(usdMicro));
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
