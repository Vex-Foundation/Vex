import { useEffect, useRef, type JSX } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts";
import type { LighterTradingSnapshot } from "@shared/schemas/lighter-trading.js";
import { toChartCandles, toChartVolume } from "./chart-adapter.js";

export interface MarketChartProps {
  readonly candles: LighterTradingSnapshot["candles"];
  readonly symbol: string;
  readonly theme: "chronos" | "celeris";
}

export function MarketChart({ candles, symbol, theme }: MarketChartProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;

    const styles = getComputedStyle(host);
    const ink = styles.getPropertyValue("--lit-ink-secondary").trim();
    const grid = styles.getPropertyValue("--lit-grid").trim();
    const positive = styles.getPropertyValue("--lit-positive").trim();
    const negative = styles.getPropertyValue("--lit-negative").trim();

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: ink,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: grid },
        horzLines: { color: grid },
      },
      rightPriceScale: { borderColor: grid },
      timeScale: {
        borderColor: grid,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
      },
      crosshair: {
        vertLine: { color: ink, labelBackgroundColor: ink },
        horzLine: { color: ink, labelBackgroundColor: ink },
      },
      handleScale: true,
      handleScroll: true,
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: positive,
      downColor: negative,
      wickUpColor: positive,
      wickDownColor: negative,
      borderVisible: false,
      priceLineVisible: true,
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [theme]);

  useEffect(() => {
    const host = hostRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (host === null || candleSeries === null || volumeSeries === null) return;
    const styles = getComputedStyle(host);
    const positive = styles.getPropertyValue("--lit-positive-volume").trim();
    const negative = styles.getPropertyValue("--lit-negative-volume").trim();
    const chartCandles = toChartCandles(candles);
    candleSeries.setData(chartCandles);
    volumeSeries.setData(toChartVolume(candles, positive, negative));
    if (chartCandles.length > 0) chartRef.current?.timeScale().fitContent();
  }, [candles, theme]);

  return (
    <>
      <div
        ref={hostRef}
        className="lit-chart-canvas"
        role="img"
        aria-label={`${symbol} candlestick chart with volume`}
        data-testid="lighter-market-chart"
      />
      {candles.length === 0 ? (
        <div className="lit-chart-empty" role="status">
          <span>No candle history is available for {symbol}.</span>
          <span>The chart stays empty rather than displaying simulated data.</span>
        </div>
      ) : null}
    </>
  );
}
