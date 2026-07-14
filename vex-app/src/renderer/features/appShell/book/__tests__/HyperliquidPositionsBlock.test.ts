import { describe, expect, it } from "vitest";

import { deriveHyperliquidCoverage } from "../HyperliquidPositionsBlock.js";
import type { HyperliquidPositionDto } from "@shared/schemas/hyperliquid.js";

const NOW = Date.parse("2026-07-11T12:03:00.000Z");

function position(protectionState: HyperliquidPositionDto["protectionState"], confirmedAt = "2026-07-11T12:00:30.000Z"): HyperliquidPositionDto {
  return {
    coin: "BTC",
    side: "long",
    size: "0.01",
    entryPx: "100000",
    markPx: "100100",
    leverage: "3",
    marginMode: "isolated",
    liquidationPx: "75000",
    unrealizedPnl: "1",
    fundingAccrued: "0",
    slPrice: "98000",
    tpPrice: null,
    protectionState,
    confirmedAt,
    updatedAt: confirmedAt,
  };
}

describe("deriveHyperliquidCoverage", () => {
  it("renders reconciler-confirmed protection states truthfully", () => {
    expect(deriveHyperliquidCoverage(position("PROTECTED"), NOW)).toBe("protected");
    expect(deriveHyperliquidCoverage(position("CONSOLIDATING"), NOW)).toBe("consolidating");
    expect(deriveHyperliquidCoverage(position("UNPROTECTED"), NOW)).toBe("UNPROTECTED");
    expect(deriveHyperliquidCoverage(position("unprotected_by_user_choice"), NOW)).toBe("UNPROTECTED");
  });

  it("marks a confirmation older than roughly three minutes as stale", () => {
    expect(deriveHyperliquidCoverage(position("PROTECTED", "2026-07-11T11:59:59.000Z"), NOW)).toBe("stale");
  });
});
