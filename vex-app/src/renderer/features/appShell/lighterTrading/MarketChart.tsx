import { useEffect, useRef, useState, type JSX } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  LineStyle,
  TickMarkType,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IRange,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type {
  LighterTradingCandle,
  LighterTradingCandleConnectionStatus,
  LighterTradingEnvironment,
  LighterTradingResolution,
} from "@shared/schemas/lighter-trading.js";
import { IconPlus, IconRefresh } from "../../../components/icons/index.js";
import {
  toChartCandles,
  toChartVolume,
  upsertChartCandles,
  type ChartCandleRow,
} from "./chart-adapter.js";

import { ChartTools } from "./ChartTools.js";

const INITIAL_VISIBLE_BARS = 100;
const LIVE_RIGHT_OFFSET = 7;

interface ChartLegendValues {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

interface AppliedChartData {
  readonly identity: string;
  readonly sourceRows: ChartCandleRow[];
  readonly candles: CandlestickData<UTCTimestamp>[];
  readonly volumes: HistogramData<UTCTimestamp>[];
  readonly viewportDecided: boolean;
}

export interface MarketChartProps {
  readonly candles: readonly LighterTradingCandle[];
  readonly status?: LighterTradingCandleConnectionStatus;
  readonly symbol: string;
  readonly theme: "chronos" | "celeris";
  readonly environment?: LighterTradingEnvironment;
  readonly marketId?: number;
  readonly resolution?: LighterTradingResolution;
  readonly pricePrecision?: number;
  readonly priceMinMove?: number;
  readonly snapshotFailed?: boolean;
  readonly onRetry?: () => void;
  readonly onChooseMarket?: () => void;
}

function CandleChartLoading({ symbol }: { readonly symbol: string }): JSX.Element {
  return (
    <div
      className="lit-chart-loading"
      role="status"
      aria-label={`Building ${symbol} candle chart`}
    >
      <svg viewBox="0 0 720 280" aria-hidden="true" focusable="false">
        <g className="lit-chart-loading-candle lit-chart-loading-candle--up"><line x1="58" y1="136" x2="58" y2="214" /><rect x="48" y="158" width="20" height="34" rx="2" /></g>
        <g className="lit-chart-loading-candle lit-chart-loading-candle--down"><line x1="100" y1="124" x2="100" y2="194" /><rect x="90" y="140" width="20" height="34" rx="2" /></g>
        <g className="lit-chart-loading-candle lit-chart-loading-candle--down"><line x1="142" y1="146" x2="142" y2="226" /><rect x="132" y="164" width="20" height="38" rx="2" /></g>
        <g className="lit-chart-loading-candle lit-chart-loading-candle--up"><line x1="184" y1="130" x2="184" y2="210" /><rect x="174" y="150" width="20" height="38" rx="2" /></g>
        <g className="lit-chart-loading-candle lit-chart-loading-candle--up"><line x1="226" y1="104" x2="226" y2="180" /><rect x="216" y="124" width="20" height="34" rx="2" /></g>
        <g className="lit-chart-loading-candle lit-chart-loading-candle--down"><line x1="268" y1="92" x2="268" y2="168" /><rect x="258" y="110" width="20" height="36" rx="2" /></g>
        <g className="lit-chart-loading-candle lit-chart-loading-candle--up"><line x1="310" y1="112" x2="310" y2="192" /><rect x="300" y="132" width="20" height="38" rx="2" /></g>
        <g className="lit-chart-loading-candle lit-chart-loading-candle--up"><line x1="352" y1="80" x2="352" y2="160" /><rect x="342" y="100" width="20" height="36" rx="2" /></g>
        <g className="lit-chart-loading-candle lit-chart-loading-candle--down"><line x1="394" y1="66" x2="394" y2="148" /><rect x="384" y="86" width="20" height="38" rx="2" /></g>
        <g className="lit-chart-loading-candle lit-chart-loading-candle--down"><line x1="436" y1="92" x2="436" y2="176" /><rect x="426" y="112" width="20" height="40" rx="2" /></g>
        <g className="lit-chart-loading-candle lit-chart-loading-candle--up"><line x1="478" y1="72" x2="478" y2="152" /><rect x="468" y="92" width="20" height="36" rx="2" /></g>
        <g className="lit-chart-loading-candle lit-chart-loading-candle--up"><line x1="520" y1="46" x2="520" y2="128" /><rect x="510" y="68" width="20" height="36" rx="2" /></g>
        <g className="lit-chart-loading-candle lit-chart-loading-candle--down"><line x1="562" y1="58" x2="562" y2="142" /><rect x="552" y="78" width="20" height="40" rx="2" /></g>
        <g className="lit-chart-loading-candle lit-chart-loading-candle--up"><line x1="604" y1="40" x2="604" y2="118" /><rect x="594" y="60" width="20" height="34" rx="2" /></g>
        <g className="lit-chart-loading-candle lit-chart-loading-candle--up"><line x1="646" y1="24" x2="646" y2="102" /><rect x="636" y="44" width="20" height="34" rx="2" /></g>
      </svg>
      <span>
        <b>Loading {symbol} market</b>
        <small>Pulling in the latest chart, prices, and order book.</small>
      </span>
    </div>
  );
}

function timestampToLocalDate(time: Time): Date | null {
  if (typeof time === "number") return new Date(Number(time) * 1_000);
  if (typeof time === "string") {
    const parsed = new Date(time);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(time.year, time.month - 1, time.day);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatLocalChartTime(time: Time): string {
  const date = timestampToLocalDate(time);
  if (date === null) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatLocalChartTick(time: Time, tickMarkType: TickMarkType): string {
  const date = timestampToLocalDate(time);
  if (date === null) return "";
  switch (tickMarkType) {
    case TickMarkType.Year:
      return new Intl.DateTimeFormat(undefined, { year: "numeric" }).format(date);
    case TickMarkType.Month:
      return new Intl.DateTimeFormat(undefined, { month: "short" }).format(date);
    case TickMarkType.DayOfMonth:
      return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
    case TickMarkType.TimeWithSeconds:
      return new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(date);
    case TickMarkType.Time:
      return new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(date);
  }
}

function resolvePriceFormat(
  precisionInput: number | undefined,
  minMoveInput: number | undefined,
): { type: "price"; precision: number; minMove: number } {
  const precision = Number.isInteger(precisionInput) && precisionInput! >= 0
    ? Math.min(precisionInput!, 18)
    : 2;
  const defaultMinMove = 10 ** -precision;
  const minMove = Number.isFinite(minMoveInput) && minMoveInput! > 0
    ? minMoveInput!
    : defaultMinMove;
  return { type: "price", precision, minMove };
}

function initialVisibleRange(length: number): IRange<number> {
  return {
    from: Math.max(0, length - INITIAL_VISIBLE_BARS),
    to: Math.max(0, length - 1) + LIVE_RIGHT_OFFSET,
  };
}

function sameCandle(
  left: CandlestickData<UTCTimestamp>,
  right: CandlestickData<UTCTimestamp>,
): boolean {
  return left.time === right.time
    && left.open === right.open
    && left.high === right.high
    && left.low === right.low
    && left.close === right.close;
}

function sameVolume(
  left: HistogramData<UTCTimestamp>,
  right: HistogramData<UTCTimestamp>,
): boolean {
  return left.time === right.time
    && left.value === right.value
    && left.color === right.color;
}

function latestLegend(
  candles: readonly CandlestickData<UTCTimestamp>[],
  volumes: readonly HistogramData<UTCTimestamp>[],
): ChartLegendValues | null {
  const candle = candles.at(-1);
  if (candle === undefined) return null;
  const volume = volumes.findLast((point) => point.time === candle.time);
  return {
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: volume?.value ?? 0,
  };
}

function getChartColors(host: HTMLElement): {
  readonly ink: string;
  readonly grid: string;
  readonly positive: string;
  readonly negative: string;
  readonly positiveVolume: string;
  readonly negativeVolume: string;
  readonly fontFamily: string;
  readonly fontSize: number;
} {
  const styles = getComputedStyle(host);
  const chartFontSize = Number.parseFloat(
    styles.getPropertyValue("--lit-chart-font-size").trim(),
  );
  return {
    ink: styles.getPropertyValue("--lit-ink-secondary").trim(),
    grid: styles.getPropertyValue("--lit-grid").trim(),
    positive: styles.getPropertyValue("--lit-positive").trim(),
    negative: styles.getPropertyValue("--lit-negative").trim(),
    positiveVolume: styles.getPropertyValue("--lit-positive-volume").trim(),
    negativeVolume: styles.getPropertyValue("--lit-negative-volume").trim(),
    fontFamily: styles.fontFamily,
    fontSize: Number.isFinite(chartFontSize) ? chartFontSize : 13,
  };
}

export function MarketChart({
  candles,
  status,
  symbol,
  theme,
  environment,
  marketId,
  resolution,
  pricePrecision,
  priceMinMove,
  snapshotFailed = false,
  onRetry,
  onChooseMarket,
}: MarketChartProps): JSX.Element {
  const [chartApi, setChartApi] = useState<IChartApi | null>(null);
  const [chartType, setChartType] = useState<"candles" | "line">("candles");
  const lineSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const appliedDataRef = useRef<AppliedChartData | null>(null);
  const latestLegendRef = useRef<ChartLegendValues | null>(null);
  const crosshairActiveRef = useRef(false);
  const [legend, setLegend] = useState<ChartLegendValues | null>(null);
  const identity = `${environment ?? "unknown"}:${marketId ?? symbol}:${resolution ?? "unknown"}`;
  const precision = resolvePriceFormat(pricePrecision, priceMinMove).precision;
  const loading = candles.length === 0
    && status !== undefined
    && status !== "unavailable"
    && status !== "stopped";

  const zoomVisibleRange = (factor: number): void => {
    const chart = chartRef.current;
    const applied = appliedDataRef.current;
    if (chart === null || applied === null || applied.candles.length === 0) return;
    const timeScale = chart.timeScale();
    const visible = timeScale.getVisibleLogicalRange();
    if (visible === null) return;
    const currentWidth = Math.max(1, visible.to - visible.from);
    const maximumWidth = Math.max(16, applied.candles.length + LIVE_RIGHT_OFFSET * 2);
    const nextWidth = Math.min(maximumWidth, Math.max(12, currentWidth * factor));
    const center = (visible.from + visible.to) / 2;
    timeScale.setVisibleLogicalRange({
      from: center - nextWidth / 2,
      to: center + nextWidth / 2,
    });
  };

  const resetVisibleRange = (): void => {
    const chart = chartRef.current;
    const applied = appliedDataRef.current;
    if (chart === null || applied === null || applied.candles.length === 0) return;
    chart.timeScale().setVisibleLogicalRange(initialVisibleRange(applied.candles.length));
  };

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    const colors = getChartColors(host);
    const priceFormat = resolvePriceFormat(pricePrecision, priceMinMove);

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: colors.ink,
        attributionLogo: false,
        fontFamily: colors.fontFamily,
        fontSize: colors.fontSize,
      },
      localization: { timeFormatter: formatLocalChartTime },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      rightPriceScale: { borderColor: colors.grid },
      timeScale: {
        borderColor: colors.grid,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: LIVE_RIGHT_OFFSET,
        shiftVisibleRangeOnNewBar: false,
        tickMarkFormatter: formatLocalChartTick,
      },
      crosshair: {
        vertLine: { color: colors.ink, labelBackgroundColor: colors.ink },
        horzLine: { color: colors.ink, labelBackgroundColor: colors.ink },
      },
      handleScale: true,
      handleScroll: true,
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: colors.positive,
      downColor: colors.negative,
      wickUpColor: colors.positive,
      wickDownColor: colors.negative,
      borderVisible: false,
      priceFormat,
      priceLineVisible: true,
      priceLineStyle: LineStyle.Dotted,
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: true,
      priceLineVisible: false,
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    const handleCrosshairMove = (param: Parameters<IChartApi["subscribeCrosshairMove"]>[0] extends (
      event: infer TEvent,
    ) => void ? TEvent : never): void => {
      const candlePoint = param.seriesData.get(candleSeries);
      const volumePoint = param.seriesData.get(volumeSeries);
      if (
        param.point !== undefined
        && candlePoint !== undefined
        && "open" in candlePoint
        && "high" in candlePoint
        && "low" in candlePoint
        && "close" in candlePoint
      ) {
        crosshairActiveRef.current = true;
        setLegend({
          open: candlePoint.open,
          high: candlePoint.high,
          low: candlePoint.low,
          close: candlePoint.close,
          volume: volumePoint !== undefined && "value" in volumePoint
            ? volumePoint.value
            : 0,
        });
        return;
      }
      crosshairActiveRef.current = false;
      setLegend(latestLegendRef.current);
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    setChartApi(chart);
    const volumeVisibility = (event: Event): void => volumeSeries.applyOptions({ visible: (event as CustomEvent<boolean>).detail });
    host.addEventListener("lit-chart-volume", volumeVisibility);

    return () => {
      host.removeEventListener("lit-chart-volume", volumeVisibility);
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      appliedDataRef.current = null;
    };
    // The chart is intentionally created once. Theme and precision changes are
    // applied in place so they cannot reset the user's visible range.
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (host === null || chart === null || candleSeries === null || volumeSeries === null) return;

    const colors = getChartColors(host);
    const timeScale = chart.timeScale();
    const visibleRange = timeScale.getVisibleLogicalRange();
    chart.applyOptions({
      layout: {
        textColor: colors.ink,
        fontFamily: colors.fontFamily,
        fontSize: colors.fontSize,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      rightPriceScale: { borderColor: colors.grid },
      timeScale: { borderColor: colors.grid },
      crosshair: {
        vertLine: { color: colors.ink, labelBackgroundColor: colors.ink },
        horzLine: { color: colors.ink, labelBackgroundColor: colors.ink },
      },
    });
    candleSeries.applyOptions({
      upColor: colors.positive,
      downColor: colors.negative,
      wickUpColor: colors.positive,
      wickDownColor: colors.negative,
      priceFormat: resolvePriceFormat(pricePrecision, priceMinMove),
    });

    const applied = appliedDataRef.current;
    if (applied !== null) {
      const recoloredVolumes = toChartVolume(
        applied.sourceRows,
        colors.positiveVolume,
        colors.negativeVolume,
      );
      const latestTime = recoloredVolumes.at(-1)?.time;
      for (const point of recoloredVolumes) {
        volumeSeries.update(point, point.time !== latestTime);
      }
      appliedDataRef.current = { ...applied, volumes: recoloredVolumes };
      latestLegendRef.current = latestLegend(applied.candles, recoloredVolumes);
      if (!crosshairActiveRef.current) setLegend(latestLegendRef.current);
    }
    if (visibleRange !== null) timeScale.setVisibleLogicalRange(visibleRange);
  }, [environment, theme, pricePrecision, priceMinMove]);

  useEffect(() => {
    const host = hostRef.current;
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (host === null || chart === null || candleSeries === null || volumeSeries === null) return;

    const colors = getChartColors(host);
    const previous = appliedDataRef.current;
    const identityChanged = previous === null || previous.identity !== identity;
    const sourceRows = upsertChartCandles(
      identityChanged ? [] : previous.sourceRows,
      candles,
    );
    const chartCandles = toChartCandles(sourceRows);
    const chartVolumes = toChartVolume(
      sourceRows,
      colors.positiveVolume,
      colors.negativeVolume,
    );
    const timeScale = chart.timeScale();

    if (identityChanged) {
      candleSeries.setData(chartCandles);
      volumeSeries.setData(chartVolumes);
      const viewportDecided = chartCandles.length > 0;
      appliedDataRef.current = {
        identity,
        sourceRows,
        candles: chartCandles,
        volumes: chartVolumes,
        viewportDecided,
      };
      crosshairActiveRef.current = false;
      latestLegendRef.current = latestLegend(chartCandles, chartVolumes);
      setLegend(latestLegendRef.current);
      if (viewportDecided) {
        timeScale.setVisibleLogicalRange(initialVisibleRange(chartCandles.length));
      }
      return;
    }

    const visibleRange = timeScale.getVisibleLogicalRange();
    const previousLastTime = previous.candles.at(-1)?.time;
    const wasLive = visibleRange !== null
      && previous.candles.length > 0
      && visibleRange.to >= previous.candles.length - 1;
    const priorCandlesByTime = new Map(previous.candles.map((point) => [point.time, point]));
    const priorVolumesByTime = new Map(previous.volumes.map((point) => [point.time, point]));
    let appendedBars = 0;
    let changed = false;
    const firstTime = chartCandles[0]?.time;
    const droppedBars = firstTime === undefined ? 0 : previous.candles.filter(point => point.time < firstTime).length;
    if (droppedBars > 0) {
      // Keep every native series on the same bounded timeline as the adapter.
      // Retaining invisible old points changes logical indexes and drawing anchors.
      candleSeries.setData(chartCandles);
      volumeSeries.setData(chartVolumes);
      appendedBars = chartCandles.filter(point => previousLastTime === undefined || point.time > previousLastTime).length;
      changed = true;
    }

    for (const point of droppedBars > 0 ? [] : chartCandles) {
      const prior = priorCandlesByTime.get(point.time);
      if (prior === undefined || !sameCandle(prior, point)) {
        const historicalUpdate = previousLastTime !== undefined && point.time < previousLastTime;
        candleSeries.update(point, historicalUpdate);
        changed = true;
        if (previousLastTime === undefined || point.time > previousLastTime) appendedBars += 1;
      }
    }
    for (const point of droppedBars > 0 ? [] : chartVolumes) {
      const prior = priorVolumesByTime.get(point.time);
      if (prior === undefined || !sameVolume(prior, point)) {
        const historicalUpdate = previousLastTime !== undefined && point.time < previousLastTime;
        volumeSeries.update(point, historicalUpdate);
        changed = true;
      }
    }

    let viewportDecided = previous.viewportDecided;
    if (!viewportDecided && chartCandles.length > 0) {
      timeScale.setVisibleLogicalRange(initialVisibleRange(chartCandles.length));
      viewportDecided = true;
    } else if (visibleRange !== null && changed) {
      const shift = (wasLive ? appendedBars : 0) - droppedBars;
      timeScale.setVisibleLogicalRange(shift === 0 ? visibleRange : {
        from: visibleRange.from + shift,
        to: visibleRange.to + shift,
      });
    }

    appliedDataRef.current = {
      identity,
      sourceRows,
      candles: chartCandles,
      volumes: chartVolumes,
      viewportDecided,
    };
    latestLegendRef.current = latestLegend(chartCandles, chartVolumes);
    if (!crosshairActiveRef.current) setLegend(latestLegendRef.current);
  }, [candles, identity]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    series.applyOptions({ visible: chartType === "candles" });
    if (chartType === "line") {
      if (!lineSeriesRef.current) lineSeriesRef.current = chart.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: true });
      lineSeriesRef.current.applyOptions({ visible: true, color: hostRef.current ? getChartColors(hostRef.current).positive : "#20b7ae", priceFormat: resolvePriceFormat(pricePrecision, priceMinMove) });
    } else lineSeriesRef.current?.applyOptions({ visible: false });
    // Hidden series still contribute timestamps to the shared chart timeline.
    lineSeriesRef.current?.setData((appliedDataRef.current?.candles ?? []).map(c => ({ time: c.time, value: c.close })));
    if (range && lineSeriesRef.current) chart.timeScale().setVisibleLogicalRange(range);
  }, [chartType, candles, identity, theme, pricePrecision, priceMinMove]);

  return (
    <>
      <ChartTools
        key={`${environment ?? "unknown"}:${marketId ?? symbol}`}
        chart={chartApi}
        series={candleSeriesRef.current}
        host={hostRef}
        rows={appliedDataRef.current?.sourceRows ?? candles}
        scope={`${environment ?? "unknown"}:${marketId ?? symbol}`}
        theme={theme}
        precision={precision}
        minMove={resolvePriceFormat(pricePrecision, priceMinMove).minMove}
        onChartType={setChartType}
      />
      <div
        ref={hostRef}
        className="lit-chart-canvas"
        role="img"
        aria-label={`${symbol} ${chartType === "candles" ? "candlestick" : "line"} chart with volume`}
        data-testid="lighter-market-chart"
      />
      {candles.length > 0 ? (
        <div className="lit-chart-tools" role="toolbar" aria-label="Chart controls">
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in"
            data-label="Zoom in"
            onClick={() => zoomVisibleRange(0.75)}
          >
            <IconPlus size={17} />
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out"
            data-label="Zoom out"
            onClick={() => zoomVisibleRange(1.35)}
          >
            <svg className="lit-stroke-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12" /></svg>
          </button>
          <button
            type="button"
            aria-label="Reset chart view"
            title="Reset chart view"
            data-label="Reset view"
            onClick={resetVisibleRange}
          >
            <IconRefresh size={17} />
          </button>
          <button
            type="button"
            aria-label="Return to live candles"
            title="Return to live candles"
            data-label="Go live"
            onClick={resetVisibleRange}
          >
            <svg className="lit-stroke-icon" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="2.25" />
              <path d="M5.8 5.8a6 6 0 0 0 0 8.4M14.2 5.8a6 6 0 0 1 0 8.4" />
            </svg>
          </button>
        </div>
      ) : null}
      {legend !== null ? (
        <div className="lit-chart-legend" aria-label={`${symbol} chart values`}>
          <span><b>O</b> {legend.open.toFixed(precision)}</span>
          <span><b>H</b> {legend.high.toFixed(precision)}</span>
          <span><b>L</b> {legend.low.toFixed(precision)}</span>
          <span><b>C</b> {legend.close.toFixed(precision)}</span>
          <span><b>Vol</b> {legend.volume.toLocaleString()}</span>
        </div>
      ) : null}
      {loading ? <CandleChartLoading symbol={symbol} /> : null}
      {candles.length === 0 && !loading ? (
        <div
          className="lit-chart-empty"
          data-state={snapshotFailed ? "failed" : "unavailable"}
          role={snapshotFailed ? "alert" : "status"}
        >
          <b>{snapshotFailed ? `Couldn’t load ${symbol}` : `No live data for ${symbol}`}</b>
          <span>
            {snapshotFailed
              ? "The market feed didn’t respond."
              : "Choose another market to continue."}
          </span>
          {onRetry !== undefined || onChooseMarket !== undefined ? (
            <span className="lit-chart-empty-actions">
              {snapshotFailed && onRetry !== undefined ? (
                <button type="button" onClick={onRetry}>Try again</button>
              ) : null}
              {onChooseMarket !== undefined ? (
                <button type="button" onClick={onChooseMarket}>Choose another market</button>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
