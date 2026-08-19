import { describe, expect, it } from "vitest";

import type { LighterAccountOrder } from "@tools/lighter/types.js";
import {
  lighterDecimalGreaterThanZero,
  stateFromInactiveLighterOrder,
} from "@vex-agent/tools/protocols/lighter/order-evidence.js";

function inactiveOrder(overrides: Partial<LighterAccountOrder> = {}): LighterAccountOrder {
  return {
    order_index: 987,
    client_order_index: 123456,
    order_id: "987",
    client_order_id: "123456",
    market_index: 0,
    owner_account_index: 42,
    initial_base_amount: "1.0",
    remaining_base_amount: "1.0",
    filled_base_amount: "0",
    price: "2000.00",
    status: "canceled",
    ...overrides,
  };
}

describe("Lighter inactive order evidence", () => {
  it.each(["canceled", "canceled-expired", "expired"])(
    "classifies %s with a positive fill as partially filled",
    (status) => {
      expect(stateFromInactiveLighterOrder(inactiveOrder({
        status,
        filled_base_amount: "0.25",
        remaining_base_amount: "0.75",
      }))).toBe("partially_filled");
    },
  );

  it("keeps zero-fill cancellation and full-fill outcomes distinct", () => {
    expect(stateFromInactiveLighterOrder(inactiveOrder())).toBe("canceled");
    expect(stateFromInactiveLighterOrder(inactiveOrder({
      status: "filled",
      filled_base_amount: "1.0",
      remaining_base_amount: "0",
    }))).toBe("filled");
  });

  it("recognizes exact positive decimal evidence without floating-point conversion", () => {
    expect(lighterDecimalGreaterThanZero("0.00000000000000000000000000000000000001")).toBe(true);
    expect(lighterDecimalGreaterThanZero("0.00000000000000000000000000000000000000")).toBe(false);
    expect(lighterDecimalGreaterThanZero("1e-8")).toBe(false);
  });
});
