/**
 * The funding page's presentation decisions, pure: what a typed amount is
 * worth, why the primary key is disabled, and which fill and word each
 * status reads as. The arithmetic itself is `@shared/vex-cloud-money.js`,
 * the same functions main decides with, so the screen and the gate cannot
 * round apart. Main re-checks everything here; this only explains it first.
 */

import type { VexCloudAccount, VexCloudRate } from "@shared/schemas/vex-cloud.js";
import type {
  VexCloudDepositItem,
  VexCloudSubmitDepositResult,
  VexCloudWithdrawalStatus,
} from "@shared/schemas/vex-cloud-funding.js";
import { withdrawalWord, type VexCloudWithdrawalWord } from "@shared/schemas/vex-cloud-funding.js";
import {
  formatMicroUsd,
  formatMicroUsdEstimate,
  formatVexExact,
  microUsdToWeiCeil,
  parseRateX18,
  parseVexAmountText,
  weiToMicroUsdFloor,
} from "@shared/vex-cloud-money.js";
import type { SwatchState } from "../../../components/ui/swatch.js";

export const NOT_AVAILABLE = "Not available";

export function rateOf(rate: VexCloudRate): bigint | null {
  return rate.available ? parseRateX18(rate.vexWeiPerMicroUsd) : null;
}

export interface AmountReading {
  /** The parsed amount, or `null` while the text is not a usable amount. */
  readonly wei: bigint | null;
  /** "about $12.34" or "less than $0.01", or `null` without an amount or a rate. */
  readonly usdLine: string | null;
  /** Why the amount cannot be submitted yet, in words; `null` when it can. */
  readonly problem: string | null;
}

/**
 * Read a typed amount against the backend's minimum and the most it may be.
 * `max` is what the source holds (a wallet's VEX, the withdrawable balance)
 * or `null` when that is unknown, in which case main's own read decides.
 */
export function readAmount(args: {
  readonly text: string;
  readonly rateX18: bigint | null;
  readonly minimumMicroUsd: bigint;
  readonly max: bigint | null;
  readonly maxLabel: string;
}): AmountReading {
  const parsed = parseVexAmountText(args.text);
  if (!parsed.ok) {
    const problem =
      parsed.reason === "empty"
        ? "Enter an amount."
        : parsed.reason === "zero"
          ? "Enter an amount above zero."
          : parsed.reason === "too_precise"
            ? "At most 18 digits after the point."
            : "Use digits and one point, for example 125.5.";
    return { wei: null, usdLine: null, problem };
  }
  const usdLine = args.rateX18 === null ? null : formatMicroUsdEstimate(weiToMicroUsdFloor(parsed.wei, args.rateX18));
  if (args.rateX18 === null) {
    return { wei: parsed.wei, usdLine, problem: "The VEX price is not available right now, so the minimum cannot be checked." };
  }
  const minimumWei = microUsdToWeiCeil(args.minimumMicroUsd, args.rateX18);
  if (parsed.wei < minimumWei) {
    return {
      wei: parsed.wei,
      usdLine,
      problem: `The minimum is ${formatMicroUsd(args.minimumMicroUsd)}, about ${formatVexExact(minimumWei)} VEX.`,
    };
  }
  if (args.max !== null && parsed.wei > args.max) {
    return { wei: parsed.wei, usdLine, problem: `That is more than ${args.maxLabel} (${formatVexExact(args.max)} VEX).` };
  }
  return { wei: parsed.wei, usdLine, problem: null };
}

/** D15 in plain words, from the backend's own cap. */
export function spendableNowCopy(provisionalCapMicroUsd: string): string {
  return `Spendable now up to ${formatMicroUsd(BigInt(provisionalCapMicroUsd))}; the rest after about 16 minutes.`;
}

/** `0x1234…abcd` for a row; the full address is shown wherever the user consents. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** `19:47:05 UTC` for an expiry; the full ISO time sits under All signed fields. */
export function utcClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return NOT_AVAILABLE;
  return `${date.toISOString().slice(11, 19)} UTC`;
}

export interface StatusLook {
  readonly fill: SwatchState;
  readonly word: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * A release time on this computer's clock: "21:30" when it falls today,
 * else "Oct 22, 21:30". `null` for an unparseable value, never "Invalid Date".
 */
export function localClock(iso: string, nowMs: number): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const now = new Date(nowMs);
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay ? clock : `${MONTHS[at.getMonth()] ?? ""} ${at.getDate()}, ${clock}`;
}

/** "Cooling, releases at 21:30" for a cooling withdrawal; else its plain word. */
export function withdrawalWordText(
  withdrawal: { readonly status: VexCloudWithdrawalStatus; readonly releaseAt: string | null },
  nowMs: number,
): string {
  const word = withdrawalWord(withdrawal, nowMs);
  if (word !== "Cooling" || withdrawal.releaseAt === null) return word;
  const at = localClock(withdrawal.releaseAt, nowMs);
  return at === null ? "Cooling" : `Cooling, releases at ${at}`;
}

export function withdrawalLook(
  withdrawal: { readonly status: VexCloudWithdrawalStatus; readonly releaseAt: string | null },
  nowMs: number,
): StatusLook & { readonly word: VexCloudWithdrawalWord } {
  const word = withdrawalWord(withdrawal, nowMs);
  switch (word) {
    case "Cooling":
      // A wait the user can still end: the dotted outline of Paused.
      return { fill: "sleeping", word };
    case "Cancelled":
      return { fill: "idle", word };
    case "Pending":
      return { fill: "ongoing", word };
    case "Confirming":
      return { fill: "draft", word };
    case "Completed":
      return { fill: "done", word };
    case "Returned":
      return { fill: "idle", word };
  }
}

export function depositItemLook(status: VexCloudDepositItem["status"]): StatusLook {
  switch (status) {
    case "pending":
      return { fill: "ongoing", word: "Seen, not yet credited" };
    case "provisional":
      // `spendable_now_wei` is the provisional grant (D15 cap) until finality.
      return { fill: "draft", word: "Partly spendable, finalizing" };
    case "credited":
      return { fill: "done", word: "Credited" };
    case "reverted":
      return { fill: "error", word: "Reverted" };
  }
}

export function depositResultLook(status: VexCloudSubmitDepositResult["status"]): StatusLook {
  switch (status) {
    case "confirmed":
      return { fill: "done", word: "Sent" };
    case "pending":
      return { fill: "ongoing", word: "Sent, awaiting confirmation" };
    case "reverted":
      return { fill: "error", word: "Failed on chain" };
  }
}

/** The withdraw destinations: linked to the account AND in this app. */
export function eligibleDestinations(account: VexCloudAccount, localWallets: readonly string[]): readonly string[] {
  const local = new Set(localWallets.map((address) => address.toLowerCase()));
  return account.wallets.map((wallet) => wallet.address).filter((address) => local.has(address.toLowerCase()));
}

export function activityKindWord(kind: "deposit" | "withdrawal" | "cashback_claim" | "admin_credit"): string {
  switch (kind) {
    case "deposit":
      return "Deposit";
    case "withdrawal":
      return "Withdrawal";
    case "cashback_claim":
      return "Cashback claim";
    case "admin_credit":
      return "Credit from Vex";
  }
}

/**
 * Usage rows whose cost is an ESTIMATE, not the upstream's `usage.cost`
 * (plan 4.2): a stopped or dropped stream, or a refusal charged its input
 * floor. Their cost reads "(estimated)".
 */
export function isEstimatedUsage(status: string): boolean {
  return status === "settled_estimated" || status === "settled_input_floor";
}

/** A backend status token in words: `included_success` -> `Included success`. Never dropped. */
export function tokenWords(token: string): string {
  const spaced = token.replace(/_/g, " ");
  return spaced.length === 0 ? NOT_AVAILABLE : `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}
