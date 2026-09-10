import { expect, it } from "vitest";
import { agentScanTokenLegSchema } from "@shared/schemas/agent-scan-feed.js";
import { legAmountText } from "../agent-scan/agent-scan-display.js";
import { quantityText } from "../token-history/token-history-display.js";

it("shows the complete lower bound without rounding it upward in either history view", () => {
  const value = "1.999999999999999999";
  const leg = agentScanTokenLegSchema.parse({ address: null, symbol: "ETH", displaySymbol: "ETH", decimals: 18,
    amountHuman: null, amountRaw: null, executedAmountHuman: value, executedAmountRaw: "1999999999999999999",
    displayAmount: value, amountBasis: "lower_bound", usdEst: null });
  expect(legAmountText(leg)).toBe(`at least ${value}`);
  expect(quantityText({ value, unitProvenance: "human", basis: "lower_bound" })).toBe(`at least ${value}`);
});
