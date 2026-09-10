import { describe, expect, it } from "vitest";
import { describeSwapOutputShortfall } from "@tools/evm-chains/swap-output-shortfall.js";

describe("pre-sign output evidence", () => {
  it("states exact observed shortfall in raw units when a simulation returned an amount", () => {
    expect(describeSwapOutputShortfall({ quotedOutputRaw: "1000", approvedMinimumOutputRaw: "900", simulatedOutputRaw: "853" }))
      .toContain("Quoted output 1000, simulated output 853, shortfall 147 raw output-token units");
  });
  it("does not invent a simulated amount from a string-only revert", () => {
    expect(describeSwapOutputShortfall({ quotedOutputRaw: "1000", approvedMinimumOutputRaw: "900" }))
      .toContain("exact simulated output and shortfall are unavailable");
  });
});
