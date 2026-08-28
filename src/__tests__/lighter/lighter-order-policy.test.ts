import { describe, expect, it } from "vitest";

import {
  assertLighterPhaseOneOrderPolicy,
  lighterPhaseOneOrderPolicyFailure,
} from "@tools/lighter/order-policy.js";

describe("Lighter Phase 1 order policy", () => {
  it("permits IOC market and protective orders", () => {
    expect(lighterPhaseOneOrderPolicyFailure("market", "immediate-or-cancel")).toBeNull();
    expect(lighterPhaseOneOrderPolicyFailure("stop-loss", "immediate-or-cancel")).toBeNull();
    expect(lighterPhaseOneOrderPolicyFailure("take-profit", "immediate-or-cancel")).toBeNull();
    expect(() => assertLighterPhaseOneOrderPolicy("market", "immediate-or-cancel")).not.toThrow();
  });

  it.each([
    ["limit", "good-till-time"],
    ["limit", "post-only"],
    ["limit", "immediate-or-cancel"],
    ["market", "good-till-time"],
    ["market", "post-only"],
  ] as const)("refuses %s with %s", (orderType, timeInForce) => {
    expect(lighterPhaseOneOrderPolicyFailure(orderType, timeInForce)).toContain(
      "Resting limit, good-till-time, and post-only orders remain unavailable",
    );
    expect(() => assertLighterPhaseOneOrderPolicy(orderType, timeInForce)).toThrow(
      "No order was signed or submitted",
    );
  });
});
