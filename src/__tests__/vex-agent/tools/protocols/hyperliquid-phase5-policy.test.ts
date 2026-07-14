import { describe, expect, it } from "vitest";

import { validateCollateralSensitiveAction } from "../../../../vex-agent/tools/protocols/hyperliquid/protection-gate.js";

describe("Hyperliquid Phase 5 collateral invariant", () => {
  const protectedSnapshot = {
    coin: "BTC",
    state: "PROTECTED" as const,
    positionSize: "1",
    entryPx: "100",
    liquidationPx: "50",
    fullPositionStops: [],
    fixedSizeStops: [],
  };

  it("rejects outbound collateral when a perp lacks full protection", () => {
    expect(validateCollateralSensitiveAction([{ ...protectedSnapshot, state: "UNPROTECTED" }], "100", "10", 2)).toMatch(/stop-loss coverage/i);
  });

  it("rejects outbound collateral below post-action maintenance headroom", () => {
    expect(validateCollateralSensitiveAction([protectedSnapshot], "19.99", "10", 2)).toMatch(/headroom/i);
  });

  it("allows a collateral action only with protection and sufficient headroom", () => {
    expect(validateCollateralSensitiveAction([protectedSnapshot], "20", "10", 2)).toBeNull();
  });
});
