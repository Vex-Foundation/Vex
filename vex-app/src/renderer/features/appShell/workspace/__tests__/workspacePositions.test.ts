/**
 * Display-only derivations over the positions DTO (top-bar uPnL, watchlist).
 * These never feed signing — they format numbers for the chrome — but a wrong
 * sum or a coerced non-finite cell would mislead the user, so they are pinned.
 */

import { describe, expect, it } from "vitest";
import type { HyperliquidPositionDto } from "@shared/schemas/hyperliquid.js";
import {
  directionToneClass,
  findPositionByCoin,
  formatSignedUsd,
  sumUnrealizedPnl,
} from "../workspacePositions.js";

function position(
  coin: string,
  unrealizedPnl: string,
): HyperliquidPositionDto {
  return {
    coin,
    side: "long",
    size: "1",
    entryPx: "100",
    markPx: "101",
    leverage: "3",
    marginMode: "cross",
    liquidationPx: "50",
    unrealizedPnl,
    fundingAccrued: "0",
    slPrice: null,
    tpPrice: null,
    protectionState: "UNPROTECTED",
    confirmedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("sumUnrealizedPnl", () => {
  it("sums signed decimal strings", () => {
    expect(sumUnrealizedPnl([position("A", "12.5"), position("B", "-4.25")])).toBe(
      8.25,
    );
  });

  it("skips non-finite cells instead of coercing them to 0 into the total", () => {
    // A malformed cell must not silently read as a real 0 in the user's total.
    expect(sumUnrealizedPnl([position("A", "10"), position("B", "not-a-number")])).toBe(
      10,
    );
  });

  it("is 0 for an empty book", () => {
    expect(sumUnrealizedPnl([])).toBe(0);
  });
});

describe("formatSignedUsd", () => {
  it("signs positive, negative, and zero", () => {
    expect(formatSignedUsd(1234.5)).toBe("+1,234.50");
    expect(formatSignedUsd(-8.25)).toBe("-8.25");
    expect(formatSignedUsd(0)).toBe("0.00");
  });
});

describe("directionToneClass", () => {
  it("is long-green for >= 0 and short-rose for < 0", () => {
    expect(directionToneClass(5)).toContain("--vex-long");
    expect(directionToneClass(0)).toContain("--vex-long");
    expect(directionToneClass(-1)).toContain("--vex-short");
  });
});

describe("findPositionByCoin", () => {
  const book = [position("BTC", "1"), position("ETH", "2")];
  it("returns the matching market or null", () => {
    expect(findPositionByCoin(book, "ETH")?.coin).toBe("ETH");
    expect(findPositionByCoin(book, "SOL")).toBeNull();
    expect(findPositionByCoin(book, null)).toBeNull();
  });
});
