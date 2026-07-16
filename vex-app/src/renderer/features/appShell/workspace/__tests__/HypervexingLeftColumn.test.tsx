import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../lib/api/chat.js", () => ({
  useSubmitChat: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("../../../../lib/api/usage.js", () => ({
  useSessionUsageTotals: () => ({ data: { ok: true, data: null } }),
}));
vi.mock("../../book/HyperliquidRiskBlock.js", () => ({
  HyperliquidRiskProposalPanel: () => null,
}));
vi.mock("../HypervexingRiskSetup.js", () => ({
  HypervexingRiskSetup: () => null,
}));
vi.mock("../HlLiquidVeil.js", () => ({ HlLiquidVeil: () => null }));

const { HypervexingLeftColumn } = await import(
  "../HypervexingLeftColumn.js"
);

describe("HypervexingLeftColumn earn cards", () => {
  it("keeps the action text inside non-shrinking cards on short rooms", () => {
    render(
      <HypervexingLeftColumn
        account={null}
        upnl={null}
        sessionId="00000000-0000-4000-8000-000000000001"
        selectedCoin="BTC"
      />,
    );

    for (const name of ["Ask Vex about HLP", "Ask Vex about staking"]) {
      const action = screen.getByRole("button", { name });
      expect(action.classList.contains("min-h-6")).toBe(true);
      expect(action.parentElement?.classList.contains("shrink-0")).toBe(true);
    }
  });
});
