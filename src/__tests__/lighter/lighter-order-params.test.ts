import { describe, expect, it } from "vitest";

import { readLighterOrderPreviewParams } from "@vex-agent/tools/protocols/lighter/params.js";

const NOW = 1_786_233_600_000;

function read(overrides: Record<string, unknown> = {}) {
  return readLighterOrderPreviewParams({
    accountIndex: 42,
    marketId: 0,
    marketType: "perp",
    side: "sell",
    baseAmountIn: "1",
    price: "2900",
    orderExpiryOffsetMinutes: 30,
    ...overrides,
  }, NOW);
}

describe("Lighter order preview params", () => {
  it("preserves the existing default market IOC selection", () => {
    expect(read()).toMatchObject({
      ok: true,
      value: {
        orderType: "market",
        timeInForce: "immediate-or-cancel",
      },
    });
  });

  it.each([
    ["immediate-or-cancel"],
    ["good-till-time"],
    ["post-only"],
  ] as const)("keeps an explicitly selected plain-limit %s tuple", (timeInForce) => {
    expect(read({ orderType: "limit", timeInForce })).toMatchObject({
      ok: true,
      value: { orderType: "limit", timeInForce },
    });
  });

  it("defaults an ordinary limit to keep-open behavior", () => {
    expect(read({ orderType: "limit" })).toMatchObject({
      ok: true,
      value: {
        orderType: "limit",
        timeInForce: "good-till-time",
      },
    });
  });

  it.each([
    ["stop-loss-limit", "3000"],
    ["take-profit-limit", "3100"],
  ] as const)("still requires an exact time-in-force for %s", (orderType, triggerPrice) => {
    expect(read({ orderType, triggerPrice, reduceOnly: true })).toEqual({
      ok: false,
      reason: `${orderType} requires an explicit timeInForce selection.`,
    });
  });

  it.each([
    ["stop-loss-limit", "immediate-or-cancel", "2800"],
    ["stop-loss-limit", "good-till-time", "2800"],
    ["stop-loss-limit", "post-only", "2800"],
    ["take-profit-limit", "immediate-or-cancel", "3100"],
    ["take-profit-limit", "good-till-time", "3100"],
    ["take-profit-limit", "post-only", "3100"],
  ] as const)("accepts explicit %s with %s params", (orderType, timeInForce, triggerPrice) => {
    expect(read({
      orderType,
      timeInForce,
      triggerPrice,
      reduceOnly: true,
    })).toMatchObject({
      ok: true,
      value: {
        orderType,
        timeInForce,
        triggerPrice,
        reduceOnly: true,
      },
    });
  });

  it.each([
    ["stop-loss", "2800"],
    ["take-profit", "3100"],
  ] as const)(
    "keeps legacy %s market-trigger orders backward-compatible when timeInForce is omitted",
    (orderType, triggerPrice) => {
      expect(read({
        orderType,
        triggerPrice,
        reduceOnly: true,
      })).toMatchObject({
        ok: true,
        value: { orderType, timeInForce: "immediate-or-cancel" },
      });
    },
  );
});
