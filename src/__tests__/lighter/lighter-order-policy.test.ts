import { describe, expect, it } from "vitest";

import {
  assertLighterPhaseOneOrderPolicy,
  lighterPhaseOneOrderPolicyFailure,
} from "@tools/lighter/order-policy.js";

describe("Lighter create-order policy", () => {
  it.each([
    ["limit", "immediate-or-cancel"],
    ["limit", "good-till-time"],
    ["limit", "post-only"],
    ["market", "immediate-or-cancel"],
    ["stop-loss", "immediate-or-cancel"],
    ["stop-loss-limit", "immediate-or-cancel"],
    ["stop-loss-limit", "good-till-time"],
    ["stop-loss-limit", "post-only"],
    ["take-profit", "immediate-or-cancel"],
    ["take-profit-limit", "immediate-or-cancel"],
    ["take-profit-limit", "good-till-time"],
    ["take-profit-limit", "post-only"],
  ] as const)("permits %s with %s", (orderType, timeInForce) => {
    expect(lighterPhaseOneOrderPolicyFailure(orderType, timeInForce)).toBeNull();
    expect(() => assertLighterPhaseOneOrderPolicy(orderType, timeInForce)).not.toThrow();
  });

  it.each([
    ["market", "good-till-time"],
    ["market", "post-only"],
    ["stop-loss", "good-till-time"],
    ["stop-loss", "post-only"],
    ["take-profit", "good-till-time"],
    ["take-profit", "post-only"],
  ] as const)("refuses %s with %s", (orderType, timeInForce) => {
    expect(lighterPhaseOneOrderPolicyFailure(orderType, timeInForce)).toContain(
      "Unsupported Lighter order type and time-in-force combination",
    );
    expect(() => assertLighterPhaseOneOrderPolicy(orderType, timeInForce)).toThrow(
      "No order was signed or submitted",
    );
  });
});
