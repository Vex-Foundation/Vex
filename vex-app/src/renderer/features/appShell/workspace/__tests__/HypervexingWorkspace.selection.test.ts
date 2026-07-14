// This test covers the pure selection rule; mock the visual room so importing
// the workspace does not initialise its chart/motion dependencies.
import { describe, expect, it, vi } from "vitest";

vi.mock("motion/react", () => ({ motion: { div: "div" }, useReducedMotion: () => true }));
vi.mock("../../../../lib/api/hyperliquid.js", () => ({ useHyperliquidPositions: () => ({ data: undefined }) }));
vi.mock("../../../../stores/uiStore.js", () => ({ useUiStore: () => null }));
vi.mock("../HvZone.js", () => ({ HvZone: () => null }));
vi.mock("../HypervexingBookPane.js", () => ({ HypervexingBookPane: () => null }));
vi.mock("../HypervexingChartPane.js", () => ({ HypervexingChartPane: () => null }));
vi.mock("../HypervexingCopilotDock.js", () => ({ HypervexingCopilotDock: () => null }));
vi.mock("../HypervexingLeftColumn.js", () => ({ HypervexingLeftColumn: () => null }));
vi.mock("../HypervexingTabs.js", () => ({ HypervexingTabs: () => null }));
vi.mock("../HypervexingTopBar.js", () => ({ HypervexingTopBar: () => null }));

const { nextPositionAutoFollow } = await import("../HypervexingWorkspace.js");

describe("HypervexingWorkspace chart selection", () => {
  it("uses initial positions only as the fallback and never treats hydration as a new position", () => {
    const next = nextPositionAutoFollow(null, ["BTC", "CASHCAT"], false);
    expect(next.follow).toBeUndefined();
    expect([...next.known]).toEqual(["BTC", "CASHCAT"]);
  });

  it("follows a newly opened position before a manual pick, but never after one", () => {
    const baseline = nextPositionAutoFollow(null, ["BTC"], false);
    const auto = nextPositionAutoFollow(baseline.known, ["BTC", "CASHCAT"], false);
    const manual = nextPositionAutoFollow(baseline.known, ["BTC", "CASHCAT"], true);
    expect(auto.follow).toBe("CASHCAT");
    expect(manual.follow).toBeUndefined();
  });
});
