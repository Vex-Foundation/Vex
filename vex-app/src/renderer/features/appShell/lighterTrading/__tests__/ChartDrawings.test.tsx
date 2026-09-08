import { requireValue } from "../../../../../../../src/__tests__/helpers/require-value.js";
import { useLighterAnalysisStore } from "../../../../stores/lighterAnalysisStore.js";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DrawingChartApi, DrawingSeriesApi } from "../chart-analysis-api.js";
import { ChartDrawings } from "../ChartDrawings.js";
const scale = { timeToCoordinate: vi.fn(() => 0), subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn(), coordinateToLogical: (x: number) => x / 10, logicalToCoordinate: (x: number) => x * 10 };
const chart = { timeScale: () => scale, subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(), paneSize: () => ({ width: 500, height: 300 }) } satisfies DrawingChartApi;
const series = { coordinateToPrice: (y: number) => 300 - y, priceToCoordinate: (price: number) => 300 - price } satisfies DrawingSeriesApi;
const host = { current: document.createElement("div") };
const props = { chart, series, host, times: [100, 160, 220, 280], scope: "rhc:7", precision: 2 };
function point(x: number, y: number): void { fireEvent.pointerDown(screen.getByLabelText("Chart drawings"), { clientX: x, clientY: y }); }
beforeEach(() => { localStorage.clear(); useLighterAnalysisStore.setState({ charts: {}, favorites: [] }); scale.timeToCoordinate.mockReturnValue(0); vi.stubGlobal("PointerEvent", MouseEvent); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("Chart drawing interactions", () => {
  it("places and edits a price level, persists, undoes, redoes and deletes", () => {
    render(<ChartDrawings {...props} />);
    const overlay = screen.getByLabelText("Chart drawings");
    expect(overlay.style.pointerEvents).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "Horizontal line" }));
    expect(overlay.style.pointerEvents).toBe("auto");
    point(10, 100);
    expect(overlay.style.pointerEvents).toBe("none");
    expect(screen.getByRole("button", { name: "horizontal drawing at 200.00" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Start price"), { target: { value: "250" } });
    expect(requireValue(requireValue(useLighterAnalysisStore.getState().charts["rhc:7"]).drawings[0]).a.price).toBe(250);
    fireEvent.click(screen.getByRole("button", { name: "Undo drawing change" }));
    expect(screen.getByRole("button", { name: "horizontal drawing at 200.00" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Redo drawing change" }));
    expect(screen.getByRole("button", { name: "horizontal drawing at 250.00" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete selected drawing" }));
    expect(requireValue(useLighterAnalysisStore.getState().charts["rhc:7"]).drawings).toEqual([]);
  });
  it("uses two anchors for a trend line and moves its end without a new drawing", () => {
    render(<ChartDrawings {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Trend line" }));
    point(10, 100); point(20, 150);
    let saved = requireValue(useLighterAnalysisStore.getState().charts["rhc:7"]).drawings;
    expect(requireValue(saved[0]).a).toEqual({ time: 160, price: 200 });
    expect(requireValue(saved[0]).b).toEqual({ time: 220, price: 150 });
    fireEvent.click(screen.getByRole("button", { name: "Move end" })); point(30, 80);
    saved = requireValue(useLighterAnalysisStore.getState().charts["rhc:7"]).drawings;
    expect(saved).toHaveLength(1);
    expect(requireValue(saved[0]).b).toEqual({ time: 280, price: 220 });
    fireEvent.keyDown(screen.getByRole("button", { name: "trend drawing at 200.00" }), { key: "Delete" });
    expect(requireValue(useLighterAnalysisStore.getState().charts["rhc:7"]).drawings).toEqual([]);
  });
  it("cancels an unfinished drawing and isolates environment/market storage", () => {
    const view = render(<ChartDrawings {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Rectangle" })); point(10, 100);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByLabelText("Edit selected drawing")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Horizontal line" })); point(10, 100);
    view.unmount();
    const core = render(<ChartDrawings {...props} scope="core:7" />);
    expect(screen.queryByRole("button", { name: "horizontal drawing at 200.00" })).toBeNull();
    core.unmount(); render(<ChartDrawings {...props} />);
    expect(screen.getByRole("button", { name: "horizontal drawing at 200.00" })).toBeTruthy();
  });
  it("maps anchors against the actual chart origin when other series retain earlier timestamps", () => {
    scale.timeToCoordinate.mockReturnValue(100);
    render(<ChartDrawings {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Trend line" }));
    point(110, 100); point(120, 150);
    const saved = requireValue(useLighterAnalysisStore.getState().charts["rhc:7"]).drawings;
    expect(requireValue(saved[0]).a.time).toBe(160);
    expect(requireValue(saved[0]).b.time).toBe(220);
    expect(screen.getByRole("button", { name: "trend drawing at 200.00" }).querySelector("circle")?.getAttribute("cx")).toBe("110");
  });
  it("consumes Escape while editing without closing the surrounding workspace", () => {
    render(<ChartDrawings {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Horizontal line" }));
    point(10, 100);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    fireEvent(screen.getByLabelText("Start price"), escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(screen.queryByLabelText("Edit selected drawing")).toBeNull();
    expect(screen.getByRole("button", { name: "horizontal drawing at 200.00" })).toBeTruthy();
  });
  it("rounds annotation anchors to the market tick and precision", () => {
    render(<ChartDrawings {...props} precision={1} minMove={0.1} />);
    fireEvent.click(screen.getByRole("button", { name: "Horizontal line" }));
    point(10, 100.234567);
    expect((screen.getByLabelText("Start price") as HTMLInputElement).value).toBe("199.8");
    expect(screen.getByLabelText("Start price").getAttribute("step")).toBe("0.1");
  });
  it("does not place anchors outside the main price pane", () => {
    render(<ChartDrawings {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Horizontal line" }));
    point(20, 350); point(510, 20);
    expect(requireValue(useLighterAnalysisStore.getState().charts["rhc:7"]).drawings).toEqual([]);
  });
});
