/**
 * The technical analysis card: the fail-closed reader over a tool act, and the
 * card's own reads through the market bridge.
 *
 * The chart module is replaced, because jsdom has no canvas; what it would
 * draw is the `candles` prop, which the stand-in exposes. Everything else is
 * the shipped card: the shared result schema, the timeframe switch, and the
 * bridge call it makes (and the model calls it never makes).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolCallActView } from "../../transcriptRowModel/act-ledger.js";
import { TechnicalAnalysisResult, closeStamp, readTechnicalAnalysisResult } from "../TechnicalAnalysisResult.js";

vi.mock("../TechnicalAnalysisChart.js", () => ({
  TechnicalAnalysisChart: ({ candles, label }: { candles: readonly unknown[]; label: string }) => (
    <div data-testid="ta-chart" aria-label={label}>{`${candles.length} candles`}</div>
  ),
}));

const AS_OF = "2026-10-23T20:00:00.000Z";

const RESULT = {
  ok: true,
  venue: "lighter",
  environment: "core",
  marketId: 0,
  symbol: "ETH",
  marketType: "perp",
  interval: "4h",
  asOf: AS_OF,
  fetchedAt: "2026-10-23T21:09:42.968Z",
  bars: 100,
  price: 2400.73,
  changePct: -3.21,
  high: 2512.4,
  low: 2311.05,
  indicators: {
    ema20: 2403.1, ema50: 2418.3, ema200: null, rsi14: 47.4212, macd: -4.2, macdSignal: -3.1,
    macdHistogram: -1.1, bollingerUpper: 2450, bollingerMiddle: 2405, bollingerLower: 2360, atr14: 15.3231,
  },
  signals: {
    aboveEma20: false, aboveEma50: false, ema20AboveEma50: false,
    rsiZone: "neutral", macdMomentum: "bearish", bollingerPosition: "lower_half",
  },
  recent: [],
  closedCandles: { droppedForming: 1, gaps: 2, normalized: 0, unpriced: 0, sparse: false },
  source: "live_lighter_public_api",
  provenance: { provider: "lighter" },
} as const;

function act(overrides: Partial<ToolCallActView> = {}): ToolCallActView {
  return {
    toolCallId: "call-1",
    toolName: "lighter.technicalAnalysis",
    toolArgs: "{}",
    output: JSON.stringify(RESULT),
    success: true,
    ...overrides,
  };
}

function candles(n: number) {
  return Array.from({ length: n }, (_, i) => ({ t: 1_790_000_000_000 + i * 3_600_000, o: 1, h: 2, l: 0.5, c: 1.5 }));
}

const readTechnicalAnalysis = vi.fn();

beforeEach(() => {
  readTechnicalAnalysis.mockReset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: { market: { readTechnicalAnalysis } },
  });
});

afterEach(() => cleanup());

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const parsed = readTechnicalAnalysisResult(act());
  if (parsed === null) throw new Error("fixture did not parse");
  return render(
    <QueryClientProvider client={client}>
      <TechnicalAnalysisResult result={parsed} />
    </QueryClientProvider>,
  );
}

describe("readTechnicalAnalysisResult", () => {
  it("accepts an accepted act of either tool whose output parses with the shared contract", () => {
    expect(readTechnicalAnalysisResult(act())).toMatchObject({ venue: "lighter", symbol: "ETH" });
    const dex = { ...RESULT, venue: "dexscreener", chain: "base", pairAddress: "0xAbC", pairLabel: "A/B" } as Record<string, unknown>;
    delete dex.environment;
    delete dex.marketId;
    delete dex.symbol;
    delete dex.marketType;
    expect(readTechnicalAnalysisResult(act({ toolName: "dexscreener.technicalAnalysis", output: JSON.stringify(dex) }))).not.toBeNull();
  });

  it("fails closed on another tool, an unaccepted act, an oversized or malformed output, and schema drift", () => {
    expect(readTechnicalAnalysisResult(act({ toolName: "lighter.candles" }))).toBeNull();
    expect(readTechnicalAnalysisResult(act({ success: false }))).toBeNull();
    expect(readTechnicalAnalysisResult(act({ success: null }))).toBeNull();
    expect(readTechnicalAnalysisResult(act({ output: null }))).toBeNull();
    expect(readTechnicalAnalysisResult(act({ output: `${JSON.stringify(RESULT)}${" ".repeat(20_001)}` }))).toBeNull();
    expect(readTechnicalAnalysisResult(act({ output: "{not json" }))).toBeNull();
    expect(readTechnicalAnalysisResult(act({ output: JSON.stringify({ ...RESULT, extra: 1 }) }))).toBeNull();
    expect(readTechnicalAnalysisResult(act({ output: JSON.stringify({ ...RESULT, price: "2400" }) }))).toBeNull();
  });
});

describe("TechnicalAnalysisResult", () => {
  it("shows the reply's own numbers and draws the bars the reply used", async () => {
    readTechnicalAnalysis.mockResolvedValue({ ok: true, data: { ...RESULT, provenance: undefined, candles: candles(220) } });
    renderCard();
    expect(screen.getByText("ETH perpetual · Lighter Core")).not.toBeNull();
    expect(screen.getByText("2,400.73")).not.toBeNull();
    expect(screen.getByText("-3.21%")).not.toBeNull();
    expect(screen.getByText("Price below EMA 20")).not.toBeNull();
    expect(screen.getByText("MACD momentum down")).not.toBeNull();
    expect(screen.getByText("warming up")).not.toBeNull();
    expect(screen.getByText(/Closed candles to 20:00 UTC, 23 Oct 2026; the forming candle is not used\. 2 missing buckets, not filled\./)).not.toBeNull();
    expect(screen.getByText("The reply was written for 4h.")).not.toBeNull();
    expect(await screen.findByTestId("ta-chart")).not.toBeNull();
    expect(readTechnicalAnalysis).toHaveBeenCalledWith({
      venue: "lighter",
      environment: "core",
      marketId: 0,
      interval: "4h",
      until: Date.parse(AS_OF),
    });
  });

  it("switches timeframe through the read channel alone, and shows that read's numbers", async () => {
    readTechnicalAnalysis.mockImplementation(async (input: { interval: string }) => ({
      ok: true,
      data: { ...RESULT, provenance: undefined, interval: input.interval, price: input.interval === "1d" ? 2388.5 : RESULT.price, candles: candles(100) },
    }));
    renderCard();
    await screen.findByTestId("ta-chart");
    fireEvent.click(screen.getByRole("button", { name: "1d" }));
    expect(screen.getByText("Showing 1d; the reply was written for 4h.")).not.toBeNull();
    await waitFor(() => expect(screen.getByText("2,388.5")).not.toBeNull());
    expect(readTechnicalAnalysis).toHaveBeenLastCalledWith({ venue: "lighter", environment: "core", marketId: 0, interval: "1d" });
    expect(screen.getByRole("button", { name: "1d" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("says why when the chart cannot be read, and keeps the reply's ledger", async () => {
    readTechnicalAnalysis.mockResolvedValue({
      ok: true,
      data: { ok: false, reason: "no_candle_source", message: "Lighter technical analysis unavailable (no_candle_source): no candle source is available here." },
    });
    renderCard();
    expect(await screen.findByText(/The chart for this reply's window cannot be drawn now\./)).not.toBeNull();
    expect(screen.getByText(/\(no_candle_source\)/)).not.toBeNull();
    expect(screen.getByText("2,400.73")).not.toBeNull();
    expect(screen.queryByTestId("ta-chart")).toBeNull();
  });
});

describe("closeStamp", () => {
  it("names the close in UTC", () => {
    expect(closeStamp("2026-10-23T00:00:00.000Z")).toBe("00:00 UTC, 23 Oct 2026");
  });
});
