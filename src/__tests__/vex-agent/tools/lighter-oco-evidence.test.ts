import { describe, expect, it } from "vitest";

import { buildLighterUnsignedOcoRequest } from "@tools/lighter/oco-order.js";
import type { LighterAccountOrder, LighterTrade } from "@tools/lighter/types.js";
import { classifyOcoEvidence } from "@vex-agent/tools/protocols/lighter/oco-order-execution.js";

const PLAN = {
  matchHash: "a".repeat(64),
  environment: "rhc" as const,
  accountIndex: 42,
  apiKeyIndex: 7,
  marketIndex: 0,
  side: "sell" as const,
  baseAmountInteger: "1000",
  orderExpiryMs: 1_900_000_000_000,
  stopLoss: { matchHash: "b".repeat(64), priceInteger: "285000", triggerPriceInteger: "290000" },
  takeProfit: { matchHash: "c".repeat(64), priceInteger: "325000", triggerPriceInteger: "330000" },
};
const GROUP = buildLighterUnsignedOcoRequest(PLAN);

function order(index: 0 | 1, status = "open"): LighterAccountOrder {
  return {
    order_index: index + 1,
    client_order_index: Number(GROUP.orders[index].clientOrderIndex),
    order_id: String(index + 1),
    client_order_id: GROUP.orders[index].clientOrderIndex,
    market_index: PLAN.marketIndex,
    owner_account_index: PLAN.accountIndex,
    initial_base_amount: PLAN.baseAmountInteger,
    remaining_base_amount: PLAN.baseAmountInteger,
    filled_base_amount: "0",
    filled_quote_amount: "0",
    price: GROUP.orders[index].price,
    status,
  };
}

describe("Lighter native OCO evidence", () => {
  it("requires both exact child orders before reporting active protection", () => {
    const oneChild = classifyOcoEvidence(PLAN, GROUP, [order(0)], [], [], "shared-tx");
    expect(oneChild.state).toBe("sequencer_pending");
    expect(oneChild.evidence.completePairVisible).toBe(false);

    const bothChildren = classifyOcoEvidence(PLAN, GROUP, [order(0), order(1)], [], [], "shared-tx");
    expect(bothChildren.state).toBe("active");
    expect(bothChildren.evidence.completePairVisible).toBe(true);
  });

  it("does not attribute one shared grouped transaction hash to both children", () => {
    const oneTrade = {
      trade_id: 1,
      trade_id_str: "1",
      tx_hash: "shared-tx",
      market_id: PLAN.marketIndex,
      size: "1000",
      price: "285000",
      ask_account_id: PLAN.accountIndex,
      ask_client_id_str: GROUP.orders[0].clientOrderIndex,
      ask_id: 1,
      ask_id_str: "1",
      bid_account_id: 99,
      bid_client_id_str: "999",
      bid_id: 2,
      bid_id_str: "2",
      is_maker_ask: false,
      block_height: 1,
      timestamp: 1,
      transaction_time: 1,
    } satisfies LighterTrade;
    const outcome = classifyOcoEvidence(
      PLAN,
      GROUP,
      [],
      [order(1, "canceled")],
      [oneTrade],
      "shared-tx",
    );
    expect(outcome.state).toBe("resolved");
    expect((outcome.evidence.takeProfit as { state: string }).state).toBe("canceled");
  });
});
