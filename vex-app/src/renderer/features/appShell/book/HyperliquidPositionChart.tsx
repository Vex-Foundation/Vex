/**
 * Hyperliquid price chart. lightweight-charts is deliberately owned
 * imperatively: live positions and candle snapshots must never rebuild its
 * canvas or reset the user's viewport.
 */

import { useEffect, useMemo, useRef, type JSX } from "react";
import {
  CandlestickSeries,
  HistogramSeries,
  LineStyle,
  createChart,
  type UTCTimestamp,
} from "lightweight-charts";

import type {
  HyperliquidCandleDto,
  HyperliquidCandleInterval,
  HyperliquidPositionDto,
} from "@shared/schemas/hyperliquid.js";

export type CandleChartState = "loading" | "error" | "empty" | "ready";

export function deriveCandleChartState(
  isLoading: boolean,
  isError: boolean,
  result: { readonly ok: boolean; readonly data?: { readonly candles: readonly unknown[] } } | undefined,
): CandleChartState {
  if (isLoading) return "loading";
  if (isError || result?.ok === false) return "error";
  return result?.ok && (result.data?.candles.length ?? 0) > 0 ? "ready" : "empty";
}

type TimeRange = { readonly from: UTCTimestamp; readonly to: UTCTimestamp };
type CandleBar = { readonly time: UTCTimestamp; readonly open: number; readonly high: number; readonly low: number; readonly close: number };
type VolumeBar = { readonly time: UTCTimestamp; readonly value: number };

interface PriceLineHandle {
  applyOptions(options: { readonly price: number }): void;
}

interface PriceLineSeries {
  setData(data: readonly CandleBar[]): void;
  update(bar: CandleBar): void;
  createPriceLine(options: {
    readonly price: number;
    readonly title: string;
    readonly color: string;
    readonly lineWidth: 1;
    readonly lineStyle: LineStyle;
    readonly axisLabelVisible: boolean;
  }): PriceLineHandle;
  removePriceLine(line: PriceLineHandle): void;
}

interface VolumeSeries {
  setData(data: readonly VolumeBar[]): void;
  update(bar: VolumeBar): void;
  priceScale(): { applyOptions(options: { readonly scaleMargins: { readonly top: number; readonly bottom: number } }): void };
}

interface ChartHandle {
  addSeries(type: typeof CandlestickSeries, options: Record<string, unknown>): PriceLineSeries;
  addSeries(type: typeof HistogramSeries, options: Record<string, unknown>): VolumeSeries;
  timeScale(): {
    fitContent(): void;
    getVisibleRange(): TimeRange | null;
    setVisibleRange(range: TimeRange): void;
    scrollPosition(): number;
    scrollToRealTime(): void;
    subscribeVisibleTimeRangeChange(callback: (range: TimeRange | null) => void): void;
  };
  applyOptions(options: { readonly width?: number; readonly height?: number }): void;
  remove(): void;
}

interface ChartTokens {
  readonly bg: string;
  readonly axis: string;
  readonly grid: string;
  readonly border: string;
  readonly long: string;
  readonly short: string;
  readonly volume: string;
  readonly entry: string;
  readonly sl: string;
  readonly liq: string;
}

interface PriceLineState {
  readonly handle: PriceLineHandle;
  readonly price: number;
}

const LIVE_EDGE_EPSILON = 0.5;

function renderNumber(value: string): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** A semantic revision deliberately excludes `fetchedAt`. */
export function candleRevision(candles: readonly HyperliquidCandleDto[] | null): string {
  if (candles === null) return "";
  return candles.map((candle) => [
    candle.openTimeMs,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
  ].join(":")) .join("|");
}

function marketKey(coin: string, interval: HyperliquidCandleInterval): string {
  return `${coin}\u0000${interval}`;
}

function candleBars(candles: readonly HyperliquidCandleDto[]): { readonly candles: CandleBar[]; readonly volume: VolumeBar[] } {
  const bars: CandleBar[] = [];
  const volume: VolumeBar[] = [];
  for (const candle of candles) {
    const time = Math.floor(candle.openTimeMs / 1_000) as UTCTimestamp;
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const value = Number(candle.volume);
    if (![open, high, low, close, value].every(Number.isFinite)) continue;
    bars.push({ time, open, high, low, close });
    volume.push({ time, value });
  }
  return { candles: bars, volume };
}

/**
 * lightweight-charts colors are JS options, not CSS, so the design tokens are
 * read from the mounted shell. They are captured once because this component
 * has no theme-version input; changing a live position must not recreate it.
 */
function readChartTokens(host: Element): ChartTokens {
  const style = getComputedStyle(host);
  const read = (name: string): string => style.getPropertyValue(name).trim();
  return {
    bg: read("--vex-chart-bg"), axis: read("--vex-chart-axis"), grid: read("--vex-chart-grid"),
    border: read("--vex-line-strong"), long: read("--vex-long"), short: read("--vex-short"),
    volume: read("--vex-chart-volume"), entry: read("--vex-chart-entry"), sl: read("--vex-chart-sl"), liq: read("--vex-chart-liq"),
  };
}

export function HyperliquidPositionChart({
  coin,
  interval = "1h",
  candles,
  state,
  position = null,
  fill = false,
}: {
  readonly coin: string;
  readonly interval?: HyperliquidCandleInterval;
  readonly candles: readonly HyperliquidCandleDto[] | null;
  readonly state: CandleChartState;
  readonly position?: HyperliquidPositionDto | null;
  readonly fill?: boolean;
}): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const chart = useRef<ChartHandle | null>(null);
  const candleSeries = useRef<PriceLineSeries | null>(null);
  const volumeSeries = useRef<VolumeSeries | null>(null);
  const tokens = useRef<ChartTokens | null>(null);
  const lines = useRef<Map<string, PriceLineState>>(new Map());
  const savedTimeRange = useRef<TimeRange | null>(null);
  const loadedMarket = useRef<string | null>(null);
  const liveCandle = useRef<{ readonly market: string; readonly candle: HyperliquidCandleDto } | null>(null);
  const candleSnapshot = useRef(candles);
  candleSnapshot.current = candles;
  const fillRef = useRef(fill);
  fillRef.current = fill;
  const revision = useMemo(() => candleRevision(candles), [candles]);
  const overlayKey = `${position?.entryPx ?? ""}|${position?.slPrice ?? ""}|${position?.tpPrice ?? ""}|${position?.liquidationPx ?? ""}`;

  // (a) Chart ownership: one canvas/series/observer for this mounted host.
  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const token = readChartTokens(element);
    const instance = createChart(element, {
      width: Math.max(element.clientWidth, 220),
      height: fillRef.current ? Math.max(element.clientHeight, 220) : 180,
      layout: { background: { color: token.bg || "transparent" }, textColor: token.axis },
      grid: { vertLines: { color: token.grid }, horzLines: { color: token.grid } },
      rightPriceScale: { borderColor: token.border },
      timeScale: {
        borderColor: token.border,
        timeVisible: true,
        shiftVisibleRangeOnNewBar: true,
        lockVisibleTimeRangeOnResize: true,
        rightBarStaysOnScroll: false,
      },
    }) as unknown as ChartHandle;
    const series = instance.addSeries(CandlestickSeries, {
      upColor: token.long, downColor: token.short, borderVisible: false,
      wickUpColor: token.long, wickDownColor: token.short,
    });
    const volume = instance.addSeries(HistogramSeries, {
      priceScaleId: "volume", priceFormat: { type: "volume" }, color: token.volume,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    instance.timeScale().subscribeVisibleTimeRangeChange((range) => { savedTimeRange.current = range; });
    const resize = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      const height = entries[0]?.contentRect.height;
      if (width !== undefined && width > 0) {
        instance.applyOptions({ width, ...(fillRef.current && height !== undefined && height > 0 ? { height } : {}) });
      }
    });
    resize.observe(element);
    chart.current = instance;
    candleSeries.current = series;
    volumeSeries.current = volume;
    tokens.current = token;
    return () => {
      for (const line of lines.current.values()) series.removePriceLine(line.handle);
      lines.current.clear();
      candleSeries.current = null;
      volumeSeries.current = null;
      chart.current = null;
      tokens.current = null;
      resize.disconnect();
      instance.remove();
    };
  }, []);

  // (b) Snapshot reconciliation: replace series data, never the chart. A
  // time-range is stable when historical bars are inserted/replaced; logical
  // indexes are not. `setVisibleRange` clamps unavailable endpoints itself.
  useEffect(() => {
    const snapshot = candleSnapshot.current;
    if (snapshot === null || snapshot.length === 0) return;
    const instance = chart.current;
    const series = candleSeries.current;
    const volume = volumeSeries.current;
    if (instance === null || series === null || volume === null) return;
    const key = marketKey(coin, interval);
    const previousRange = instance.timeScale().getVisibleRange() ?? savedTimeRange.current;
    const atLiveEdge = instance.timeScale().scrollPosition() <= LIVE_EDGE_EPSILON;
    const { candles: nextCandles, volume: nextVolume } = candleBars(snapshot);
    const latest = liveCandle.current;
    if (latest !== null && latest.market === key) {
      const live = candleBars([latest.candle]);
      const liveBar = live.candles[0];
      const liveVolume = live.volume[0];
      if (liveBar !== undefined && liveVolume !== undefined) {
        const index = nextCandles.findIndex((bar) => bar.time === liveBar.time);
        if (index >= 0) {
          nextCandles[index] = liveBar;
          nextVolume[index] = liveVolume;
        } else if (nextCandles.length === 0 || nextCandles[nextCandles.length - 1]!.time < liveBar.time) {
          nextCandles.push(liveBar);
          nextVolume.push(liveVolume);
        }
      }
    }
    series.setData(nextCandles);
    volume.setData(nextVolume);
    if (loadedMarket.current !== key) {
      savedTimeRange.current = null;
      instance.timeScale().fitContent();
      loadedMarket.current = key;
    } else if (atLiveEdge) {
      instance.timeScale().scrollToRealTime();
    } else if (previousRange !== null) {
      instance.timeScale().setVisibleRange(previousRange);
    }
  }, [coin, interval, revision]);

  // (c) Live candles mutate the existing series. Keep the newest received bar
  // so a delayed HTTP snapshot cannot regress it during reconciliation.
  useEffect(() => window.vex.hyperliquid.onCandleUpdate((event) => {
    if (event.coin !== coin || event.interval !== interval) return;
    const converted = candleBars([event.candle]);
    const candle = converted.candles[0];
    const volume = converted.volume[0];
    if (candle === undefined || volume === undefined) return;
    candleSeries.current?.update(candle);
    volumeSeries.current?.update(volume);
    liveCandle.current = { market: marketKey(coin, interval), candle: event.candle };
  }), [coin, interval]);

  // (d) Position overlays are independent from price/PnL updates. Retain line
  // handles and move a surviving line with applyOptions rather than recreating.
  useEffect(() => {
    const series = candleSeries.current;
    const token = tokens.current;
    if (series === null || token === null) return;
    const wanted = [
      ["entry", position?.entryPx ?? null, "ENTRY", token.entry, LineStyle.Solid],
      ["sl", position?.slPrice ?? null, "SL", token.sl, LineStyle.Dashed],
      ["tp", position?.tpPrice ?? null, "TP", token.long, LineStyle.Dashed],
      ["liq", position?.liquidationPx ?? null, "LIQ", token.liq, LineStyle.Dashed],
    ] as const;
    const desired = new Set<string>();
    for (const [id, value, title, color, lineStyle] of wanted) {
      if (value === null) continue;
      const price = renderNumber(value);
      if (price === null) continue;
      desired.add(id);
      const current = lines.current.get(id);
      if (current === undefined) {
        lines.current.set(id, {
          handle: series.createPriceLine({ price, title, color, lineWidth: 1, lineStyle, axisLabelVisible: true }),
          price,
        });
      } else if (current.price !== price) {
        current.handle.applyOptions({ price });
        lines.current.set(id, { ...current, price });
      }
    }
    for (const [id, current] of lines.current) {
      if (!desired.has(id)) {
        series.removePriceLine(current.handle);
        lines.current.delete(id);
      }
    }
  }, [overlayKey]);

  if (state === "loading") return <p className="mt-2 text-[10px] text-[var(--vex-text-3)]">Loading chart…</p>;
  if (state === "error") return <p className="mt-2 text-[10px] text-[var(--vex-warn-text)]">Chart unavailable.</p>;
  if (state === "empty") return <p className="mt-2 text-[10px] text-[var(--vex-text-3)]">No candle history yet.</p>;
  return <div ref={host} aria-label={`${coin} price chart`} className={fill ? "h-full min-h-[220px] w-full" : "mt-2 h-[180px] w-full"} />;
}
