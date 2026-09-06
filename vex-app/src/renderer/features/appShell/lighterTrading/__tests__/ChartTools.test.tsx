import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IChartApi } from "lightweight-charts";
import { ChartTools } from "../ChartTools.js";
import type { ChartCandleRow } from "../chart-adapter.js";
vi.mock("../ChartDrawings.js", () => ({ ChartDrawings: () => null }));
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup() {
  const lines: { setData: ReturnType<typeof vi.fn>; createPriceLine: ReturnType<typeof vi.fn> }[] = [];
  const setStretchFactor = vi.fn();
  const chart = { takeScreenshot: vi.fn(() => ({ toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["image"])) })), addSeries: vi.fn((_definition: unknown, _options: unknown, _pane: number) => { const line = { setData: vi.fn(), createPriceLine: vi.fn() }; lines.push(line); return line; }), removeSeries: vi.fn(), panes: () => [0, 1, 2].map(() => ({ setStretchFactor })), timeScale: () => ({ getVisibleLogicalRange: () => ({ from: 10, to: 40 }), setVisibleLogicalRange: vi.fn() }) };
  const rows: ChartCandleRow[] = Array.from({ length: 50 }, (_, i) => ({ timestamp: 1_700_000_000 + i * 60, open: 10 + i, close: 11 + i, high: 12 + i, low: 9 + i, volumeBase: 100, volumeQuote: 1000 }));
  const host = { current: document.createElement("div") };
  const props = { chart: chart as unknown as IChartApi, series: null, host, rows, scope: "rhc:7", theme: "chronos", precision: 2, chartType: "candles" as const, onChartType: vi.fn() };
  return { chart, rows, lines, props, setStretchFactor };
}
describe("Chart analysis controls", () => {
  it("adds real independent RSI and MACD panes and removes studies cleanly", () => {
    const { chart, props, setStretchFactor, lines } = setup();
    const view = render(<ChartTools {...props} />);
    expect(chart.addSeries).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /RSI 14/ }));
    expect(chart.addSeries.mock.calls.at(-1)?.[2]).toBe(1);
    expect(lines.at(-1)?.createPriceLine).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("checkbox", { name: /^MACD/ }));
    expect(chart.addSeries.mock.calls.slice(-3).every(call => call[2] === 2)).toBe(true);
    expect(lines.at(-1)?.setData.mock.lastCall?.[0].length).toBeGreaterThan(0);
    expect(setStretchFactor).toHaveBeenCalledWith(3);
    expect(setStretchFactor).toHaveBeenCalledWith(1);
    view.unmount();
    expect(chart.removeSeries).toHaveBeenCalledTimes(chart.addSeries.mock.calls.length);
  });
  it("updates studies for live candles without recreating their series", () => {
    const { chart, props, rows, lines } = setup();
    const view = render(<ChartTools {...props} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /SMA 20/ }));
    const before = lines[0]!.setData.mock.lastCall![0].at(-1).value;
    view.rerender(<ChartTools {...props} rows={rows.map((row, i) => i === 49 ? { ...row, close: row.close + 1 } : row)} />);
    expect(chart.addSeries).toHaveBeenCalledTimes(1);
    expect(lines[0]!.setData.mock.lastCall![0].at(-1).value).toBeCloseTo(before + .05);
  });
  it("restores validated study, volume and type preferences without leaking between markets", () => {
    const { props } = setup();
    localStorage.setItem("vex:chart-preferences:v1:rhc:7", JSON.stringify({ studies: ["ema"], volume: false, chartType: "line" }));
    const view = render(<ChartTools key="rhc:7" {...props} />);
    expect((screen.getByRole("checkbox", { name: /EMA 20/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Volume" }).getAttribute("aria-pressed")).toBe("false");
    expect(props.onChartType).toHaveBeenLastCalledWith("line");
    view.rerender(<ChartTools key="core:7" {...props} scope="core:7" />);
    expect((screen.getByRole("checkbox", { name: /EMA 20/ }) as HTMLInputElement).checked).toBe(false);
    expect(props.onChartType).toHaveBeenLastCalledWith("candles");
    fireEvent.click(screen.getByRole("checkbox", { name: /SMA 20/ }));
    expect(JSON.parse(localStorage.getItem("vex:chart-preferences:v1:core:7")!).studies).toEqual(["sma"]);
    view.rerender(<ChartTools key="rhc:7" {...props} />);
    expect((screen.getByRole("checkbox", { name: /EMA 20/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /SMA 20/ }) as HTMLInputElement).checked).toBe(false);
  });
  it("applies restored volume visibility when the chart becomes ready", () => {
    const { props } = setup();
    localStorage.setItem("vex:chart-preferences:v1:rhc:7", JSON.stringify({ studies: [], volume: false, chartType: "candles" }));
    const view = render(<ChartTools {...props} chart={null} />);
    const volume = vi.fn(); props.host.current.addEventListener("lit-chart-volume", volume);
    view.rerender(<ChartTools {...props} />);
    expect(volume.mock.lastCall![0].detail).toBe(false);
  });
  it("exports the native chart image and releases the download URL", () => {
    vi.useFakeTimers();
    const { chart, props } = setup();
    const createObjectURL = vi.fn(() => "blob:chart-image"); const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ChartTools {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Save chart image without drawings" }));
    expect(chart.takeScreenshot).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toContain("Drawings are not included");
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:chart-image");
  });
  it("routes type and volume controls and closes the study disclosure with Escape", () => {
    const { props } = setup();
    const volume = vi.fn(); props.host.current.addEventListener("lit-chart-volume", volume);
    render(<ChartTools {...props} />);
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "line" } });
    expect(props.onChartType).toHaveBeenCalledWith("line");
    fireEvent.click(screen.getByRole("button", { name: "Volume" }));
    expect(volume.mock.lastCall![0].detail).toBe(false);
    const details = screen.getByText("Indicators").closest("details")!;
    details.open = true;
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    fireEvent(details, escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(details.open).toBe(false);
  });
});
