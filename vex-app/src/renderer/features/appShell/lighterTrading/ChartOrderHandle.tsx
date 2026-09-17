import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import type { DrawingChartApi, DrawingSeriesApi } from "./chart-analysis-api.js";

export type ChartOrderSide = "buy" | "sell";

export interface ChartOrderHandleProps {
  readonly chart: DrawingChartApi;
  readonly series: DrawingSeriesApi;
  /** The chart canvas; the overlay shares its top-left, so pane coordinates map directly. */
  readonly host: RefObject<HTMLDivElement | null>;
  readonly lastPrice: number;
  readonly precision: number;
  readonly minMove?: number;
  /**
   * The drop lands as a limit price in the ticket: below the last price buys,
   * above it sells. The order still goes out through the ticket and its
   * approval card; the chart never places anything itself.
   */
  readonly onDragOrder: (price: string, side: ChartOrderSide) => void;
}

/** Pixels the pointer must travel before a press counts as a drag. */
const DRAG_THRESHOLD = 3;
/** Width of the grab pill, so it sits clear of the price axis. */
const HANDLE_WIDTH = 28;

interface Drag {
  readonly startY: number;
  readonly y: number;
  readonly price: number;
  readonly moved: boolean;
}

/**
 * A grab pill on the last price that drags a limit level onto the chart.
 * Arrow keys nudge it one tick (ten with Shift), Enter places, Escape cancels.
 */
export function ChartOrderHandle({
  chart,
  series,
  host,
  lastPrice,
  precision,
  minMove = 10 ** -precision,
  onDragOrder,
}: ChartOrderHandleProps): JSX.Element | null {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragging = drag !== null;
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [, redraw] = useReducer((v: number) => v + 1, 0);
  const frame = useRef<number | null>(null);
  const requestDraw = useCallback(() => {
    if (frame.current === null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        redraw();
      });
    }
  }, []);

  // The pill follows the last price across scrolls, zooms and autoscale; the
  // frame waits for the chart's own data effect so the scale is current.
  useLayoutEffect(() => {
    const scale = chart.timeScale();
    scale.subscribeVisibleLogicalRangeChange(requestDraw);
    chart.subscribeCrosshairMove(requestDraw);
    const el = host.current;
    el?.addEventListener("wheel", requestDraw, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(requestDraw);
    if (el) observer?.observe(el);
    return () => {
      scale.unsubscribeVisibleLogicalRangeChange(requestDraw);
      chart.unsubscribeCrosshairMove(requestDraw);
      el?.removeEventListener("wheel", requestDraw);
      observer?.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [chart, host, requestDraw]);
  useEffect(() => {
    requestDraw();
  }, [lastPrice, requestDraw]);

  useEffect(() => {
    if (!dragging) return undefined;
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setDrag(null);
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [dragging]);

  const snap = (price: number): number => Number((Math.round(price / minMove) * minMove).toFixed(precision));
  const priceAt = (y: number): number | null => {
    const pane = chart.paneSize(0);
    const clamped = Math.min(Math.max(y, 0), pane.height);
    const price = series.coordinateToPrice(clamped);
    return price === null || !Number.isFinite(price) || price <= 0 ? null : snap(Number(price));
  };
  const place = (price: number): void => {
    setDrag(null);
    if (price <= 0 || price === snap(lastPrice)) return;
    onDragOrder(price.toFixed(precision), price < lastPrice ? "buy" : "sell");
  };

  const layerY = (event: PointerEvent<HTMLButtonElement>): number =>
    event.clientY - (layerRef.current?.getBoundingClientRect().top ?? 0);
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const y = layerY(event);
    setDrag({ startY: y, y, price: snap(lastPrice), moved: false });
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    if (drag === null) return;
    const y = layerY(event);
    const moved = drag.moved || Math.abs(y - drag.startY) >= DRAG_THRESHOLD;
    const price = moved ? priceAt(y) : drag.price;
    setDrag({ startY: drag.startY, y, price: price ?? drag.price, moved });
  };
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>): void => {
    if (drag === null) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag.moved) place(drag.price);
    else setDrag(null);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const current = drag?.price ?? snap(lastPrice);
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const step = minMove * (event.shiftKey ? 10 : 1) * (event.key === "ArrowUp" ? 1 : -1);
      const price = snap(current + step);
      if (price <= 0) return;
      const y = series.priceToCoordinate(price);
      setDrag({ startY: 0, y: y === null ? 0 : Number(y), price, moved: true });
      return;
    }
    if (event.key === "Enter" && drag !== null) {
      event.preventDefault();
      place(drag.price);
    }
  };

  const pane = chart.paneSize(0);
  const restY = series.priceToCoordinate(lastPrice);
  if (restY === null || !Number.isFinite(restY)) return null;
  const y = drag === null ? Number(restY) : drag.y;
  const side: ChartOrderSide = drag === null || drag.price >= lastPrice ? "sell" : "buy";
  const label = drag === null ? null : `${side === "buy" ? "Buy" : "Sell"} limit ${drag.price.toFixed(precision)}`;
  return (
    <div className="lit-order-layer" ref={layerRef} data-dragging={dragging || undefined}>
      {drag !== null && drag.moved ? (
        <div
          className="lit-order-ghost"
          data-side={side}
          style={{ top: y, width: pane.width }}
          role="status"
          aria-live="polite"
        >
          <span>{label}</span>
        </div>
      ) : null}
      <button
        type="button"
        className="lit-order-handle"
        aria-label="Drag to place a limit order"
        title="Drag to a price · arrows nudge, Enter places"
        style={{ top: y, left: Math.max(0, pane.width - HANDLE_WIDTH - 4) }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setDrag(null)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 3v14M6 7l4-4 4 4M6 13l4 4 4-4" />
        </svg>
      </button>
    </div>
  );
}
