/**
 * BOARD FORMATTING - the decimal string must survive the formatter.
 *
 * The property under test is that magnitude and precision are derived from
 * the DIGITS, never from a float: a memecoin price and a multi-billion
 * liquidity figure both have to come out right, and both are values that
 * `Number()` would degrade or overflow before the formatter ever ran.
 */

import { describe, expect, it } from "vitest";
import {
  BOARD_EMPTY,
  boardTrend,
  formatBoardAge,
  formatBoardCount,
  formatBoardPercent,
  formatBoardPriceUsd,
  formatBoardUsdCompact,
  isBoardMarketDataStale,
  parseDecimalString,
} from "../boardFormat.js";

describe("parseDecimalString", () => {
  it.each([
    ["1", { negative: false, int: "1", frac: "" }],
    ["0.5", { negative: false, int: "", frac: "5" }],
    ["-2.25", { negative: true, int: "2", frac: "25" }],
    ["007.10", { negative: false, int: "7", frac: "10" }],
    ["0", { negative: false, int: "", frac: "" }],
  ])("splits %j", (input, expected) => {
    expect(parseDecimalString(input)).toStrictEqual(expected);
  });

  it.each(["", "abc", "1e5", "0x1", "1.2.3", "Infinity", "1,000"])(
    "refuses %j rather than guessing",
    (input) => {
      expect(parseDecimalString(input)).toBeNull();
    },
  );
});

describe("formatBoardPriceUsd", () => {
  it.each([
    ["1234.5678", "$1234.56"],
    ["1", "$1.00"],
    ["0.5", "$0.5000"],
    ["0.01234", "$0.0123"],
    // 12 leading zeros + 4 significant digits = 16 fractional digits.
    ["0.00000000000012345678", "$0.0000000000001234"],
    ["0", "$0.00"],
    ["-0.5", "-$0.5000"],
  ])("formats %j as %j", (input, expected) => {
    expect(formatBoardPriceUsd(input)).toBe(expected);
  });

  it("keeps a 1e-13 price legible instead of collapsing it to $0.00", () => {
    expect(formatBoardPriceUsd("0.0000000000001")).not.toBe("$0.00");
  });

  it("truncates toward zero so a shown figure is never larger than the real one", () => {
    // 0.99999 would ROUND to $1.0000; truncation keeps it honestly below.
    expect(formatBoardPriceUsd("0.99999")).toBe("$0.9999");
  });

  it("renders a null price as the dash, never a zero", () => {
    expect(formatBoardPriceUsd(null)).toBe(BOARD_EMPTY);
  });

  it("renders an unparseable price as the dash", () => {
    expect(formatBoardPriceUsd("about a dollar")).toBe(BOARD_EMPTY);
  });
});

describe("formatBoardUsdCompact", () => {
  it.each([
    ["75189.01", "$75.1K"],
    ["1400000", "$1.4M"],
    ["2300000000", "$2.3B"],
    ["999", "$999.00"],
    ["0.5", "$0.50"],
  ])("formats %j as %j", (input, expected) => {
    expect(formatBoardUsdCompact(input)).toBe(expected);
  });

  it("stays exact on a value far past Number.MAX_SAFE_INTEGER", () => {
    // 20 integer digits. `Number()` would have lost the low-order digits
    // before any formatting ran; counting characters does not.
    expect(formatBoardUsdCompact("98765432109876543210")).toBe(
      "$98765432109.8B",
    );
  });

  it("renders a null figure as the dash", () => {
    expect(formatBoardUsdCompact(null)).toBe(BOARD_EMPTY);
  });
});

describe("formatBoardPercent", () => {
  it.each([
    ["113", "+113.00%"],
    ["-1.73", "-1.73%"],
    ["0", "0.00%"],
    ["0.00", "0.00%"],
    ["-0.5", "-0.50%"],
  ])("formats %j as %j", (input, expected) => {
    expect(formatBoardPercent(input)).toBe(expected);
  });

  it("keeps the sign of a tiny negative move that rounds to zero", () => {
    // A comparison against a parsed float would render this as `+0.00%`.
    expect(formatBoardPercent("-0.00004")).toBe("-0.00%");
  });

  it("renders null and an unparseable value as the dash", () => {
    expect(formatBoardPercent(null)).toBe(BOARD_EMPTY);
    expect(formatBoardPercent("NaN")).toBe(BOARD_EMPTY);
  });
});

describe("boardTrend", () => {
  it.each([
    ["5", "up"],
    ["-5", "down"],
    ["0", "flat"],
    ["0.000", "flat"],
    ["-0.00001", "down"],
    [null, "flat"],
    ["nonsense", "flat"],
  ])("classifies %j as %j", (input, expected) => {
    expect(boardTrend(input)).toBe(expected);
  });
});

describe("formatBoardCount", () => {
  it.each([
    [354, "354"],
    [1235, "1.2K"],
    [3_400_000, "3.4M"],
  ])("formats %j as %j", (input, expected) => {
    expect(formatBoardCount(input)).toBe(expected);
  });

  it("renders null as the dash", () => {
    expect(formatBoardCount(null)).toBe(BOARD_EMPTY);
  });
});

describe("formatBoardAge", () => {
  it.each([
    [259_200, "3d"],
    [25_200, "7h"],
    [720, "12m"],
    [30, "new"],
  ])("formats %j seconds as %j", (input, expected) => {
    expect(formatBoardAge(input)).toBe(expected);
  });

  it("renders null and a negative age as the dash", () => {
    expect(formatBoardAge(null)).toBe(BOARD_EMPTY);
    expect(formatBoardAge(-1)).toBe(BOARD_EMPTY);
  });
});

describe("isBoardMarketDataStale", () => {
  const fetchedAt = 1_783_172_700_000;
  const window = 60_000;

  it("is fresh inside the window", () => {
    expect(isBoardMarketDataStale(fetchedAt, window, fetchedAt + 59_999)).toBe(
      false,
    );
  });

  it("is stale exactly at the boundary", () => {
    expect(isBoardMarketDataStale(fetchedAt, window, fetchedAt + window)).toBe(
      true,
    );
  });

  it("is stale for a board read back from the transcript hours later", () => {
    expect(
      isBoardMarketDataStale(fetchedAt, window, fetchedAt + 4 * 3_600_000),
    ).toBe(true);
  });
});
