import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrawingChartApi, DrawingSeriesApi } from "../chart-analysis-api.js";
import { ChartOrderHandle } from "../ChartOrderHandle.js";

const scale = { timeToCoordinate: () => 0, subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn(), coordinateToLogical: (x: number) => x, logicalToCoordinate: (x: number) => x };
const chart = { timeScale: () => scale, subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(), paneSize: () => ({ width: 500, height: 300 }) } satisfies DrawingChartApi;
// One pixel is one price unit: y = 300 - price.
const series = { coordinateToPrice: (y: number) => 300 - y, priceToCoordinate: (price: number) => 300 - price } satisfies DrawingSeriesApi;
const host = { current: document.createElement("div") };

function renderHandle(lastPrice = 200): ReturnType<typeof vi.fn> {
  const onDragOrder = vi.fn();
  render(<ChartOrderHandle chart={chart} series={series} host={host} lastPrice={lastPrice} precision={2} minMove={0.5} onDragOrder={onDragOrder} />);
  return onDragOrder;
}
const handle = (): HTMLElement => screen.getByRole("button", { name: "Drag to place a limit order" });

beforeEach(() => { vi.stubGlobal("PointerEvent", MouseEvent); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ChartOrderHandle", () => {
  it("rests on the last price and drops a buy limit below it through the callback", () => {
    const onDragOrder = renderHandle();
    expect(handle().style.top).toBe("100px");
    fireEvent.pointerDown(handle(), { button: 0, clientX: 470, clientY: 100 });
    fireEvent.pointerMove(handle(), { clientX: 470, clientY: 150.3 });
    expect(screen.getByRole("status").textContent).toBe("Buy limit 149.50");
    expect(onDragOrder).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle(), { clientX: 470, clientY: 150.3 });
    expect(onDragOrder).toHaveBeenCalledWith("149.50", "buy");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("sells above the last price and ignores a press that never moved", () => {
    const onDragOrder = renderHandle();
    fireEvent.pointerDown(handle(), { button: 0, clientX: 470, clientY: 100 });
    fireEvent.pointerMove(handle(), { clientX: 470, clientY: 101 });
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.pointerUp(handle(), { clientX: 470, clientY: 101 });
    expect(onDragOrder).not.toHaveBeenCalled();

    fireEvent.pointerDown(handle(), { button: 0, clientX: 470, clientY: 100 });
    fireEvent.pointerMove(handle(), { clientX: 470, clientY: 60 });
    expect(screen.getByRole("status").textContent).toBe("Sell limit 240.00");
    fireEvent.pointerUp(handle(), { clientX: 470, clientY: 60 });
    expect(onDragOrder).toHaveBeenCalledWith("240.00", "sell");
  });

  it("cancels on Escape and places a keyboard nudge on Enter", () => {
    const onDragOrder = renderHandle();
    fireEvent.pointerDown(handle(), { button: 0, clientX: 470, clientY: 100 });
    fireEvent.pointerMove(handle(), { clientX: 470, clientY: 140 });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.pointerUp(handle(), { clientX: 470, clientY: 140 });
    expect(onDragOrder).not.toHaveBeenCalled();

    fireEvent.keyDown(handle(), { key: "ArrowUp", shiftKey: true });
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(screen.getByRole("status").textContent).toBe("Sell limit 205.50");
    fireEvent.keyDown(handle(), { key: "Enter" });
    expect(onDragOrder).toHaveBeenCalledWith("205.50", "sell");
  });

  it("hides while the last price is off screen", () => {
    const onDragOrder = vi.fn();
    const offscreen = { ...series, priceToCoordinate: () => null };
    render(<ChartOrderHandle chart={chart} series={offscreen} host={host} lastPrice={200} precision={2} onDragOrder={onDragOrder} />);
    expect(screen.queryByRole("button", { name: "Drag to place a limit order" })).toBeNull();
  });
});
