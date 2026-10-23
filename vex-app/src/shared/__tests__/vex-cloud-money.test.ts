/**
 * Vex Cloud money arithmetic: the one owner main decides with and the
 * renderer displays with. Integer only; the estimate rounds down, the
 * minimum rounds up; the typed amount never passes through a float; the
 * withdrawal words cover all twelve backend states and the cooling period.
 */

import { describe, expect, it } from "vitest";
import {
  VEX_CLOUD_WITHDRAWAL_STATUSES,
  withdrawalStatusWord,
  withdrawalWord,
  isWithdrawalCooling,
  isFinalWithdrawalWord,
} from "../schemas/vex-cloud-funding.js";
import {
  formatMicroUsd,
  formatMicroUsdEstimate,
  formatUnitsExact,
  formatVexExact,
  microUsdToWeiCeil,
  parseRateX18,
  parseVexAmountText,
  usdEstimateParts,
  weiToMicroUsdFloor,
} from "../vex-cloud-money.js";

const E18 = 10n ** 18n;

describe("parseVexAmountText", () => {
  it.each([
    ["125", 125n * E18],
    ["0.5", E18 / 2n],
    ["12.", 12n * E18],
    [".25", E18 / 4n],
    [" 6000 ", 6_000n * E18],
    ["0.000000000000000001", 1n],
    ["123456789012.123456789012345678", 123_456_789_012n * E18 + 123_456_789_012_345_678n],
  ])("%s -> exact wei", (text, wei) => {
    expect(parseVexAmountText(text)).toEqual({ ok: true, wei });
  });

  it.each([
    ["", "empty"],
    ["  ", "empty"],
    ["0", "zero"],
    ["0.000", "zero"],
    ["1,000", "format"],
    ["1e3", "format"],
    ["-5", "format"],
    [".", "format"],
    ["1.2.3", "format"],
    ["1234567890123", "format"],
    ["1.0000000000000000001", "too_precise"],
  ])("%j is refused as %s", (text, reason) => {
    expect(parseVexAmountText(text)).toEqual({ ok: false, reason });
  });
});

describe("formatting", () => {
  it("shows every digit that will be signed", () => {
    expect(formatVexExact(6_000n * E18 + 1n)).toBe("6,000.000000000000000001");
    expect(formatVexExact(1_500_000n * E18)).toBe("1,500,000");
    expect(formatUnitsExact(7_200_000_000_000n, 18)).toBe("0.0000072");
  });

  it("rounds USD down and says less than a cent", () => {
    expect(formatMicroUsd(6_000_999n)).toBe("$6.00");
    expect(formatMicroUsd(1n)).toBe("less than $0.01");
    expect(formatMicroUsd(0n)).toBe("$0.00");
  });

  it.each([
    [0n, "$0.00"],
    [1n, "less than $0.01"],
    [9_999n, "less than $0.01"],
    [10_000n, "about $0.01"],
    [370_000n, "about $0.37"],
    [6_000_999n, "about $6.00"],
  ])("words a USD estimate of %s micro-USD as %s, never \"about less than\"", (micro, expected) => {
    expect(formatMicroUsdEstimate(micro)).toBe(expected);
    const parts = usdEstimateParts(micro);
    expect(parts.qualifier === null ? parts.figure : `${parts.qualifier} ${parts.figure}`).toBe(expected);
  });

  it("refuses a negative estimate rather than wording it", () => {
    expect(() => usdEstimateParts(-1n)).toThrow(RangeError);
  });
});

describe("the rate", () => {
  it("reads the backend's decimal exactly", () => {
    expect(parseRateX18("1000000000000000")).toBe(10n ** 33n);
    expect(parseRateX18("1.5")).toBe(15n * 10n ** 17n);
    expect(parseRateX18("0")).toBeNull();
    expect(parseRateX18("1.0000000000000000001")).toBeNull();
    expect(parseRateX18("-1")).toBeNull();
  });

  it("estimates down and the minimum up, so a passing amount passes the backend too", () => {
    const rate = parseRateX18("3.333333333333333333");
    if (rate === null) throw new Error("rate");
    const minimum = microUsdToWeiCeil(5_000_000n, rate);
    expect(weiToMicroUsdFloor(minimum, rate)).toBeGreaterThanOrEqual(5_000_000n);
    expect(weiToMicroUsdFloor(minimum - 1n, rate)).toBeLessThan(5_000_000n);
  });
});

describe("withdrawal words", () => {
  it("maps every backend state to its word without the clock (plan 15.2, plus Cancelled)", () => {
    expect(Object.fromEntries(VEX_CLOUD_WITHDRAWAL_STATUSES.map((s) => [s, withdrawalStatusWord(s)]))).toEqual({
      requested: "Pending",
      debited: "Pending",
      signed: "Pending",
      broadcast: "Pending",
      unknown: "Pending",
      included_success: "Confirming",
      included_reverted: "Confirming",
      completed: "Completed",
      refunded: "Returned",
      failed: "Returned",
      dropped: "Returned",
      cancelled: "Cancelled",
    });
  });

  it("a debited withdrawal reads Cooling only while its release time is ahead", () => {
    const now = Date.parse("2026-10-21T12:00:00.000Z");
    const ahead = { status: "debited" as const, releaseAt: "2026-10-22T00:00:00.000Z" };
    expect(withdrawalWord(ahead, now)).toBe("Cooling");
    expect(isWithdrawalCooling(ahead, now)).toBe(true);
    expect(withdrawalWord({ ...ahead, releaseAt: "2026-10-21T11:59:59.000Z" }, now)).toBe("Pending");
    expect(withdrawalWord({ ...ahead, releaseAt: null }, now)).toBe("Pending");
    // Only `debited` cools: a signed withdrawal with a future release time is being sent.
    expect(withdrawalWord({ status: "signed", releaseAt: ahead.releaseAt }, now)).toBe("Pending");
    expect(isFinalWithdrawalWord("Cancelled")).toBe(true);
    expect(isFinalWithdrawalWord("Cooling")).toBe(false);
  });
});
