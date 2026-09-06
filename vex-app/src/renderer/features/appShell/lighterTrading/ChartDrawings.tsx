import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type JSX, type RefObject } from "react";
import type { IChartApi, ISeriesApi, Logical, UTCTimestamp } from "lightweight-charts";
import { drawingHistory, logicalToTime, MAX_DRAWINGS, parseDrawings, timeToLogical, type Anchor, type Drawing, type DrawingKind } from "./chart-drawings.js";
const TOOLS: {
  kind: DrawingKind | "cursor";
  label: string;
  path: string;
}[] = [
    {
      kind: "cursor",
      label: "Cursor",
      path: "M5 3v14l4-4 3 6 3-2-3-5 6-1Z"
    },
    {
      kind: "horizontal",
      label: "Horizontal line",
      path: "M3 11h16M5 8v6"
    },
    {
      kind: "trend",
      label: "Trend line",
      path: "m4 17 14-12M3 16h3v3H3ZM17 3h3v3h-3Z"
    },
    {
      kind: "rectangle",
      label: "Rectangle",
      path: "M4 5h14v12H4Z"
    },
    {
      kind: "fib",
      label: "Fibonacci retracement",
      path: "M3 4h16M3 9h16M3 12h16M3 17h16M5 19 17 2"
    },
    {
      kind: "measure",
      label: "Measure price and time",
      path: "m4 16 12-12 4 4L8 20ZM9 11l3 3M13 7l3 3"
    },
  ];
interface Props {
  chart: IChartApi;
  series: ISeriesApi<"Candlestick">;
  host: RefObject<HTMLDivElement | null>;
  times: readonly number[];
  scope: string;
  precision: number;
  minMove?: number;
}
export function ChartDrawings({ chart, series, host, times, scope, precision, minMove = 10 ** -precision }: Props): JSX.Element {
  const storageKey = `vex:chart-drawings:v1:${scope}`;
  const [history, dispatch] = useReducer(drawingHistory, undefined, () => {
    let present: Drawing[] = [];
    try {
      present = parseDrawings(localStorage.getItem(storageKey));
    } catch { /* Storage may be disabled. Drawing remains available in memory. */ }
    return {
      past: [],
      present,
      future: []
    };
  });
  const [mode, setMode] = useState<DrawingKind | "cursor">("cursor");
  const [start, setStart] = useState<Anchor | null>(null);
  const [preview, setPreview] = useState<Anchor | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<"a" | "b" | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const [, redraw] = useReducer(v => v + 1, 0);
  const frame = useRef<number | null>(null);
  const requestDraw = useCallback(() => {
    if (frame.current === null)
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        redraw();
      });
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(history.present));
      setStorageFailed(false);
    } catch {
      setStorageFailed(true);
    }
  }, [history.present, storageKey]);
  useLayoutEffect(() => {
    const scale = chart.timeScale();
    scale.subscribeVisibleLogicalRangeChange?.(requestDraw);
    chart.subscribeCrosshairMove(requestDraw);
    const el = host.current;
    el?.addEventListener("wheel", requestDraw, { passive: true });
    el?.addEventListener("pointermove", requestDraw);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(requestDraw);
    if (el)
      observer?.observe(el);
    return () => {
      scale.unsubscribeVisibleLogicalRangeChange?.(requestDraw);
      chart.unsubscribeCrosshairMove(requestDraw);
      el?.removeEventListener("wheel", requestDraw);
      el?.removeEventListener("pointermove", requestDraw);
      observer?.disconnect();
      if (frame.current !== null)
        cancelAnimationFrame(frame.current);
    };
  }, [chart, host, requestDraw]);
  const commit = (drawings: Drawing[]): void => dispatch({ type: "set", drawings });
  const cancel = (): void => {
    setMode("cursor");
    setStart(null);
    setPreview(null);
    setEditing(null);
  };
  useEffect(() => {
    if (mode === "cursor" && editing === null)
      return;
    const escapeDrawing = (event: KeyboardEvent): void => {
      if (event.key !== "Escape")
        return;
      event.preventDefault();
      event.stopPropagation();
      setMode("cursor");
      setStart(null);
      setPreview(null);
      setEditing(null);
    };
    document.addEventListener("keydown", escapeDrawing, true);
    return () => document.removeEventListener("keydown", escapeDrawing, true);
  }, [mode, editing]);
  const selectedDrawing = history.present.find(d => d.id === selected);
  const chooseTool = (kind: DrawingKind | "cursor"): void => {
    cancel();
    setMode(kind);
    setSelected(null);
  };
  const logicalOrigin = (): number => {
    const first = times[0];
    if (first === undefined)
      return 0;
    const scale = chart.timeScale();
    const coordinate = scale.timeToCoordinate?.(first as UTCTimestamp);
    return coordinate === null || coordinate === undefined ? 0 : Number(scale.coordinateToLogical(coordinate) ?? 0);
  };
  const anchorAt = (event: React.PointerEvent<SVGSVGElement>): Anchor | null => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const pane = chart.paneSize(0);
    if (x < 0 || x > pane.width || y < 0 || y > pane.height)
      return null;
    const logical = chart.timeScale().coordinateToLogical(x);
    const price = series.coordinateToPrice(y);
    const time = logical === null ? null : logicalToTime(Number(logical) - logicalOrigin(), times);
    return time === null || price === null || !Number.isFinite(time) || time < 0 || time > 32503680000 || !Number.isFinite(price) || Math.abs(price) > 1e15 ? null : { time, price: Number((Math.round(Number(price) / minMove) * minMove).toFixed(precision)) };
  };
  const applyAnchor = (anchor: Anchor): void => {
    if (editing && selectedDrawing) {
      commit(history.present.map(d => d.id === selectedDrawing.id ? { ...d, [editing]: anchor } : d));
      cancel();
      return;
    }
    if (mode === "cursor")
      return;
    if (history.present.length >= MAX_DRAWINGS)
      return;
    if (!start && mode !== "horizontal") {
      setStart(anchor);
      setPreview(anchor);
      return;
    }
    const drawing: Drawing = {
      id: crypto.randomUUID(),
      kind: mode,
      a: start ?? anchor,
      b: anchor
    };
    commit([...history.present, drawing]);
    setSelected(drawing.id);
    cancel();
  };
  const project = (anchor: Anchor): {
    x: number;
    y: number;
  } | null => {
    const logical = timeToLogical(anchor.time, times);
    if (logical === null)
      return null;
    const x = chart.timeScale().logicalToCoordinate((logical + logicalOrigin()) as Logical);
    const y = series.priceToCoordinate(anchor.price);
    return x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y) ? null : { x: Number(x), y: Number(y) };
  };
  const drawings = start && preview && mode !== "cursor" ? [...history.present, {
    id: "preview",
    kind: mode,
    a: start,
    b: preview
  }] : history.present;
  const pane = chart.paneSize?.(0);
  return <>
    <div
      className="lit-drawing-rail"
      role="toolbar"
      aria-label="Drawing tools"
    >
      {TOOLS.map(tool => <button
        key={tool.kind}
        type="button"
        aria-label={tool.label}
        title={tool.label}
        aria-pressed={mode === tool.kind}
        onClick={() => chooseTool(tool.kind)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d={tool.path} />
        </svg>
      </button>)}
      <span className="lit-drawing-divider" />
      <button
        type="button"
        aria-label="Undo drawing change"
        title="Undo drawing change"
        disabled={!history.past.length}
        onClick={() => {
          dispatch({ type: "undo" });
          cancel();
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m8 5-4 4 4 4M4 9h9a6 6 0 0 1 0 12" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Redo drawing change"
        title="Redo drawing change"
        disabled={!history.future.length}
        onClick={() => {
          dispatch({ type: "redo" });
          cancel();
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m16 5 4 4-4 4m4-4h-9a6 6 0 0 0 0 12" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Delete selected drawing"
        title="Delete selected drawing"
        disabled={!selectedDrawing}
        onClick={() => {
          commit(history.present.filter(d => d.id !== selected));
          setSelected(null);
          cancel();
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
        </svg>
      </button>
    </div>
    <svg
      className="lit-drawing-layer"
      style={{ pointerEvents: mode !== "cursor" || editing ? "auto" : "none" }}
      aria-label="Chart drawings"
      onPointerDown={event => {
        if (mode === "cursor" && !editing)
          return;
        event.preventDefault();
        const anchor = anchorAt(event);
        if (anchor)
          applyAnchor(anchor);
      }}
      onPointerMove={event => {
        if (start)
          setPreview(anchorAt(event));
      }}
    >
      <defs>
        <clipPath id={`lit-draw-${scope.replace(/[^a-zA-Z0-9]/g, "-")}`}>
          <rect width={pane?.width ?? 0} height={pane?.height ?? 0} />
        </clipPath>
      </defs>
      <g clipPath={`url(#lit-draw-${scope.replace(/[^a-zA-Z0-9]/g, "-")})`}>
        {drawings.map(drawing => {
          const a = project(drawing.a);
          const b = project(drawing.b);
          if (!a || !b)
            return null;
          const x = Math.min(a.x, b.x);
          const y = Math.min(a.y, b.y);
          const width = Math.abs(a.x - b.x);
          const height = Math.abs(a.y - b.y);
          const selectedNow = drawing.id === selected;
          const line = drawing.kind === "horizontal" ? <line
            x1={0}
            y1={a.y}
            x2={pane?.width ?? 0}
            y2={a.y}
          /> : <line
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
          />;
          return <g
            key={drawing.id}
            className="lit-drawing-shape"
            data-selected={selectedNow}
            tabIndex={drawing.id === "preview" ? -1 : 0}
            role="button"
            aria-label={`${drawing.kind} drawing at ${drawing.a.price.toFixed(precision)}`}
            style={{ pointerEvents: mode === "cursor" && !editing ? "visibleStroke" : "none" }}
            onPointerDown={event => {
              if (mode !== "cursor" || editing)
                return;
              event.stopPropagation();
              setSelected(drawing.id);
            }}
            onFocus={() => setSelected(drawing.id)}
            onKeyDown={event => {
              if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                commit(history.present.filter(d => d.id !== drawing.id));
                setSelected(null);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancel();
                setSelected(null);
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setSelected(drawing.id);
              }
            }}
          >
            <g className="lit-drawing-hit" aria-hidden="true">
              {drawing.kind === "rectangle" || drawing.kind === "measure" ? <rect
                x={x}
                y={y}
                width={width}
                height={height}
              /> : drawing.kind === "fib" ? [0, .236, .382, .5, .618, .786, 1].map(ratio => <line
                key={ratio}
                x1={x}
                x2={x + width}
                y1={a.y + (b.y - a.y) * ratio}
                y2={a.y + (b.y - a.y) * ratio}
              />) : line}
            </g>
            {drawing.kind === "rectangle" || drawing.kind === "measure" ? <rect
              x={x}
              y={y}
              width={width}
              height={height}
            /> : drawing.kind === "fib" ? [0, .236, .382, .5, .618, .786, 1].map(ratio => <g key={ratio}>
              <line
                x1={x}
                x2={x + width}
                y1={a.y + (b.y - a.y) * ratio}
                y2={a.y + (b.y - a.y) * ratio}
              />
              <text x={x + 4} y={a.y + (b.y - a.y) * ratio - 4}>{ratio.toFixed(3)} · {(drawing.a.price + (drawing.b.price - drawing.a.price) * ratio).toFixed(precision)}</text>
            </g>) : line}
            {drawing.kind === "measure" ? <text x={x + 5} y={Math.max(14, y - 7)}>{(drawing.b.price - drawing.a.price).toFixed(precision)} ({drawing.a.price === 0 ? "—" : `${((drawing.b.price / drawing.a.price - 1) * 100).toFixed(2)}%`}) · {Math.round(Math.abs(drawing.b.time - drawing.a.time) / 60)} min</text> : null}
            {drawing.kind === "horizontal" ? <text x={8} y={a.y - 5}>
              {drawing.a.price.toFixed(precision)}
            </text> : null}
            {selectedNow ? <>
              <circle
                cx={a.x}
                cy={a.y}
                r={4}
              />
              {drawing.kind !== "horizontal" ? <circle
                cx={b.x}
                cy={b.y}
                r={4}
              /> : null}
            </> : null}
          </g>;
        })}
      </g>
    </svg>
    {selectedDrawing && mode === "cursor" && !editing ? <div
      className="lit-drawing-editor"
      aria-label="Edit selected drawing"
      onKeyDown={event => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
          setSelected(null);
        }
      }}
    >
      <span>
        {TOOLS.find(t => t.kind === selectedDrawing.kind)?.label}
      </span>
      <label>Start price<input
        type="number"
        step={minMove}
        value={selectedDrawing.a.price}
        onChange={event => {
          const price = event.target.valueAsNumber;
          if (Number.isFinite(price) && Math.abs(price) <= 1e15)
            commit(history.present.map(d => d.id === selected ? { ...d, a: { ...d.a, price } } : d));
        }}
      /></label>
      {selectedDrawing.kind !== "horizontal" ? <label>End price<input
        type="number"
        step={minMove}
        value={selectedDrawing.b.price}
        onChange={event => {
          const price = event.target.valueAsNumber;
          if (Number.isFinite(price) && Math.abs(price) <= 1e15)
            commit(history.present.map(d => d.id === selected ? { ...d, b: { ...d.b, price } } : d));
        }}
      /></label> : null}
      <button type="button" onClick={() => setEditing("a")}>Move start</button>
      {selectedDrawing.kind !== "horizontal" ? <button type="button" onClick={() => setEditing("b")}>Move end</button> : null}
      <button type="button" onClick={() => setSelected(null)}>Done</button>
    </div> : null}
    {mode !== "cursor" || editing ? <div className="lit-drawing-hint" role="status">
      {editing ? `Click a new ${editing === "a" ? "start" : "end"} point.` : history.present.length >= MAX_DRAWINGS ? "Drawing limit reached. Delete a drawing to continue." : start ? "Click the end point." : mode === "horizontal" ? "Click a price level." : "Click the start point."}
      <button type="button" onClick={cancel}>Cancel</button>
    </div> : null}
    {storageFailed ? <span className="lit-drawing-save-warning" role="status">Drawings cannot be saved on this device.</span> : null}
  </>;
}
