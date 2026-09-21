import { describe, expect, it } from "vitest";
import { activityFollowUpMessage, lighterFillFollowUpMessage } from "../agent-scan/event-follow-up.js";
import { entry, lighterFill } from "./_agent-scan-fixtures.js";

describe("event follow-up handoff", () => {
  it("includes the recorded activity context and approval guard", () => {
    const message = activityFollowUpMessage(entry({ id: "activity-1" }));
    expect(message).toContain("swap (swap)");
    expect(message).toContain("USDC -> WETH");
    expect(message).toContain("Do not place an order without my explicit approval.");
  });

  it("includes the Lighter fill context and approval guard", () => {
    const message = lighterFillFollowUpMessage(lighterFill({ id: "fill-1" }));
    expect(message).toContain("ETH/USDG");
    expect(message).toContain("position effect: open");
    expect(message).toContain("Do not place an order without my explicit approval.");
  });
});
