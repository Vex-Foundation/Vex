/**
 * The plates' chart: the sample candles drawn as one SVG at the canvas's own
 * pixel size, so every rule lands on a whole pixel. It stands in for the
 * desk's TradingView canvas (`MarketChart.tsx`) and draws only what that
 * canvas draws in H3's grammar: the grid on the 1px rule, the price scale in
 * mono, candles and volume in the gain and loss colours (trading values),
 * the last price as an ink tag, and the open position's entry as a dashed
 * line with its tag. No order, no fill and no figure here is real.
 */

import { useEffect, useRef, useState, type JSX, type RefObject } from "react";
import { PLATE_MARKET, plateCandles, type PlateCandle } from "./sample.js";

const AXIS_W = 76;
const TIME_H = 24;
const TOP_PAD = 40;
const STEP = 9;
const BODY = 5;

function useBoxSize(ref: RefObject<HTMLElement | null>): { readonly width: number; readonly height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function formatPrice(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Five-minute candle times ending on the harness instant (14:30 UTC). */
function timeLabel(indexFromEnd: number): string {
  const minutes = 14 * 60 + 30 - indexFromEnd * 5;
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

interface ChartLayout {
  readonly candles: readonly PlateCandle[];
  readonly plotW: number;
  readonly priceTop: number;
  readonly priceBottom: number;
  readonly volumeTop: number;
  readonly volumeBottom: number;
  readonly min: number;
  readonly max: number;
  readonly maxVolume: number;
}

function layoutOf(width: number, height: number, all: readonly PlateCandle[]): ChartLayout {
  const plotW = width - AXIS_W;
  const count = Math.max(10, Math.floor((plotW - 12) / STEP));
  const candles = all.slice(-count);
  const plotH = height - TIME_H;
  const volumeH = Math.round(plotH * 0.16);
  const priceTop = TOP_PAD;
  const priceBottom = plotH - volumeH - 10;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let maxVolume = 0;
  for (const candle of candles) {
    min = Math.min(min, candle.low);
    max = Math.max(max, candle.high);
    maxVolume = Math.max(maxVolume, candle.volume);
  }
  const pad = (max - min) * 0.08;
  return {
    candles,
    plotW,
    priceTop,
    priceBottom,
    volumeTop: plotH - volumeH,
    volumeBottom: plotH,
    min: min - pad,
    max: max + pad,
    maxVolume,
  };
}

export function PlateChart({ entry, resolution = "5m" }: {
  /** The open position's entry, drawn as a dashed line; null draws none. */
  readonly entry: number | null;
  readonly resolution?: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const { width, height } = useBoxSize(ref);
  const [all] = useState(() => plateCandles(240));
  const ready = width > AXIS_W + 40 && height > TIME_H + TOP_PAD + 40;
  const layout = ready ? layoutOf(width, height, all) : null;
  const last = all[all.length - 1];
  return (
    <div className="lp-chart__canvas" ref={ref}>
      {layout === null ? null : <ChartSvg layout={layout} width={width} height={height} entry={entry} />}
      <div className="lp-chart__legend lp-num">
        <span>
          <b>{PLATE_MARKET.ticker} {PLATE_MARKET.product}</b> · {resolution} · {PLATE_MARKET.deployment}
        </span>
        {last === undefined ? null : (
          <span>
            O <b>{formatPrice(last.open)}</b> H <b>{formatPrice(last.high)}</b> L <b>{formatPrice(last.low)}</b> C{" "}
            <b>{formatPrice(last.close)}</b>
          </span>
        )}
      </div>
    </div>
  );
}

function ChartSvg({ layout, width, height, entry }: {
  readonly layout: ChartLayout;
  readonly width: number;
  readonly height: number;
  readonly entry: number | null;
}): JSX.Element {
  const { candles, plotW, priceTop, priceBottom, volumeTop, volumeBottom, min, max, maxVolume } = layout;
  const y = (price: number): number =>
    Math.round(priceTop + ((max - price) / (max - min)) * (priceBottom - priceTop)) + 0.5;
  const firstX = plotW - 12 - (candles.length - 1) * STEP;
  const x = (i: number): number => Math.round(firstX + i * STEP) + 0.5;
  const ticks: number[] = [];
  const span = max - min;
  // The scale's step: the first round step whose rows stand 40 px apart.
  const perPrice = (priceBottom - priceTop) / span;
  const stepPrice = [10, 20, 25, 50, 100, 200, 250, 500].find((step) => step * perPrice >= 40) ?? 1000;
  for (let p = Math.ceil(min / stepPrice) * stepPrice; p < max; p += stepPrice) ticks.push(p);
  const timeEvery = 12;
  const lastClose = candles[candles.length - 1]?.close ?? 0;
  const lastY = y(lastClose);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${String(width)} ${String(height)}`} aria-hidden="true">
      {/* the grid, on the rule */}
      <g stroke="var(--lp-rule)" strokeWidth="1">
        {ticks.map((p) => (
          <line key={p} x1="0" x2={plotW} y1={y(p)} y2={y(p)} />
        ))}
        {candles.map((_, i) =>
          (candles.length - 1 - i) % timeEvery === 0 ? <line key={i} x1={x(i)} x2={x(i)} y1="0" y2={volumeBottom} /> : null,
        )}
        <line x1={plotW + 0.5} x2={plotW + 0.5} y1="0" y2={height} />
        <line x1="0" x2={width} y1={volumeBottom + 0.5} y2={volumeBottom + 0.5} />
      </g>
      {/* volume, under the candles */}
      {candles.map((candle, i) => {
        const up = candle.close >= candle.open;
        const h = Math.max(1, Math.round((candle.volume / maxVolume) * (volumeBottom - volumeTop)));
        return (
          <rect
            key={`v${String(i)}`}
            x={x(i) - 0.5 - Math.floor(BODY / 2)}
            y={volumeBottom - h}
            width={BODY}
            height={h}
            fill={up ? "var(--lp-gain)" : "var(--lp-loss)"}
            opacity="0.32"
          />
        );
      })}
      {/* candles */}
      {candles.map((candle, i) => {
        const up = candle.close >= candle.open;
        const colour = up ? "var(--lp-gain)" : "var(--lp-loss)";
        const top = y(Math.max(candle.open, candle.close));
        const bottom = y(Math.min(candle.open, candle.close));
        return (
          <g key={`c${String(i)}`}>
            <line x1={x(i)} x2={x(i)} y1={y(candle.high)} y2={y(candle.low)} stroke={colour} strokeWidth="1" />
            <rect
              x={x(i) - 0.5 - Math.floor(BODY / 2)}
              y={top - 0.5}
              width={BODY}
              height={Math.max(1, bottom - top)}
              fill={colour}
            />
          </g>
        );
      })}
      {/* the price scale */}
      <g fill="var(--lp-muted)" fontFamily="var(--font-mono)" fontSize="11">
        {ticks.map((p) => (
          <text key={p} x={plotW + 10} y={y(p) + 4}>
            {formatPrice(p)}
          </text>
        ))}
      </g>
      {/* the time scale */}
      <g fill="var(--lp-muted)" fontFamily="var(--font-mono)" fontSize="11" textAnchor="middle">
        {candles.map((_, i) => {
          const fromEnd = candles.length - 1 - i;
          return fromEnd % timeEvery === 0 && x(i) > 24 ? (
            <text key={i} x={x(i)} y={height - 8}>
              {timeLabel(fromEnd)}
            </text>
          ) : null;
        })}
      </g>
      {/* the position's entry: a dashed ink-2 line and its tag on the scale */}
      {entry === null || entry < min || entry > max ? null : (
        <g>
          <line x1="0" x2={plotW} y1={y(entry)} y2={y(entry)} stroke="var(--lp-ink-2)" strokeDasharray="4 4" />
          <rect x="12" y={y(entry) - 10.5} width="58" height="20" fill="var(--lp-ground)" stroke="var(--lp-rule-chosen)" />
          <text x="41" y={y(entry) + 4} fill="var(--lp-ink-2)" fontSize="10" letterSpacing="0.08em" textAnchor="middle">
            ENTRY
          </text>
          <rect x={plotW + 1} y={y(entry) - 10.5} width={AXIS_W - 1} height="20" fill="var(--lp-ground)" stroke="var(--lp-rule-chosen)" />
          <text x={plotW + 10} y={y(entry) + 4} fill="var(--lp-ink-2)" fontFamily="var(--font-mono)" fontSize="11">
            {formatPrice(entry)}
          </text>
        </g>
      )}
      {/* the last price: a dotted line and the ink tag on the scale */}
      <line x1="0" x2={plotW} y1={lastY} y2={lastY} stroke="var(--lp-ink)" strokeOpacity="0.45" strokeDasharray="1 3" />
      <rect x={plotW + 1} y={lastY - 10.5} width={AXIS_W - 1} height="21" fill="var(--lp-ink)" />
      <text x={plotW + 10} y={lastY + 4} fill="var(--lp-on-ink)" fontFamily="var(--font-mono)" fontSize="11">
        {formatPrice(lastClose)}
      </text>
    </svg>
  );
}
